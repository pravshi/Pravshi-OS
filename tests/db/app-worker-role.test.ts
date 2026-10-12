/**
 * The worker's own database role, app_worker (migration 0070). LIVE DB, real logins.
 *
 * The boundary under test: an ordinary app_user connection cannot become the worker —
 * not by SET ROLE / SET SESSION AUTHORIZATION, not by writing app.person_id / app.org_id,
 * not by calling worker-plane functions directly — and app_worker, in turn, is no
 * superuser: no table, sequence or schema-object privilege, no RLS policy, no way to act
 * as a person. Every assertion runs on the real login roles (DATABASE_URL_TEST = app_user,
 * DATABASE_URL_WORKER = app_worker); nothing here mocks the identity.
 *
 * Rows that the global worker functions could touch are created in rolled-back
 * transactions or at a priority no other suite uses, so parallel suites are unaffected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from '@neondatabase/serverless';

import { DB_READY, mkOrg, mkPerson, RUN } from '../workflows/helpers';
import { SYSTEM_ACTOR, WORKER_DB_READY } from '../worker-role';
import { parseRuntimeEnv } from '@/env';

const READY = DB_READY && WORKER_DB_READY;

/** Fixture ids the probes below name (created in beforeAll). */
interface Fx {
  orgA: string;
  heldJob: string;
  subA: string;
}

/**
 * Every function migration 0070 makes app_worker's alone, probed with arguments that a
 * pre-0070 app_user call would have SUCCEEDED with (a real job held under worker id
 * 'probe', org A's real subscription under an org-A worker context) — so the refusal can
 * only be the grant, never the function body.
 */
const WORKER_ONLY: [string, (f: Fx) => string][] = [
  ['jobs_claim_next', () => `select public.jobs_claim_next('probe', array['cleanup'])`],
  ['jobs_start', (f) => `select public.jobs_start('probe', '${f.heldJob}')`],
  ['jobs_complete', (f) => `select public.jobs_complete('probe', '${f.heldJob}')`],
  ['jobs_fail', (f) => `select public.jobs_fail('probe', '${f.heldJob}', 'X', 'x', true)`],
  ['jobs_heartbeat', (f) => `select public.jobs_heartbeat('probe', '${f.heldJob}')`],
  ['jobs_release_claim', (f) => `select public.jobs_release_claim('${f.heldJob}', 'probe')`],
  ['jobs_apply_backoff', (f) => `select public.jobs_apply_backoff('${f.heldJob}', now())`],
  ['jobs_reap_stale', () => `select public.jobs_reap_stale(86400000)`],
  ['jobs_sweep_retryable', () => `select public.jobs_sweep_retryable(1)`],
  ['worker_next_due_at', () => `select public.worker_next_due_at()`],
  ['claim_due_task_reminders', () => `select * from public.claim_due_task_reminders(1)`],
  [
    'scheduler_tick_claim',
    () => `select * from public.scheduler_tick_claim('1960-01-01'::timestamptz)`,
  ],
  [
    'scheduler_tick_fire',
    () =>
      `select public.scheduler_tick_fire('00000000-0000-4000-8000-0000000000a1', now(), now(), 'w', 'k')`,
  ],
  ['maintain_audit_log_partitions', () => `select * from public.maintain_audit_log_partitions()`],
  ['run_data_retention', () => `select * from public.run_data_retention(1)`],
  [
    'job_email_content_for_worker',
    (f) => `select * from public.job_email_content_for_worker('${f.heldJob}', 'probe')`,
  ],
  [
    'integration_webhook_resolve_delivery',
    (f) => `select * from public.integration_webhook_resolve_delivery('${f.orgA}', '${f.subA}')`,
  ],
  [
    'workflow_execute_as_job',
    (f) => `select * from public.workflow_execute_as_job('${f.heldJob}', 'probe')`,
  ],
];

describe.skipIf(!READY)('app_worker — the worker plane’s own login (0070, live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  const appUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
  const appWorker = new Pool({ connectionString: process.env.DATABASE_URL_WORKER });
  let orgA = '';
  let orgB = '';
  let personA = '';
  let personB = '';
  let heldJob = '';
  let subA = '';

  beforeAll(async () => {
    if (!READY) return;
    orgA = await mkOrg(owner, `appw-a-${RUN}`);
    orgB = await mkOrg(owner, `appw-b-${RUN}`);
    personA = await mkPerson(owner, orgA, `Appw A ${RUN}`);
    personB = await mkPerson(owner, orgB, `Appw B ${RUN}`);
    // An email job already held (running) under worker id 'probe', far in the future so
    // no sweep, reaper or claim of another suite ever touches it.
    heldJob = (
      await owner.query<{ id: string }>(
        `insert into public.jobs (org_id, type, status, payload, next_run_at, claimed_by, claimed_at, heartbeat_at)
         values ($1, 'email', 'running', '{}'::jsonb, now() + interval '30 days', 'probe', now(), now() + interval '30 days')
         returning id`,
        [orgA],
      )
    ).rows[0]!.id;
    subA = (
      await owner.query<{ id: string }>(
        `insert into public.integration_webhook_subscriptions (org_id, url, events, signing_secret_ciphertext)
         values ($1, 'https://example.com/appw', array['*'], 'appw-cipher') returning id`,
        [orgA],
      )
    ).rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await owner.end();
    await appUser.end();
    await appWorker.end();
  });

  /** Run `sql` on one connection of `pool`, inside a transaction that is always rolled back. */
  async function rolledBack<T extends Record<string, unknown>>(
    pool: Pool,
    ctx: { personId?: string; orgId?: string },
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const c: PoolClient = await pool.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
        [ctx.personId ?? '', ctx.orgId ?? ''],
      );
      return (await c.query<T>(sql, params)).rows;
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  }
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ALLOWED';
    } catch (e) {
      return (e as { code?: string }).code ?? 'ERROR';
    }
  };

  // ── Who the connections are ────────────────────────────────────────────
  it('each URL authenticates as its own role; neither is privileged', async () => {
    const who = async (pool: Pool) =>
      (
        await pool.query<{ s: string; c: string; bypass: boolean; superuser: boolean }>(
          `select session_user::text s, current_user::text c, r.rolbypassrls bypass, r.rolsuper superuser
             from pg_roles r where r.rolname = session_user`,
        )
      ).rows[0]!;
    expect(await who(appWorker)).toEqual({
      s: 'app_worker',
      c: 'app_worker',
      bypass: false,
      superuser: false,
    });
    expect((await who(appUser)).s).toBe('app_user');
    const isWorker = async (pool: Pool) =>
      (await pool.query<{ w: boolean }>(`select authz.is_worker() w`).catch(() => null))?.rows[0]
        ?.w;
    expect(await isWorker(appUser)).toBe(false);
  });

  it('the runtime self-check the worker runs at start sees app_worker', async () => {
    const { workerSessionRole } = await import('@/lib/db/worker-pool');
    expect(await workerSessionRole()).toBe('app_worker');
  });

  // ── app_user cannot become the worker ─────────────────────────────────
  it('app_user cannot assume the worker role (SET ROLE / SET SESSION AUTHORIZATION)', async () => {
    expect(await codeOf(rolledBack(appUser, {}, `set local role app_worker`))).toBe('42501');
    expect(await codeOf(rolledBack(appUser, {}, `set session authorization app_worker`))).toBe(
      '42501',
    );
    const members = await owner.query<{ n: number }>(
      `select count(*)::int n from pg_auth_members am
         join pg_roles m on m.oid = am.member join pg_roles r on r.oid = am.roleid
        where m.rolname = 'app_worker' or r.rolname = 'app_worker'`,
    );
    expect(members.rows[0]!.n).toBe(0);
  });

  it.each(WORKER_ONLY)(
    'app_user cannot call %s — with no identity, or forging the worker’s context',
    async (_name, build) => {
      const sql = build({ orgA, heldJob, subA });
      expect(await codeOf(rolledBack(appUser, {}, sql))).toBe('42501');
      expect(await codeOf(rolledBack(appUser, { personId: SYSTEM_ACTOR, orgId: orgA }, sql))).toBe(
        '42501',
      );
    },
  );

  it('a forged worker context on app_user cannot use the shared definers’ worker branch', async () => {
    const forged = { personId: SYSTEM_ACTOR, orgId: orgA };
    for (const sql of [
      `select public.notifications_recipient_exists('${orgA}'::uuid, '${personA}'::uuid)`,
      `select public.notification_channel_enabled('${orgA}'::uuid, '${personA}'::uuid, 'TASK_DUE', 'in_app')`,
      `select public.notifications_insert('${orgA}'::uuid, '${personA}'::uuid, 'forged', 'x', '{}'::jsonb)`,
    ]) {
      expect(await codeOf(rolledBack(appUser, forged, sql)), sql).toBe('42501');
      // The same call on the worker login, bound to that org, is answered.
      expect(await codeOf(rolledBack(appWorker, forged, sql)), sql).toBe('ALLOWED');
    }
  });

  // ── app_worker is not a superuser ─────────────────────────────────────
  it('app_worker has no direct table access — not even to the jobs it processes', async () => {
    for (const sql of [
      `select count(*) from public.jobs`,
      `select count(*) from public.people`,
      `select count(*) from public.job_email_content`,
      `select count(*) from public.integration_webhook_subscriptions`,
      `select count(*) from public.audit_logs`,
      `update public.jobs set priority = priority where false`,
      `delete from public.jobs where false`,
      `insert into public.notifications (org_id, person_id, title, message) values ('${orgA}', '${personA}', 'x', 'x')`,
    ]) {
      expect(await codeOf(rolledBack(appWorker, {}, sql)), sql).toBe('42501');
    }
    // Not the auth schema either (no usage, no grants).
    expect(
      await codeOf(rolledBack(appWorker, {}, `select count(*) from auth.auth_users`)),
    ).not.toBe('ALLOWED');
  });

  it('app_worker cannot act as a person: a person context opens no table and no app definer', async () => {
    const asPerson = { personId: personA, orgId: orgA };
    expect(
      await codeOf(rolledBack(appWorker, asPerson, `select count(*) from public.people`)),
    ).toBe('42501');
    for (const sql of [
      `select public.set_person_roles('${personA}'::uuid, array[]::uuid[])`,
      `select public.write_audit_log(p_action := 'x.y', p_entity_type := 'person', p_result := 'SUCCESS'::public.audit_result)`,
      `select authz.next_identity_code_for_current_org('EMP', '2026')`,
    ]) {
      expect(await codeOf(rolledBack(appWorker, asPerson, sql)), sql).toBe('42501');
    }
    // And the worker-only definers still refuse a person context on the worker login.
    expect(
      await codeOf(rolledBack(appWorker, asPerson, `select public.jobs_claim_next('w', null)`)),
    ).toBe('42501');
  });

  // ── The worker plane works, per organization ──────────────────────────
  it('runs a job lifecycle on the worker login, and a job of one org writes only to that org', async () => {
    const workerId = `appw-${RUN}`;
    const c = await owner.connect();
    let jobA = '';
    let jobB = '';
    try {
      // Two orgs' notification jobs, at a priority no other suite uses, so this file's
      // claims take exactly these two and nothing another suite queued.
      const ins = async (org: string, person: string, priority: number) =>
        (
          await c.query<{ id: string }>(
            `insert into public.jobs (org_id, type, status, priority, payload, next_run_at)
             values ($1, 'notification', 'pending', $3, $2::jsonb, now() - interval '1 second')
             returning id`,
            [
              org,
              JSON.stringify({ personId: person, title: `appw ${RUN}`, message: 'm' }),
              priority,
            ],
          )
        ).rows[0]!.id;
      jobA = await ins(orgA, personA, 1_999_999_101);
      jobB = await ins(orgB, personB, 1_999_999_100);
    } finally {
      c.release();
    }
    const w = await appWorker.connect();
    try {
      const claimed: { id: string; org_id: string }[] = [];
      for (let i = 0; i < 2; i += 1) {
        const r = await w.query<{ id: string; org_id: string }>(
          `select id, org_id from public.jobs_claim_next($1, array['notification'])`,
          [workerId],
        );
        claimed.push(r.rows[0]!);
      }
      expect(claimed.map((x) => x.id)).toEqual([jobA, jobB]);
      for (const job of claimed) {
        await w.query(`select public.jobs_start($1, $2::uuid)`, [workerId, job.id]);
        await w.query(`select public.jobs_heartbeat($1, $2::uuid)`, [workerId, job.id]);
        // The handler's write, bound to the job row's org (withWorkerContext shape).
        await w.query('begin');
        await w.query(
          `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
          [SYSTEM_ACTOR, job.org_id],
        );
        const person = job.org_id === orgA ? personA : personB;
        await w.query(
          `select public.notifications_insert($1::uuid, $2::uuid, $3, 'm', '{}'::jsonb)`,
          [job.org_id, person, `appw ${RUN}`],
        );
        // The same context naming the OTHER org is refused.
        const other = job.org_id === orgA ? orgB : orgA;
        await w.query('savepoint s');
        expect(
          await codeOf(
            w.query(
              `select public.notifications_insert($1::uuid, $2::uuid, 'x', 'x', '{}'::jsonb)`,
              [other, person],
            ),
          ),
        ).toBe('42501');
        await w.query('rollback to savepoint s');
        await w.query('commit');
        await w.query(`select public.jobs_complete($1, $2::uuid)`, [workerId, job.id]);
      }
    } finally {
      w.release();
    }
    const done = await owner.query<{ id: string; status: string }>(
      `select id, status from public.jobs where id = any($1::uuid[]) order by id`,
      [[jobA, jobB]],
    );
    expect(done.rows.every((r) => r.status === 'succeeded')).toBe(true);
    const written = await owner.query<{ org_id: string; person_id: string }>(
      `select org_id, person_id from public.notifications where title = $1 order by org_id`,
      [`appw ${RUN}`],
    );
    expect(written.rows).toHaveLength(2);
    expect(new Set(written.rows.map((r) => `${r.org_id}:${r.person_id}`))).toEqual(
      new Set([`${orgA}:${personA}`, `${orgB}:${personB}`]),
    );
  });

  // ── The credential stays off the web runtime ──────────────────────────
  it('the runtime environment refuses DATABASE_URL_WORKER on Vercel, and accepts it on the worker host', () => {
    const base = {
      DATABASE_URL: 'postgresql://u:p@ep-x-pooler.example.test/db',
      DATABASE_URL_WORKER: 'postgresql://u:p@ep-x-pooler.example.test/db',
      APP_URL: 'https://app.example.test',
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'x'.repeat(40),
    };
    expect(() => parseRuntimeEnv({ ...base, VERCEL: '1' })).toThrow(/DATABASE_URL_WORKER/);
    expect(() =>
      parseRuntimeEnv({ ...base, VERCEL: '1', NEXT_PHASE: 'phase-production-build' }),
    ).toThrow(/DATABASE_URL_WORKER/);
    expect(parseRuntimeEnv(base).DATABASE_URL_WORKER).toBe(base.DATABASE_URL_WORKER);
    expect(() =>
      parseRuntimeEnv({ ...base, DATABASE_URL_WORKER: 'postgresql://u:p@ep-x.example.test/db' }),
    ).toThrow(/pooled/);
  });
});
