/**
 * The `cleanup` job on the worker plane (migration 0071). LIVE DB, real logins.
 *
 * The cleanup handler used to run raw DELETE / UPDATE on public.jobs through app_user — the
 * web application's role — which could only ever work by widening that role. Now the work
 * runs in public.jobs_run_cleanup(job, worker), executable by app_worker alone, bound to a
 * `cleanup` job the calling worker holds, with the organization and every parameter read
 * from that job row. Under test, on the real roles (DATABASE_URL_TEST = app_user,
 * DATABASE_URL_WORKER = app_worker):
 *
 *   - app_user cannot call it — with no identity, as the system actor, or carrying a
 *     complete forged worker context — and cannot do the work itself either;
 *   - app_worker is refused unless it holds a running `cleanup` job under its own id;
 *   - the payload is validated in the database (target, retention, dry run, lease floor);
 *   - stale_jobs deletes exactly the organization's old terminal jobs (never failed /
 *     dead_letter / live ones, never a job with webhook delivery evidence, never another
 *     organization's); expired_leases resets exactly the organization's expired leases
 *     (never a fresh one, never the cleanup job itself, never another organization's);
 *   - dry runs count the same rows and change nothing;
 *   - the real handler drives it end to end on the worker connection.
 *
 * Isolation: every case builds its own organizations. Fixture jobs are never due (next_run_at
 * a month out), "old" terminal jobs are 10 days old (platform retention removes 90+), and
 * expired leases carry no heartbeat (the global reaper matches heartbeat_at only), so no
 * other suite's claim, sweep, reaper or retention run can touch them mid-case.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from '@neondatabase/serverless';

import { DB_READY, mkOrg, RUN } from '../workflows/helpers';
import { SYSTEM_ACTOR, WORKER_DB_READY } from '../worker-role';
import type { Job } from '@/lib/jobs/types';

const READY = DB_READY && WORKER_DB_READY;

describe.skipIf(!READY)('the cleanup job runs on the worker plane (0071, live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  const appUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
  const appWorker = new Pool({ connectionString: process.env.DATABASE_URL_WORKER });

  afterAll(async () => {
    await owner.end();
    await appUser.end();
    await appWorker.end();
  });

  let seq = 0;
  const newOrg = async () => mkOrg(owner, `cln-${RUN}-${(seq += 1)}`);

  interface JobRow {
    id: string;
    status: string;
    attempts: number;
    claimed_by: string | null;
    error_code: string | null;
  }

  /** Insert a job exactly as given; never due, so no claim in any suite picks it up. */
  const mkJob = async (
    org: string,
    o: {
      type?: string;
      status: string;
      payload?: unknown;
      ageDays?: number;
      claimedBy?: string | null;
      claimedAgoSec?: number | null;
      heartbeatFuture?: boolean;
    },
  ): Promise<string> =>
    (
      await owner.query<{ id: string }>(
        `insert into public.jobs
           (org_id, type, status, payload, next_run_at, created_at, claimed_by, claimed_at, heartbeat_at)
         values ($1, $2, $3, $4::jsonb, now() + interval '30 days',
                 now() - make_interval(days => $5::int),
                 $6, now() - make_interval(secs => $7::int),
                 case when $8 then now() + interval '30 days' end)
         returning id`,
        [
          org,
          o.type ?? 'notification',
          o.status,
          JSON.stringify(o.payload ?? {}),
          o.ageDays ?? 0,
          o.claimedBy ?? null,
          o.claimedAgoSec ?? 0,
          o.heartbeatFuture ?? false,
        ],
      )
    ).rows[0]!.id;

  /** A `cleanup` job held (running) under `workerId`. */
  const holdCleanup = (
    org: string,
    workerId: string,
    payload: unknown,
    claimedAgoSec = 0,
    heartbeatFuture = true,
  ) =>
    mkJob(org, {
      type: 'cleanup',
      status: 'running',
      payload,
      claimedBy: workerId,
      claimedAgoSec,
      heartbeatFuture,
    });

  const rowsOf = async (ids: string[]) =>
    (
      await owner.query<JobRow>(
        `select id, status, attempts, claimed_by, error_code
           from public.jobs where id = any($1::uuid[])`,
        [ids],
      )
    ).rows;
  const statusOf = async (id: string) => (await rowsOf([id]))[0]?.status ?? 'DELETED';

  const runCleanup = async (pool: Pool, jobId: string, workerId: string | null) =>
    (
      await pool.query<{ target: string; dry_run: boolean; affected: number }>(
        `select target, dry_run, affected from public.jobs_run_cleanup($1::uuid, $2)`,
        [jobId, workerId],
      )
    ).rows[0]!;

  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ALLOWED';
    } catch (e) {
      return (e as { code?: string }).code ?? 'ERROR';
    }
  };

  /** Run on one connection carrying a (possibly forged) context, always rolled back. */
  async function rolledBack(
    pool: Pool,
    ctx: { personId?: string; orgId?: string },
    sql: string,
    params: unknown[] = [],
    extra: Record<string, string> = {},
  ): Promise<number> {
    const c: PoolClient = await pool.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
        [ctx.personId ?? '', ctx.orgId ?? ''],
      );
      for (const [name, value] of Object.entries(extra)) {
        await c.query(`select set_config($1, $2, true)`, [name, value]);
      }
      return (await c.query(sql, params)).rowCount ?? 0;
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  }

  // ── The grant ─────────────────────────────────────────────────────────
  it('only app_worker may execute jobs_run_cleanup (not app_user, app_admin or PUBLIC)', async () => {
    const r = (
      await owner.query<{
        user_x: boolean;
        admin_x: boolean;
        worker_x: boolean;
        public_x: boolean;
      }>(
        `select has_function_privilege('app_user', p.oid, 'execute') user_x,
                has_function_privilege('app_admin', p.oid, 'execute') admin_x,
                has_function_privilege('app_worker', p.oid, 'execute') worker_x,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where a.grantee = 0 and a.privilege_type = 'EXECUTE') public_x
           from pg_proc p where p.oid = 'public.jobs_run_cleanup(uuid,text)'::regprocedure`,
      )
    ).rows[0]!;
    expect(r).toEqual({ user_x: false, admin_x: false, worker_x: true, public_x: false });
  });

  // ── app_user: no way in ───────────────────────────────────────────────
  it('app_user cannot call it — with no identity, as the system actor, or with a complete forged worker context', async () => {
    const org = await newOrg();
    const workerId = `cln-forge-${RUN}`;
    const held = await holdCleanup(org, workerId, { target: 'stale_jobs', olderThanDays: 5 });
    const victim = await mkJob(org, { status: 'succeeded', ageDays: 10 });
    const sql = `select * from public.jobs_run_cleanup($1::uuid, $2)`;
    const forged = { personId: SYSTEM_ACTOR, orgId: org };
    const holding = { 'app.work_kind': 'job', 'app.work_id': held, 'app.worker_id': workerId };

    expect(await codeOf(rolledBack(appUser, {}, sql, [held, workerId]))).toBe('42501');
    expect(await codeOf(rolledBack(appUser, forged, sql, [held, workerId]))).toBe('42501');
    expect(await codeOf(rolledBack(appUser, forged, sql, [held, workerId], holding))).toBe('42501');
    expect(await statusOf(victim)).toBe('succeeded');
  });

  it('app_user cannot do the cleanup work itself: no DELETE on jobs, and the forged system actor resets nothing', async () => {
    const org = await newOrg();
    const old = await mkJob(org, { status: 'succeeded', ageDays: 10 });
    const lease = await mkJob(org, {
      status: 'running',
      claimedBy: `cln-other-${RUN}`,
      claimedAgoSec: 3600,
    });
    const forged = { personId: SYSTEM_ACTOR, orgId: org };

    // The purge: no DELETE privilege on public.jobs at all.
    expect(
      await codeOf(
        rolledBack(appUser, forged, `delete from public.jobs where id = $1::uuid`, [old]),
      ),
    ).toBe('42501');
    // The lease reset the old handler ran: the jobs policies admit only a live person
    // holding jobs.retry / jobs.cancel, so the forged actor matches no row.
    const reset = await rolledBack(
      appUser,
      forged,
      `update public.jobs set status = 'pending', claimed_by = null, claimed_at = null
        where id = $1::uuid`,
      [lease],
      { 'app.work_kind': 'job', 'app.work_id': lease, 'app.worker_id': `cln-other-${RUN}` },
    );
    expect(reset).toBe(0);
    expect(await rowsOf([old, lease])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: old, status: 'succeeded' }),
        expect.objectContaining({ id: lease, status: 'running' }),
      ]),
    );
  });

  // ── app_worker: only the job it holds ─────────────────────────────────
  it('app_worker is refused unless it holds a running cleanup job under its own id', async () => {
    const org = await newOrg();
    const workerId = `cln-bind-${RUN}`;
    const payload = { target: 'stale_jobs', olderThanDays: 5 };
    const victim = await mkJob(org, { status: 'succeeded', ageDays: 10 });
    const held = await holdCleanup(org, workerId, payload);
    const pending = await mkJob(org, { type: 'cleanup', status: 'pending', payload });
    const emailHeld = await mkJob(org, {
      type: 'email',
      status: 'running',
      payload,
      claimedBy: workerId,
      heartbeatFuture: true,
    });

    const call = (jobId: string, w: string | null) => codeOf(runCleanup(appWorker, jobId, w));
    expect(await call('00000000-0000-4000-8000-0000000000c1', workerId)).toBe('22023'); // no such job
    expect(await call(emailHeld, workerId)).toBe('22023'); // not a cleanup job
    expect(await call(pending, workerId)).toBe('22023'); // not running: held by nobody
    expect(await call(held, `cln-thief-${RUN}`)).toBe('42501'); // another worker's claim
    expect(await call(held, null)).toBe('42501');
    // Each refusal changed nothing.
    expect(await statusOf(victim)).toBe('succeeded');
  });

  it('validates the held job’s payload in the database: target, retention, dry run and the 60 s lease floor', async () => {
    const org = await newOrg();
    const victim = await mkJob(org, { status: 'succeeded', ageDays: 10 });
    const lease = await mkJob(org, {
      status: 'running',
      claimedBy: `cln-other-${RUN}`,
      claimedAgoSec: 3600,
    });
    const bad: unknown[] = [
      { target: 'everything' },
      { olderThanDays: 5 },
      { target: 'stale_jobs', olderThanDays: 0 },
      { target: 'stale_jobs', olderThanDays: 3651 },
      { target: 'stale_jobs', olderThanDays: 1.5 },
      { target: 'stale_jobs', olderThanDays: '5' },
      { target: 'stale_jobs', dryRun: 'yes' },
      { target: 'expired_leases', params: 'staleThresholdMs' },
      { target: 'expired_leases', params: { staleThresholdMs: 1000 } },
      { target: 'expired_leases', params: { staleThresholdMs: 59_999 } },
      { target: 'expired_leases', params: { staleThresholdMs: '600000' } },
      ['stale_jobs'],
    ];
    for (const [i, payload] of bad.entries()) {
      const workerId = `cln-val-${RUN}-${i}`;
      const held = await holdCleanup(org, workerId, payload);
      expect(await codeOf(runCleanup(appWorker, held, workerId)), JSON.stringify(payload)).toBe(
        '22023',
      );
    }
    expect(await rowsOf([victim, lease])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: victim, status: 'succeeded' }),
        expect.objectContaining({ id: lease, status: 'running' }),
      ]),
    );
  });

  // ── stale_jobs ────────────────────────────────────────────────────────
  it('stale_jobs deletes only its organization’s old terminal jobs without delivery evidence', async () => {
    const orgA = await newOrg();
    const orgB = await newOrg();
    const old = (status: string, org = orgA) => mkJob(org, { status, ageDays: 10 });
    const doomed = [await old('succeeded'), await old('cancelled')];
    const kept = {
      failed: await old('failed'),
      deadLetter: await old('dead_letter'),
      pending: await old('pending'),
      young: await mkJob(orgA, { status: 'succeeded', ageDays: 1 }),
      withDelivery: await old('succeeded'),
      otherOrg: await old('succeeded', orgB),
    };
    const sub = (
      await owner.query<{ id: string }>(
        `insert into public.integration_webhook_subscriptions (org_id, url, events, signing_secret_ciphertext)
         values ($1, 'https://example.com/cln', array['*'], 'cln-cipher') returning id`,
        [orgA],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into public.integration_webhook_deliveries (org_id, subscription_id, job_id, event_key)
       values ($1, $2, $3, 'cln.event')`,
      [orgA, sub, kept.withDelivery],
    );

    const workerId = `cln-stale-${RUN}`;
    const held = await holdCleanup(orgA, workerId, { target: 'stale_jobs', olderThanDays: 5 });

    // Dry run: the same rows counted, nothing changed.
    const dryWorker = `cln-stale-dry-${RUN}`;
    const dry = await holdCleanup(orgA, dryWorker, {
      target: 'stale_jobs',
      olderThanDays: 5,
      dryRun: true,
    });
    expect(await runCleanup(appWorker, dry, dryWorker)).toEqual({
      target: 'stale_jobs',
      dry_run: true,
      affected: 2,
    });
    expect(await rowsOf(doomed)).toHaveLength(2);

    expect(await runCleanup(appWorker, held, workerId)).toEqual({
      target: 'stale_jobs',
      dry_run: false,
      affected: 2,
    });
    expect(await rowsOf(doomed)).toEqual([]);
    const survivors = await rowsOf([...Object.values(kept), held, dry]);
    expect(survivors.map((r) => r.id).sort()).toEqual([...Object.values(kept), held, dry].sort());
  });

  // ── expired_leases ────────────────────────────────────────────────────
  it('expired_leases resets only its organization’s expired leases — never a fresh one, never itself', async () => {
    const orgA = await newOrg();
    const orgB = await newOrg();
    const other = `cln-lost-${RUN}`;
    const lease = (org: string, status: string, agoSec: number) =>
      mkJob(org, { status, claimedBy: other, claimedAgoSec: agoSec });
    const expired = [await lease(orgA, 'running', 600), await lease(orgA, 'claimed', 600)];
    const fresh = await lease(orgA, 'running', 120);
    const otherOrg = await lease(orgB, 'running', 600);

    // The held cleanup job itself looks expired too (claimed 10 minutes ago, no heartbeat).
    const workerId = `cln-lease-${RUN}`;
    const held = await holdCleanup(orgA, workerId, { target: 'expired_leases' }, 600, false);

    const dryWorker = `cln-lease-dry-${RUN}`;
    const dry = await holdCleanup(orgA, dryWorker, { target: 'expired_leases', dryRun: true });
    expect(await runCleanup(appWorker, dry, dryWorker)).toEqual({
      target: 'expired_leases',
      dry_run: true,
      affected: 3, // the two expired leases, and the other cleanup job — expired to this one
    });
    expect((await rowsOf(expired)).every((r) => r.status !== 'pending')).toBe(true);

    expect(await runCleanup(appWorker, held, workerId)).toEqual({
      target: 'expired_leases',
      dry_run: false,
      affected: 2,
    });
    for (const r of await rowsOf(expired)) {
      expect(r).toMatchObject({
        status: 'pending',
        attempts: 1,
        claimed_by: null,
        error_code: 'LEASE_EXPIRED',
      });
    }
    expect(await rowsOf([fresh, otherOrg, held])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fresh, status: 'running', claimed_by: other }),
        expect.objectContaining({ id: otherOrg, status: 'running', claimed_by: other }),
        expect.objectContaining({ id: held, status: 'running', claimed_by: workerId }),
      ]),
    );
  });

  // ── The real handler ──────────────────────────────────────────────────
  it('the handler drives it end to end on the worker connection', async () => {
    const { handleCleanup } = await import('@/worker/handlers');
    const { buildJobAuthorization } = await import('@/worker/worker');
    const org = await newOrg();
    const doomed = await mkJob(org, { status: 'cancelled', ageDays: 10 });
    const kept = await mkJob(org, { status: 'succeeded', ageDays: 1 });
    const workerId = `cln-handler-${RUN}`;
    const payload = { target: 'stale_jobs', olderThanDays: 5 };
    const held = await holdCleanup(org, workerId, payload);
    const now = new Date().toISOString();
    const job: Job = {
      id: held,
      orgId: org,
      type: 'cleanup',
      status: 'running',
      priority: 0,
      payload,
      attempts: 0,
      maxAttempts: 5,
      nextRunAt: now,
      claimedBy: workerId,
      claimedAt: now,
      heartbeatAt: now,
      dedupKey: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    const ctx = {
      job,
      auth: buildJobAuthorization(job),
      signal: new AbortController().signal,
      workerId,
    };

    await handleCleanup(ctx);
    expect(await statusOf(doomed)).toBe('DELETED');
    expect(await statusOf(kept)).toBe('succeeded');

    // Another worker id cannot ride the same job through the handler.
    const doomed2 = await mkJob(org, { status: 'cancelled', ageDays: 10 });
    // (Drizzle wraps the database error; the SQLSTATE is on its cause.)
    await expect(handleCleanup({ ...ctx, workerId: `cln-thief-${RUN}` })).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    expect(await statusOf(doomed2)).toBe('cancelled');
  });
});
