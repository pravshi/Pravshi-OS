/**
 * Phase 12 (F-12-02) — Stale-claim reaper LIVE DB tests.
 *
 * Mock-free companion to the reap coverage in tests/jobs/worker-lifecycle
 * .test.ts. That file mocks the pool, so it can only prove the wiring
 * (cadence, definer call, bound threshold). The SEMANTICS — which rows the
 * 0049 definer flips and which it must never touch — only real Postgres can
 * prove, and they are the crash-recovery contract:
 *
 *   - a 'claimed' or 'running' job whose heartbeat went stale (its worker
 *     died mid-flight) is reset to 'pending', claim fields cleared, the
 *     abandoned attempt burned (attempts+1), error_code='STALE_CLAIM';
 *   - a job with a LIVE heartbeat (a worker is actively running it) is
 *     never reaped, however long it has been claimed.
 *
 * runWorker() now calls reapStaleJobs() on the reapIntervalMs cadence and
 * runner.ts calls it once at startup; this file exercises the same real
 * reapStaleJobs the worker plane runs.
 *
 * Gated behind DB_READY (tests/workflows/helpers.ts): skipped when the
 * DATABASE_URL_MIGRATE / DATABASE_URL_TEST branch env vars are absent;
 * runs on CI against the ephemeral Postgres.
 *
 * reapStaleJobs is imported dynamically inside beforeAll (which only runs
 * when DB_READY) so that merely loading this file never evaluates the
 * app's env-gated pool module — without DB the suite skips cleanly instead
 * of failing at import time.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

import { DB_READY, mkOrg, RUN } from '../workflows/helpers';

const dbReady = DB_READY;

describe.skipIf(!dbReady)('stale-claim reaper (live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  let orgId = '';

  // Bound lazily in beforeAll so the real module (and the env-gated pool it
  // imports) is only evaluated when a database is actually available.
  let reapStaleJobs: (thresholdMs?: number) => Promise<number>;

  beforeAll(async () => {
    if (!dbReady) return;
    ({ reapStaleJobs } = await import('@/lib/jobs/worker'));
    orgId = await mkOrg(owner, `reap-${RUN}`);
  }, 30_000);

  afterEach(async () => {
    if (!dbReady) return;
    await owner.query(`delete from public.jobs where org_id = $1::uuid`, [orgId]);
  });

  afterAll(async () => {
    if (!dbReady) return;
    // Org cleanup intentionally omitted — same established pattern as
    // retry-sweeper-live.test.ts (system roles make orgs undeletable; the
    // CI database is discarded after the run). The afterEach above already
    // removes this file's job rows.
    await owner.end();
  });

  const insertClaimed = async (over: {
    status: 'claimed' | 'running';
    heartbeatAge: string;
    attempts?: number;
  }): Promise<string> => {
    const ins = await owner.query<{ id: string }>(
      `insert into public.jobs
         (org_id, type, status, attempts, max_attempts, next_run_at,
          claimed_by, claimed_at, heartbeat_at)
       values ($1::uuid, 'email', $2, $3, 5, now(),
               'dead-worker-1', now() - interval '15 minutes',
               now() - ($4)::interval)
       returning id`,
      [orgId, over.status, over.attempts ?? 0, over.heartbeatAge],
    );
    return ins.rows[0]!.id;
  };

  const readJob = async (id: string) =>
    (
      await owner.query<{
        status: string;
        attempts: number;
        error_code: string | null;
        claimed_by: string | null;
        claimed_at: string | null;
        heartbeat_at: string | null;
      }>(
        `select status, attempts, error_code, claimed_by, claimed_at, heartbeat_at
         from public.jobs where id = $1::uuid`,
        [id],
      )
    ).rows[0]!;

  it('reaps a claimed job whose worker died: pending again, attempt burned, claim cleared', async () => {
    const jobId = await insertClaimed({
      status: 'claimed',
      heartbeatAge: '10 minutes',
      attempts: 1,
    });

    const reaped = await reapStaleJobs(60_000);
    // The reaper is global across orgs; the pinned assertion is OUR row's
    // state (below). The count includes every stale claim in the database.
    expect(reaped).toBeGreaterThanOrEqual(1);

    const row = await readJob(jobId);
    expect(row.status).toBe('pending');
    expect(Number(row.attempts)).toBe(2); // the abandoned attempt counts
    expect(row.error_code).toBe('STALE_CLAIM');
    expect(row.claimed_by).toBeNull();
    expect(row.claimed_at).toBeNull();
    expect(row.heartbeat_at).toBeNull();
  });

  it('reaps a running job with a stale heartbeat the same way', async () => {
    const jobId = await insertClaimed({ status: 'running', heartbeatAge: '10 minutes' });

    await reapStaleJobs(60_000);

    const row = await readJob(jobId);
    expect(row.status).toBe('pending');
    expect(Number(row.attempts)).toBe(1);
    expect(row.error_code).toBe('STALE_CLAIM');
  });

  it('never reaps a live job: fresh heartbeat survives any threshold pass', async () => {
    const jobId = await insertClaimed({
      status: 'running',
      heartbeatAge: '0 seconds',
      attempts: 2,
    });

    await reapStaleJobs(60_000);

    const row = await readJob(jobId);
    expect(row.status).toBe('running');
    expect(Number(row.attempts)).toBe(2); // no attempt burned
    expect(row.error_code).toBeNull();
    expect(row.claimed_by).toBe('dead-worker-1'); // claim intact — its worker is alive
    expect(row.heartbeat_at).not.toBeNull();
  });

  it('respects the threshold: a heartbeat younger than it is not stale', async () => {
    const jobId = await insertClaimed({ status: 'claimed', heartbeatAge: '30 seconds' });

    await reapStaleJobs(60_000);

    const row = await readJob(jobId);
    expect(row.status).toBe('claimed');
    expect(Number(row.attempts)).toBe(0);
  });
});
