/**
 * REL-11 — what happens to a job whose handler never returns, across worker restarts. LIVE DB:
 * the real release (0050), reaper (0049) and claim (0068), called as app_worker.
 *
 * A hung handler keeps its lease alive, so while its worker lives the job is never reaped;
 * REL-11's watchdog reports the stall and does nothing else. What a restart then does depends
 * on how the process ends:
 *   - GRACEFUL (SIGTERM): the worker aborts the job's signal, waits shutdownTimeoutMs (30 s) for
 *     a handler that ignores it, then RELEASES the claim (jobs_release_claim, 0050): the job is
 *     'pending' again with attempts UNCHANGED;
 *   - HARD (SIGKILL, crash, out of memory, a platform grace period under 30 s): the lease
 *     lapses and the REAPER (jobs_reap_stale, 0049) returns it to 'pending' with attempts+1 —
 *     and never dead-letters, not even past max_attempts.
 * Either way the next worker claims it again: the claim (0068) does not look at attempts.
 * KNOWN GAP (REL-11 finding, not fixed here: it needs a migration and its own approval): a job
 * that hangs on every attempt is retried for as long as something keeps restarting the worker,
 * and a graceful restart does not even count the attempt. A job that FAILS is bounded —
 * failJob dead-letters at max_attempts (tests/jobs/failure-resilience.test.ts). That is why
 * this first liveness version never restarts anything itself. Bounding it needs both paths (or
 * the claim) to respect max_attempts; this suite changes with that fix.
 *
 * Isolation. The 'serial' project runs before every other suite; its files may run alongside
 * each other, and none of the others claims a job. The reap is database-wide (as the worker's
 * is); the global claim is probed inside a transaction that is rolled back; the release names
 * this suite's own job. Its jobs carry a fixed dedup_key marker and are deleted before and
 * after the run, so an interrupted run leaves nothing for the next one to trip over.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { DB_READY, mkOrg, RUN } from '../workflows/helpers';

const READY = DB_READY && !!process.env.DATABASE_URL_WORKER;
const DUE = '2000-01-01T00:00:00Z';
const MARKER = 'rel11-stalled-job-probe';

describe.skipIf(!READY)('a job that hangs on every attempt, across restarts (live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  const worker = new Pool({ connectionString: process.env.DATABASE_URL_WORKER, max: 1 });
  const removeProbes = () =>
    owner.query(`delete from public.jobs where dedup_key like $1`, [`${MARKER}%`]);
  let orgId = '';

  beforeAll(async () => {
    if (!READY) return;
    await removeProbes(); // whatever an interrupted earlier run left behind
    orgId = await mkOrg(owner, `rel11-hang-${RUN}`);
  }, 30_000);

  afterAll(async () => {
    if (!READY) return;
    try {
      await removeProbes();
    } finally {
      await Promise.all([owner.end(), worker.end()]);
    }
  });

  /** A job some worker holds, mid-handler. `leaseAge`: how long ago its lease was renewed. */
  const insertHeld = async (o: {
    tag: string;
    attempts: number;
    leaseAge: string;
    priority: number;
    nextRunAt: string;
  }) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.jobs
           (org_id, type, status, priority, attempts, max_attempts, next_run_at, dedup_key,
            claimed_by, claimed_at, heartbeat_at)
         values ($1::uuid, 'email', 'claimed', $2, $3, 5, $4::timestamptz, $5,
                 'stalled-worker', now() - interval '20 minutes', now() - $6::interval)
         returning id`,
        [orgId, o.priority, o.attempts, o.nextRunAt, `${MARKER}-${o.tag}`, o.leaseAge],
      )
    ).rows[0]!.id;

  const readJob = async (id: string) =>
    (
      await owner.query<{
        status: string;
        attempts: number;
        max_attempts: number;
        error_code: string | null;
        claimed_by: string | null;
      }>(
        `select status, attempts, max_attempts, error_code, claimed_by
           from public.jobs where id = $1::uuid`,
        [id],
      )
    ).rows[0]!;

  it('graceful restart: the release returns it to pending with attempts unchanged', async () => {
    // Not due (tomorrow) and lowest priority: once pending it is no other suite's candidate.
    const id = await insertHeld({
      tag: 'release',
      attempts: 4,
      leaseAge: '0 seconds',
      priority: 0,
      nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const { rows } = await worker.query<{ released: boolean }>(
      `select public.jobs_release_claim($1::uuid, 'stalled-worker') as released`,
      [id],
    );
    expect(rows[0]!.released).toBe(true);
    expect(await readJob(id)).toEqual({
      status: 'pending',
      attempts: 4, // the abandoned attempt is not counted
      max_attempts: 5,
      error_code: null,
      claimed_by: null,
    });
  });

  describe('hard restart (the lease lapses)', () => {
    let id = '';
    beforeAll(async () => {
      if (!READY) return;
      // Every attempt already spent; sorts first (highest priority, oldest due).
      id = await insertHeld({
        tag: 'reap',
        attempts: 5,
        leaseAge: '10 minutes',
        priority: 2147483647,
        nextRunAt: DUE,
      });
    });

    it('the reaper returns it to pending and burns an attempt — past max_attempts, never dead-lettering', async () => {
      const { rows } = await worker.query<{ n: number }>(
        `select public.jobs_reap_stale(60000)::int as n`,
      );
      expect(rows[0]!.n).toBeGreaterThanOrEqual(1);
      expect(await readJob(id)).toEqual({
        status: 'pending',
        attempts: 6,
        max_attempts: 5,
        error_code: 'STALE_CLAIM',
        claimed_by: null,
      });
    });

    it('the next worker claims it again: the claim does not look at attempts (rolled back)', async () => {
      const client = await worker.connect();
      try {
        await client.query('begin');
        const claimed = await client.query<{ id: string | null; attempts: number | null }>(
          `select (j).id, (j).attempts
             from (select public.jobs_claim_next('rel11-probe', array['email']) as j) c`,
        );
        expect(claimed.rows[0]).toEqual({ id, attempts: 6 });
      } finally {
        await client.query('rollback');
        client.release();
      }
      expect(await readJob(id)).toMatchObject({ status: 'pending', claimed_by: null });
    });

    it('meanwhile worker_next_due_at() reports it due, so a sleeping worker wakes for it', async () => {
      const { rows } = await worker.query<{ due: boolean }>(
        `select public.worker_next_due_at() <= $1::timestamptz as due`,
        [DUE],
      );
      expect(rows[0]!.due).toBe(true);
    });
  });
});
