/**
 * Phase 6 — Failure & resilience tests (contract §7.2 worker-crash / §7.3-adjacent).
 *
 * Proves the job system survives failures without duplicate business actions:
 *   1. Worker crash mid-execution → reaper → re-executed → completes once
 *   2. Duplicate enqueue (same dedupKey, concurrent) → exactly 1 job row
 *   3. Double scheduler tick → exactly 1 job per schedule
 *   4. Retry exhaustion → dead_letter (not infinite)
 *   5. Non-retryable error → dead_letter immediately (attempts = 1)
 *   6. Crash after side effect → retry does NOT duplicate the effect
 *   7. Stale heartbeat → reaped to pending with attempts + 1
 *   8. SIGTERM with in-flight job → claim released to pending (not lost, not duplicated)
 *
 * ── HOW THE MOCKS WORK ─────────────────────────────────────────────────────
 * Real modules under test: runWorker / reapStaleJobs (via the
 * public.jobs_reap_stale SECURITY DEFINER function, migration 0049)
 * (worker.ts), releaseClaim / applyRetryBackoff (via the
 * public.jobs_release_claim and public.jobs_apply_backoff SECURITY DEFINER
 * functions, migration 0050) (worker.ts), tickScheduler / scheduleDedupKey
 * (scheduler.ts), classifyError / backoffDelayMs (retry.ts).
 *
 * Mocked at the module boundary (repo convention, cf. worker-lifecycle.test.ts):
 *   - '@/lib/jobs/queue' → in-memory store implementing the REAL queue
 *     contracts: (org_id, dedup_key) arbitration on enqueue, SKIP-LOCKED-style
 *     atomic claim, claimed→running→succeeded/failed/dead_letter transitions,
 *     attempts counted on fail (not on claim), claimed_by ownership checks.
 *   - 'drizzle-orm/neon-serverless' + '@/lib/db/pool' → a tiny SQL interpreter
 *     that applies the worker-plane statements (reapStaleJobs via the
 *     jobs_reap_stale call, releaseClaim via the jobs_release_claim call,
 *     applyRetryBackoff via the jobs_apply_backoff call) and the scheduler
 *     tick statements (advisory lock, scheduler_tick_claim,
 *     scheduler_tick_fire with ON CONFLICT DO NOTHING semantics) to the same
 *     in-memory store.
 *
 * The two properties that only real Postgres can prove (23505 arbitration under
 * a true concurrent race, and the reaper predicate against the real schema) are
 * covered in the DB-gated block at the bottom (describe.skipIf(!DB_READY)).
 *
 * Determinism: no fixed sleeps gate progress — every wait polls a condition
 * with a failure-only timeout. Sleeps appear only in negative assertions
 * ("no 4th invocation happens"), where extra time only strengthens the check.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── In-memory fake store (vi.hoisted so mock factories can close over it) ────

const hoisted = vi.hoisted(() => {
  interface FakeJob {
    id: string;
    orgId: string;
    type: string;
    status: string;
    priority: number;
    payload: Record<string, unknown>;
    attempts: number;
    maxAttempts: number;
    nextRunAtMs: number;
    createdSeq: number;
    claimedBy: string | null;
    claimedAtMs: number | null;
    heartbeatAtMs: number | null;
    dedupKey: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  }

  interface FakeSchedule {
    id: string;
    orgId: string;
    workflowId: string;
    name: string;
    cron: string;
    timezone: string;
    isActive: boolean;
    lastRunAtMs: number | null;
    nextRunAtMs: number;
  }

  const jobs = new Map<string, FakeJob>();
  const schedules = new Map<string, FakeSchedule>();
  let seq = 0;

  function insertJob(row: {
    orgId: string;
    type: string;
    payload?: Record<string, unknown>;
    priority?: number;
    maxAttempts?: number;
    nextRunAtMs?: number;
    dedupKey?: string | null;
  }): FakeJob {
    seq += 1;
    const job: FakeJob = {
      id: `fake-job-${String(seq).padStart(4, '0')}`,
      orgId: row.orgId,
      type: row.type,
      status: 'pending',
      priority: row.priority ?? 0,
      payload: row.payload ?? {},
      attempts: 0,
      maxAttempts: row.maxAttempts ?? 5,
      nextRunAtMs: row.nextRunAtMs ?? Date.now(),
      createdSeq: seq,
      claimedBy: null,
      claimedAtMs: null,
      heartbeatAtMs: null,
      dedupKey: row.dedupKey ?? null,
      errorCode: null,
      errorMessage: null,
    };
    jobs.set(job.id, job);
    return job;
  }

  /** Map a store row onto the public Job contract shape. */
  function mapJob(j: FakeJob): Record<string, unknown> {
    const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
    return {
      id: j.id,
      orgId: j.orgId,
      type: j.type,
      status: j.status,
      priority: j.priority,
      payload: j.payload,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      nextRunAt: new Date(j.nextRunAtMs).toISOString(),
      claimedBy: j.claimedBy,
      claimedAt: iso(j.claimedAtMs),
      heartbeatAt: iso(j.heartbeatAtMs),
      dedupKey: j.dedupKey,
      errorCode: j.errorCode,
      errorMessage: j.errorMessage,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function orgOf(auth: unknown, fallback: string): string {
    const orgId = (auth as { ctx?: { orgId?: unknown } } | null)?.ctx?.orgId;
    return typeof orgId === 'string' ? orgId : fallback;
  }

  // ── Fake queue module (mirrors the real contracts in src/lib/jobs/queue.ts) ──

  async function enqueueJob(
    auth: unknown,
    input: {
      type: string;
      payload?: Record<string, unknown>;
      priority?: number;
      maxAttempts?: number;
      nextRunAt?: string;
      dedupKey?: string;
    },
  ): Promise<Record<string, unknown>> {
    // NOTE: skips zod payload validation (mock); keeps the dedup arbitration,
    // which is the resilience property under test.
    const orgId = orgOf(auth, 'org-test');
    if (input.dedupKey != null) {
      for (const j of jobs.values()) {
        if (j.orgId === orgId && j.dedupKey === input.dedupKey) return mapJob(j);
      }
    }
    return mapJob(
      insertJob({
        orgId,
        type: input.type,
        payload: input.payload ?? {},
        priority: input.priority ?? 0,
        maxAttempts: input.maxAttempts ?? 5,
        nextRunAtMs: input.nextRunAt ? Date.parse(input.nextRunAt) : Date.now(),
        dedupKey: input.dedupKey ?? null,
      }),
    );
  }

  async function claimJob(
    workerId: string,
    types?: string[],
  ): Promise<Record<string, unknown> | null> {
    if (!workerId || workerId.length > 128) throw new Error('INVALID_REQUEST: workerId');
    const now = Date.now();
    const candidates = [...jobs.values()]
      .filter(
        (j) => j.status === 'pending' && j.nextRunAtMs <= now && (!types || types.includes(j.type)),
      )
      .sort(
        (a, b) =>
          b.priority - a.priority || a.nextRunAtMs - b.nextRunAtMs || a.createdSeq - b.createdSeq,
      );
    const winner = candidates[0];
    if (!winner) return null;
    // Atomic in JS's single thread — the production equivalent is
    // SELECT ... FOR UPDATE SKIP LOCKED + UPDATE in one transaction.
    winner.status = 'claimed';
    winner.claimedBy = workerId;
    winner.claimedAtMs = now;
    winner.heartbeatAtMs = now;
    return mapJob(winner);
  }

  function owned(j: FakeJob | undefined, workerId?: string): FakeJob {
    if (!j) throw new Error('NOT_FOUND: claim not held');
    if (workerId && j.claimedBy !== workerId) throw new Error('NOT_FOUND: claim not held');
    return j;
  }

  async function startJob(auth: unknown, jobId: string, workerId?: string): Promise<void> {
    const j = owned(jobs.get(jobId), workerId);
    if (j.status !== 'claimed') throw new Error(`INVALID_REQUEST: cannot start from '${j.status}'`);
    j.status = 'running';
    j.heartbeatAtMs = Date.now();
  }

  async function completeJob(
    _auth: unknown,
    jobId: string,
    _result?: unknown,
    workerId?: string,
  ): Promise<void> {
    const j = owned(jobs.get(jobId), workerId);
    if (j.status !== 'running')
      throw new Error(`INVALID_REQUEST: cannot complete from '${j.status}'`);
    j.status = 'succeeded';
    j.errorCode = null;
    j.errorMessage = null;
  }

  async function failJob(
    _auth: unknown,
    jobId: string,
    error: { code: string; message: string },
    retryable: boolean,
    workerId?: string,
  ): Promise<void> {
    const j = owned(jobs.get(jobId), workerId);
    if (j.status !== 'running' && j.status !== 'claimed') {
      throw new Error(`INVALID_REQUEST: cannot fail from '${j.status}'`);
    }
    // Attempts count COMPLETED attempts (real contract): incremented here,
    // not on claim — matching queue.ts failJob.
    j.attempts += 1;
    const terminal = !retryable || j.attempts >= j.maxAttempts;
    j.status = terminal ? 'dead_letter' : 'failed';
    j.errorCode = error.code;
    j.errorMessage = error.message;
    j.nextRunAtMs = Date.now(); // real failJob stamps now(); backoff is applied separately
  }

  async function heartbeatJob(workerId: string, jobId: string): Promise<void> {
    const j = jobs.get(jobId);
    if (!j || (j.status !== 'claimed' && j.status !== 'running') || j.claimedBy !== workerId) {
      throw new Error('NOT_FOUND: claim not held');
    }
    j.heartbeatAtMs = Date.now();
  }

  async function cancelJob(): Promise<void> {
    throw new Error('not implemented in failure-resilience mock');
  }
  async function retryJob(): Promise<Record<string, unknown>> {
    throw new Error('not implemented in failure-resilience mock');
  }

  // ── SQL interpreter for the worker-plane + scheduler statements ────────────

  function renderSql(q: unknown): { sql: string; params: unknown[] } {
    const queryable = q as {
      toQuery: (cfg: Record<string, unknown>) => { sql: string; params: unknown[] };
    };
    return queryable.toQuery({
      casing: undefined,
      escapeName: (name: string) => `"${name}"`,
      escapeParam: (index: number) => `$${index + 1}`,
      escapeString: (str: string) => `'${str}'`,
    });
  }

  function interpret(sqlText: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
    const t = sqlText.toLowerCase();

    if (t.includes('pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 0 };
    }

    if (t.includes('scheduler_tick_claim')) {
      const at = Date.parse(String(params[0]));
      const due = [...schedules.values()].filter((s) => s.isActive && s.nextRunAtMs <= at);
      return {
        rows: due.map((s) => ({
          id: s.id,
          org_id: s.orgId,
          workflow_id: s.workflowId,
          name: s.name,
          cron: s.cron,
          timezone: s.timezone,
          is_active: s.isActive,
          last_run_at: s.lastRunAtMs == null ? null : new Date(s.lastRunAtMs),
          next_run_at: new Date(s.nextRunAtMs),
          created_at: new Date(),
          updated_at: new Date(),
        })),
        rowCount: due.length,
      };
    }

    if (t.includes('scheduler_tick_fire')) {
      const [scheduleId = '', firedAtIso = '', nextIso = '', windowStart = '', dedupKey = ''] =
        params.map(String);
      const sched = schedules.get(scheduleId);
      if (!sched) throw new Error(`failure-resilience mock: unknown schedule ${scheduleId}`);
      // INSERT ... ON CONFLICT (org_id, dedup_key) DO NOTHING
      const conflict = [...jobs.values()].some(
        (j) => j.orgId === sched.orgId && j.dedupKey === dedupKey,
      );
      let fired = false;
      if (!conflict) {
        insertJob({
          orgId: sched.orgId,
          type: 'scheduled_trigger',
          payload: { scheduleId, workflowId: sched.workflowId, windowStart },
          dedupKey,
        });
        sched.nextRunAtMs = Date.parse(nextIso);
        sched.lastRunAtMs = Date.parse(firedAtIso);
        fired = true;
      }
      return { rows: [{ fired }], rowCount: 1 };
    }

    if (t.includes('jobs_reap_stale')) {
      // reapStaleJobs: SELECT public.jobs_reap_stale($1) — the threshold is
      // bound as a parameter (SECURITY DEFINER function, migration 0049).
      // Mirrors the real function semantics exactly: status in
      // ('claimed','running') AND heartbeat older than the threshold →
      // pending, attempts+1, claim cleared, error_code='STALE_CLAIM'.
      // next_run_at and error_message are NOT touched (per the 0049 contract).
      const thresholdMs = Number(params[0] ?? 60_000);
      const now = Date.now();
      let n = 0;
      for (const j of jobs.values()) {
        if (
          (j.status === 'claimed' || j.status === 'running') &&
          j.heartbeatAtMs != null &&
          now - j.heartbeatAtMs > thresholdMs
        ) {
          j.status = 'pending';
          j.attempts += 1; // the abandoned attempt counts (real reaper contract)
          j.claimedBy = null;
          j.claimedAtMs = null;
          j.heartbeatAtMs = null;
          j.errorCode = 'STALE_CLAIM';
          n += 1;
        }
      }
      // The real module reads Number(rows[0].reaped); mirror that shape.
      return { rows: [{ reaped: String(n) }], rowCount: 1 };
    }

    if (t.includes('jobs_release_claim')) {
      // releaseClaim(workerId, job): SELECT public.jobs_release_claim($1, $2) —
      // the job id and worker id are bound as parameters (SECURITY DEFINER
      // function, migration 0050). Mirrors the real function semantics
      // exactly: status in ('claimed','running') AND claimed_by = workerId →
      // pending, claim fields cleared. attempts, error_*, and next_run_at
      // are NOT touched (per the 0050 contract).
      const [id = '', workerId = ''] = params.map(String);
      const j = jobs.get(id);
      let released = false;
      if (j && (j.status === 'claimed' || j.status === 'running') && j.claimedBy === workerId) {
        j.status = 'pending';
        j.claimedBy = null;
        j.claimedAtMs = null;
        j.heartbeatAtMs = null;
        released = true;
      }
      // The real module ignores the boolean; mirror the shape anyway.
      return { rows: [{ released: String(released) }], rowCount: 1 };
    }

    if (t.includes('jobs_apply_backoff')) {
      // applyRetryBackoff(job, delayMs): SELECT
      // public.jobs_apply_backoff($1, $2) — the absolute backoff due time is
      // bound as a Date parameter (SECURITY DEFINER function, migration
      // 0050). Mirrors the real function semantics exactly: next_run_at is
      // set only when the row is 'failed'; attempts and error_* are kept.
      const id = String(params[0]);
      const j = jobs.get(id);
      let applied = false;
      if (j && j.status === 'failed') {
        j.nextRunAtMs = Number(params[1]);
        applied = true;
      }
      // The real module ignores the boolean; mirror the shape anyway.
      return { rows: [{ backoff_applied: String(applied) }], rowCount: 1 };
    }

    throw new Error(`failure-resilience mock: unhandled SQL: ${sqlText.slice(0, 220)}`);
  }

  function reset(): void {
    jobs.clear();
    schedules.clear();
    seq = 0;
  }

  return {
    jobs,
    schedules,
    insertJob,
    mapJob,
    renderSql,
    interpret,
    reset,
    enqueueJob,
    claimJob,
    startJob,
    completeJob,
    failJob,
    heartbeatJob,
    cancelJob,
    retryJob,
    releaseClient: vi.fn(),
  };
});

vi.mock('@/lib/jobs/queue', () => ({
  enqueueJob: hoisted.enqueueJob,
  claimJob: hoisted.claimJob,
  startJob: hoisted.startJob,
  completeJob: hoisted.completeJob,
  failJob: hoisted.failJob,
  heartbeatJob: hoisted.heartbeatJob,
  cancelJob: hoisted.cancelJob,
  retryJob: hoisted.retryJob,
}));

vi.mock('@/lib/db/pool', () => ({
  connectWithWake: vi.fn(async () => ({ release: hoisted.releaseClient })),
}));

vi.mock('drizzle-orm/neon-serverless', () => ({
  drizzle: () => ({
    transaction: async (
      fn: (tx: { execute: (q: unknown) => Promise<unknown> }) => Promise<unknown>,
    ) =>
      fn({
        execute: async (q: unknown) => {
          const rendered = hoisted.renderSql(q);
          return hoisted.interpret(rendered.sql, rendered.params);
        },
      }),
  }),
}));

// ── Real modules under test ─────────────────────────────────────────────────

import {
  buildJobAuthorization,
  reapStaleJobs,
  registerHandler,
  resetHandlerRegistry,
  runWorker,
} from '@/lib/jobs/worker';
import { scheduleDedupKey, tickScheduler } from '@/lib/jobs/scheduler';
import { classifyError } from '@/lib/jobs/retry';
import type { Authorization } from '@/lib/authz/require-permission';
import type { Job } from '@/lib/jobs/types';
import { DB_READY, RUN, mkOrg } from '../workflows/helpers';
import { Pool } from '@neondatabase/serverless';

// ── Test helpers ────────────────────────────────────────────────────────────

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const AUTH = { ctx: { orgId: ORG_ID, personId: 'test-person' } } as unknown as Authorization;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true');
    await sleep(5);
  }
}

function storeJob(id: string) {
  const j = hoisted.jobs.get(id);
  if (!j) throw new Error(`store has no job ${id}`);
  return j;
}

function ageHeartbeat(id: string, ms: number): void {
  storeJob(id).heartbeatAtMs = Date.now() - ms;
}

beforeEach(() => {
  hoisted.reset();
  resetHandlerRegistry();
  vi.clearAllMocks();
});

// ── 1. Worker crash mid-execution ────────────────────────────────────────────

describe('worker crash mid-execution', () => {
  it('claimed → handler starts → crash → reaper → re-executed → completes exactly once', async () => {
    let invocations = 0;
    let completions = 0;

    // Enqueue through the (mocked) queue boundary, like production code does.
    const enqueued = (await hoisted.enqueueJob(AUTH, {
      type: 'email',
      payload: { to: 'ops@example.com' },
      dedupKey: 'crash-1',
    })) as unknown as Job;

    // Phase 1 — what a real worker does before it dies: claim, start, handler
    // begins. Then the process dies: no heartbeat updates, no complete/fail.
    const claimed = (await hoisted.claimJob('worker-crash')) as unknown as Job;
    expect(claimed.id).toBe(enqueued.id);
    await hoisted.startJob(buildJobAuthorization(claimed), claimed.id, 'worker-crash');
    invocations += 1; // the handler started executing…
    // …and the process died here. Heartbeat goes stale with no one to renew it.
    ageHeartbeat(claimed.id, 120_000);

    // Phase 2 — crash recovery: the REAL reaper resets the stale claim.
    const reaped = await reapStaleJobs(60_000);
    expect(reaped).toBe(1);
    const afterReap = storeJob(claimed.id);
    expect(afterReap.status).toBe('pending');
    expect(afterReap.attempts).toBe(1); // the abandoned attempt counts
    expect(afterReap.claimedBy).toBeNull();
    expect(afterReap.errorCode).toBe('STALE_CLAIM');

    // Phase 3 — a fresh worker re-executes through the REAL runWorker loop.
    registerHandler('email', async () => {
      invocations += 1;
      completions += 1; // the business action happens here
    });
    const runPromise = runWorker({ workerId: 'worker-recovery', pollIntervalMs: 5 });
    await waitFor(() => completions === 1);
    process.emit('SIGINT');
    await runPromise;

    // The job ran to completion exactly once after the crash; the crashed
    // attempt never produced a business action.
    expect(invocations).toBe(2); // 1 crashed start + 1 completed execution
    expect(completions).toBe(1);
    expect(storeJob(claimed.id).status).toBe('succeeded');
  });
});

// ── 2. Duplicate enqueue ─────────────────────────────────────────────────────

describe('duplicate enqueue', () => {
  it('same dedupKey enqueued twice concurrently → exactly 1 job row', async () => {
    const [a, b] = (await Promise.all([
      hoisted.enqueueJob(AUTH, { type: 'email', payload: { n: 1 }, dedupKey: 'dup-1' }),
      hoisted.enqueueJob(AUTH, { type: 'email', payload: { n: 2 }, dedupKey: 'dup-1' }),
    ])) as unknown as Job[];

    // The loser of the race gets the winner's row (real 23505 arbitration).
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.id).toBe(b!.id);
    const rows = [...hoisted.jobs.values()].filter(
      (j) => j.orgId === ORG_ID && j.dedupKey === 'dup-1',
    );
    expect(rows).toHaveLength(1);
    expect(hoisted.jobs.size).toBe(1);
  });

  it('different dedupKeys do not collide', async () => {
    await hoisted.enqueueJob(AUTH, { type: 'email', payload: {}, dedupKey: 'dup-a' });
    await hoisted.enqueueJob(AUTH, { type: 'email', payload: {}, dedupKey: 'dup-b' });
    expect(hoisted.jobs.size).toBe(2);
  });
});

// ── 3. Double scheduler tick ─────────────────────────────────────────────────

describe('double scheduler tick', () => {
  const SCHED_ID = '44444444-4444-4444-8444-444444444444';
  const WORKFLOW_ID = '55555555-5555-4555-8555-555555555555';

  function seedDueSchedule(): number {
    const dueMs = Date.now() - 60_000;
    hoisted.schedules.set(SCHED_ID, {
      id: SCHED_ID,
      orgId: ORG_ID,
      workflowId: WORKFLOW_ID,
      name: 'nightly',
      cron: '*/5 * * * *',
      timezone: 'UTC',
      isActive: true,
      lastRunAtMs: null,
      nextRunAtMs: dueMs,
    });
    return dueMs;
  }

  it('tick twice → exactly 1 job per schedule', async () => {
    const dueMs = seedDueSchedule();
    const expectedKey = scheduleDedupKey(SCHED_ID, new Date(dueMs));

    const first = await tickScheduler(new Date());
    const second = await tickScheduler(new Date());

    expect(first).toBe(1);
    expect(second).toBe(0); // idempotent: the window already fired

    const fired = [...hoisted.jobs.values()].filter((j) => j.type === 'scheduled_trigger');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.dedupKey).toBe(expectedKey);
    expect(fired[0]!.payload).toMatchObject({ scheduleId: SCHED_ID, workflowId: WORKFLOW_ID });
  });
});

// ── 4. Retry exhaustion ──────────────────────────────────────────────────────

describe('retry exhaustion', () => {
  const retryableErr = () => Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });

  // Models the contract's `failed → pending (retry)` transition between
  // attempts. DESIGN GAP (flagged to parent): the implementation exposes this
  // transition only through manual POST /api/jobs/[id]/retry — no automatic
  // sweeper re-drives 'failed' jobs, so a handler-thrown retryable error parks
  // in 'failed' (with an inert backoff) until an operator replays it. The
  // counting/terminal logic below is what bounds the retries when replays
  // happen; the crash-loop test after it covers the fully automatic path.
  function requeueForRetry(id: string): void {
    const j = storeJob(id);
    j.status = 'pending';
    j.nextRunAtMs = Date.now();
  }

  it('retryable failures accumulate attempts; the maxAttempts-th failure dead-letters (not infinite)', async () => {
    const enqueued = (await hoisted.enqueueJob(AUTH, {
      type: 'webhook',
      payload: { url: 'https://example.com/hook' },
      maxAttempts: 3,
    })) as unknown as Job;

    const statuses: string[] = [];
    for (let round = 1; round <= 3; round++) {
      const workerId = `w-exh-${round}`;
      const claimedRaw = await hoisted.claimJob(workerId);
      expect(claimedRaw).not.toBeNull();
      const claimed = claimedRaw as unknown as Job;
      await hoisted.startJob(AUTH, claimed.id, workerId);
      // The real worker path: classify the throw, then failJob decides.
      const jobError = classifyError(retryableErr());
      expect(jobError.retryable).toBe(true);
      await hoisted.failJob(AUTH, claimed.id, jobError, jobError.retryable, workerId);
      statuses.push(storeJob(claimed.id).status);
      if (round < 3) requeueForRetry(claimed.id);
    }

    // attempts 1,2 → 'failed' (retryable, budget left); attempt 3 → terminal.
    expect(statuses).toEqual(['failed', 'failed', 'dead_letter']);
    const final = storeJob(enqueued.id);
    expect(final.attempts).toBe(3);
    expect(final.errorCode).toBe('ETIMEDOUT');
  });

  it('crash-loop exhaustion: repeated reaps then a final retryable failure → dead_letter; the worker never picks it up again', async () => {
    let invocations = 0;
    const enqueued = (await hoisted.enqueueJob(AUTH, {
      type: 'email',
      payload: {},
      maxAttempts: 3,
    })) as unknown as Job;

    // Two crash cycles through the REAL reaper: attempts → 2.
    for (const w of ['w-c1', 'w-c2']) {
      const crashedRaw = await hoisted.claimJob(w);
      expect(crashedRaw).not.toBeNull();
      const crashed = crashedRaw as unknown as Job;
      await hoisted.startJob(AUTH, crashed.id, w);
      ageHeartbeat(crashed.id, 120_000); // worker dies mid-execution
      expect(await reapStaleJobs(60_000)).toBe(1);
    }
    expect(storeJob(enqueued.id).attempts).toBe(2);

    // Third execution: the handler actually runs and throws retryable.
    // attempts 2+1 = 3 >= maxAttempts → dead_letter (terminal, not infinite).
    const lastRaw = await hoisted.claimJob('w-c3');
    const last = lastRaw as unknown as Job;
    await hoisted.startJob(AUTH, last.id, 'w-c3');
    const jobError = classifyError(retryableErr());
    await hoisted.failJob(AUTH, last.id, jobError, jobError.retryable, 'w-c3');
    expect(storeJob(enqueued.id).status).toBe('dead_letter');
    expect(storeJob(enqueued.id).attempts).toBe(3);

    // End-to-end proof via the REAL worker loop: a dead_letter job is never
    // claimed again — the loop polls, finds nothing due, handler never runs.
    registerHandler('email', async () => {
      invocations += 1;
    });
    const runPromise = runWorker({ workerId: 'w-exh-watch', pollIntervalMs: 5 });
    await sleep(80);
    expect(invocations).toBe(0);
    expect(storeJob(enqueued.id).status).toBe('dead_letter');
    process.emit('SIGINT');
    await runPromise;
  });
});

// ── 5. Non-retryable fast-fail ───────────────────────────────────────────────

describe('non-retryable fast-fail', () => {
  it('validation error → dead_letter immediately with attempts = 1', async () => {
    let invocations = 0;
    const enqueued = (await hoisted.enqueueJob(AUTH, {
      type: 'email',
      payload: { to: 'not-an-email' },
    })) as unknown as Job;

    registerHandler('email', async () => {
      invocations += 1;
      throw Object.assign(new Error('invalid payload'), { code: 'VALIDATION_ERROR' });
    });

    const runPromise = runWorker({ workerId: 'w-fastfail', pollIntervalMs: 5 });
    await waitFor(() => storeJob(enqueued.id).status === 'dead_letter');
    await sleep(60); // still polling: must not retry a non-retryable error
    expect(invocations).toBe(1);
    process.emit('SIGINT');
    await runPromise;

    const final = storeJob(enqueued.id);
    expect(final.status).toBe('dead_letter');
    expect(final.attempts).toBe(1);
    expect(final.errorCode).toBe('VALIDATION_ERROR');
  });
});

// ── 6. Crash after side effect ───────────────────────────────────────────────
// NOTE: the implementation has no automatic re-drive for handler-thrown
// retryable errors ('failed' waits for manual replay — see the design gap
// flagged in §4), so this scenario uses the fully automatic crash path:
// side effect → worker dies → reaper → re-execution.

describe('crash after side effect', () => {
  it('side effect then crash → reaper → retry skips the duplicate write (idempotency via dedupKey)', async () => {
    let invocations = 0;
    // Models an idempotent sink (e.g. INSERT ... ON CONFLICT on the dedup
    // key): the write is a no-op when the key was already recorded.
    const writeLog: string[] = [];
    const enqueued = (await hoisted.enqueueJob(AUTH, {
      type: 'email',
      payload: { to: 'billing@example.com' },
      dedupKey: 'side-effect-1',
    })) as unknown as Job;

    const handler = async (ctx: { job: Job }) => {
      invocations += 1;
      const key = ctx.job.dedupKey ?? ctx.job.id;
      if (!writeLog.includes(key)) writeLog.push(key); // the side effect
    };

    // Phase 1 — claim → start → handler performs the side effect → CRASH
    // (the process dies before complete; the write already happened).
    const crashedRaw = await hoisted.claimJob('worker-crash');
    const crashed = crashedRaw as unknown as Job;
    await hoisted.startJob(buildJobAuthorization(crashed), crashed.id, 'worker-crash');
    await handler({ job: crashed });
    expect(writeLog).toEqual(['side-effect-1']);
    ageHeartbeat(crashed.id, 120_000);

    // Phase 2 — the REAL reaper releases the stale claim…
    expect(await reapStaleJobs(60_000)).toBe(1);
    expect(storeJob(crashed.id).status).toBe('pending');

    // …and the REAL worker re-executes: the handler sees the dedupKey already
    // recorded, skips the duplicate write, and completes normally.
    registerHandler('email', handler);
    const runPromise = runWorker({ workerId: 'w-sidefx', pollIntervalMs: 5 });
    await waitFor(() => storeJob(enqueued.id).status === 'succeeded');
    process.emit('SIGINT');
    await runPromise;

    // At-least-once delivery (2 handler invocations) with exactly-once effect.
    expect(invocations).toBe(2);
    expect(writeLog).toEqual(['side-effect-1']);
    expect(storeJob(enqueued.id).attempts).toBe(1); // the abandoned attempt counted
  });
});

// ── 7. Stale heartbeat ──────────────────────────────────────────────────────

describe('stale heartbeat', () => {
  it('claimed job with old heartbeat → reaped to pending with attempts + 1; fresh claims untouched', async () => {
    const stale = (await hoisted.enqueueJob(AUTH, {
      type: 'cleanup',
      payload: {},
    })) as unknown as Job;
    const fresh = (await hoisted.enqueueJob(AUTH, {
      type: 'cleanup',
      payload: {},
    })) as unknown as Job;

    await hoisted.claimJob('worker-old');
    await hoisted.startJob(AUTH, stale.id, 'worker-old');
    await hoisted.claimJob('worker-new');
    await hoisted.startJob(AUTH, fresh.id, 'worker-new');

    ageHeartbeat(stale.id, 120_000); // heartbeat died 2 minutes ago
    // fresh keeps a live heartbeat (just claimed above)

    const reaped = await reapStaleJobs(60_000);

    expect(reaped).toBe(1);
    const staleRow = storeJob(stale.id);
    expect(staleRow.status).toBe('pending');
    expect(staleRow.attempts).toBe(1);
    expect(staleRow.claimedBy).toBeNull();
    expect(staleRow.heartbeatAtMs).toBeNull();
    expect(staleRow.errorCode).toBe('STALE_CLAIM');

    const freshRow = storeJob(fresh.id);
    expect(freshRow.status).toBe('running');
    expect(freshRow.attempts).toBe(0);
    expect(freshRow.claimedBy).toBe('worker-new');
  });
});

// ── 8. Graceful shutdown ─────────────────────────────────────────────────────

describe('graceful shutdown', () => {
  it('SIGTERM with in-flight job → claim released to pending: not lost, not duplicated, no attempt burned', async () => {
    let started = 0;
    const enqueued = (await hoisted.enqueueJob(AUTH, {
      type: 'webhook',
      payload: { url: 'https://example.com/slow' },
    })) as unknown as Job;

    registerHandler('webhook', async () => {
      started += 1;
      await new Promise(() => {}); // ignores the abort signal: never resolves
    });

    const runPromise = runWorker({
      workerId: 'w-shutdown',
      pollIntervalMs: 5,
      heartbeatIntervalMs: 10_000,
      shutdownTimeoutMs: 150,
    });
    await waitFor(() => started === 1);
    process.emit('SIGTERM');
    await runPromise;

    // The real releaseClaim path ran: pending, claim cleared, attempts intact.
    const released = storeJob(enqueued.id);
    expect(released.status).toBe('pending');
    expect(released.claimedBy).toBeNull();
    expect(released.heartbeatAtMs).toBeNull();
    expect(released.attempts).toBe(0); // shutdown burns no attempt

    // Not lost: another worker picks the SAME job up again…
    const reclaimed = (await hoisted.claimJob('w-shutdown-2')) as unknown as Job;
    expect(reclaimed.id).toBe(enqueued.id);
    // …and there is still exactly one row: no duplication.
    expect(hoisted.jobs.size).toBe(1);
  });
});

// ── DB-gated: properties only real Postgres can prove ────────────────────────
// Skipped locally (no branch env vars); runs on CI against an ephemeral Neon
// branch. These do not go through the mocked modules above — they use a real
// owner Pool and the real SECURITY DEFINER worker-plane functions.

const dbReady = DB_READY;

describe.skipIf(!dbReady)('failure resilience (live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  let orgId = '';

  beforeAll(async () => {
    if (!dbReady) return;
    orgId = await mkOrg(owner, `fr-${RUN}`);
  }, 30_000);

  afterEach(async () => {
    if (!dbReady) return;
    await owner.query(`delete from public.jobs where org_id = $1::uuid`, [orgId]);
  });

  afterAll(async () => {
    await owner.end();
  });

  it('concurrent duplicate inserts arbitrate to exactly one job row (23505)', async () => {
    const dedup = `fr-dup-${RUN}`;
    const insert = () =>
      owner.query(
        `insert into public.jobs (org_id, type, payload, dedup_key)
         values ($1::uuid, 'email', '{}'::jsonb, $2) returning id`,
        [orgId, dedup],
      );
    const results = await Promise.allSettled([insert(), insert()]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser's 23505 is exactly what the real enqueueJob catches to
    // return the winner's row (queue.ts isDedupConflict).
    expect((rejected[0] as PromiseRejectedResult).reason?.code).toBe('23505');

    const { rows } = await owner.query<{ n: string }>(
      `select count(*) n from public.jobs where org_id = $1::uuid and dedup_key = $2`,
      [orgId, dedup],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('the real reaper function reaps only stale claimed/running jobs', async () => {
    const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const freshAt = new Date().toISOString();
    const ins = await owner.query<{ id: string; status: string }>(
      `insert into public.jobs
         (org_id, type, status, payload, claimed_by, claimed_at, heartbeat_at)
       values
         ($1::uuid, 'email', 'claimed', '{}'::jsonb, 'w-old', now(), $2::timestamptz),
         ($1::uuid, 'email', 'running', '{}'::jsonb, 'w-fresh', now(), $3::timestamptz),
         ($1::uuid, 'email', 'pending', '{}'::jsonb, null, null, $2::timestamptz)
       returning id, status`,
      [orgId, staleAt, freshAt],
    );
    const [staleClaimed, freshRunning, pendingStale] = ins.rows;

    // The REAL worker-plane path: SECURITY DEFINER public.jobs_reap_stale
    // (migration 0049), exactly as reapStaleJobs() calls it. The count is
    // cross-org by design, so assert >= 1 and pin this org's rows exactly.
    const { rows: fnRows } = await owner.query<{ jobs_reap_stale: string }>(
      `select public.jobs_reap_stale(60000)::text as jobs_reap_stale`,
    );
    expect(Number(fnRows[0]!.jobs_reap_stale)).toBeGreaterThanOrEqual(1);

    const { rows } = await owner.query<{
      id: string;
      status: string;
      attempts: string;
      error_code: string | null;
      claimed_by: string | null;
    }>(
      `select id, status, attempts::text, error_code, claimed_by
         from public.jobs where org_id = $1::uuid`,
      [orgId],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));

    const reaped = byId.get(staleClaimed!.id)!;
    expect(reaped.status).toBe('pending');
    expect(Number(reaped.attempts)).toBe(1); // the abandoned attempt counts
    expect(reaped.error_code).toBe('STALE_CLAIM');
    expect(reaped.claimed_by).toBeNull();

    const fresh = byId.get(freshRunning!.id)!;
    expect(fresh.status).toBe('running'); // fresh heartbeat: untouched

    const pend = byId.get(pendingStale!.id)!;
    expect(pend.status).toBe('pending'); // wrong status: untouched
    expect(pend.error_code).toBeNull();
  });
});
