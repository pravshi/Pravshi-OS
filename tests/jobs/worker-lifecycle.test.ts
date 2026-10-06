/**
 * Phase 6 Worker Runtime — lifecycle unit tests.
 *
 * DB-free: the queue module, the pool connector, and the drizzle client are
 * mocked. What is really exercised:
 *   - the handler registry (register / duplicate / unknown type)
 *   - the §3.6 system-actor Authorization builder
 *   - reapStaleJobs: SECURITY DEFINER function call (jobs_reap_stale), bound
 *     threshold, threshold validation, count return
 *   - releaseClaim / applyRetryBackoff: SECURITY DEFINER function calls
 *     (jobs_release_claim, jobs_apply_backoff — migration 0050), bound job
 *     id / worker id / absolute due time, never a raw UPDATE
 *   - runWorker: claim → start → execute → complete, failure → failJob +
 *     backoff, unregistered type → CONFIG_ERROR dead-letter, claim errors and
 *     handler throws never crash the loop, SIGTERM/SIGINT graceful shutdown
 *     (idle, in-flight, and uncooperative-handler timeout → claim release)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  executed: [] as Array<{ sql: string; params: unknown[] }>,
  releaseClient: vi.fn(),
}));

vi.mock('@/lib/jobs/queue', () => ({
  claimJob: vi.fn(async () => null),
  startJob: vi.fn(async () => undefined),
  completeJob: vi.fn(async () => undefined),
  failJob: vi.fn(async () => undefined),
  heartbeatJob: vi.fn(async () => undefined),
}));

vi.mock('@/lib/db/pool', () => ({
  connectWithWake: vi.fn(async () => ({ release: hoisted.releaseClient })),
}));

vi.mock('drizzle-orm/neon-serverless', () => ({
  drizzle: () => ({
    transaction: async (
      fn: (tx: { execute: (q: unknown) => Promise<{ rowCount: number }> }) => Promise<unknown>,
    ) =>
      fn({
        execute: async (q: unknown) => {
          const queryable = q as {
            toQuery: (cfg: Record<string, unknown>) => { sql: string; params: unknown[] };
          };
          const rendered = queryable.toQuery({
            casing: undefined,
            escapeName: (name: string) => `"${name}"`,
            escapeParam: (index: number) => `$${index + 1}`,
            escapeString: (str: string) => `'${str}'`,
          });
          hoisted.executed.push({ sql: rendered.sql, params: rendered.params });
          // The reaper reads Number(rows[0].reaped); mirror that shape.
          return { rows: [{ reaped: '1' }], rowCount: 1 };
        },
      }),
  }),
}));

import {
  buildJobAuthorization,
  reapStaleJobs,
  registerHandler,
  resetHandlerRegistry,
  runWorker,
  SYSTEM_ACTOR_ID,
} from '@/lib/jobs/worker';
import { claimJob, completeJob, failJob, heartbeatJob, startJob } from '@/lib/jobs/queue';
import type { Job } from '@/lib/jobs/types';
import type { JobExecutionContext } from '@/lib/jobs/worker';

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const JOB_A = '22222222-2222-4222-8222-222222222222';
const JOB_B = '33333333-3333-4333-8333-333333333333';

function fakeJob(overrides: Partial<Job> = {}): Job {
  const now = new Date().toISOString();
  return {
    id: JOB_A,
    orgId: ORG_ID,
    type: 'email',
    status: 'claimed',
    priority: 0,
    payload: {},
    attempts: 0,
    maxAttempts: 5,
    nextRunAt: now,
    claimedBy: 'test-worker',
    claimedAt: now,
    heartbeatAt: now,
    dedupKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  resetHandlerRegistry();
  vi.clearAllMocks();
  hoisted.executed.length = 0;
});

// ── Registry ────────────────────────────────────────────────────────────────

describe('registerHandler', () => {
  it('registers a handler for a job type', () => {
    expect(() => registerHandler('email', async () => {})).not.toThrow();
  });

  it('throws on duplicate registration', () => {
    registerHandler('email', async () => {});
    expect(() => registerHandler('email', async () => {})).toThrow(/already registered/);
  });

  it('throws on unknown job type', () => {
    expect(() => registerHandler('not_a_type' as 'email', async () => {})).toThrow(
      /unknown job type/,
    );
  });

  it('resetHandlerRegistry allows re-registration', () => {
    registerHandler('email', async () => {});
    resetHandlerRegistry();
    expect(() => registerHandler('email', async () => {})).not.toThrow();
  });
});

// ── §3.6 system-actor Authorization ──────────────────────────────────────────

describe('buildJobAuthorization', () => {
  it('takes orgId from the job row', () => {
    const auth = buildJobAuthorization(fakeJob({ orgId: ORG_ID }));
    expect(auth.ctx.orgId).toBe(ORG_ID);
  });

  it('runs as the system actor, not a real person', () => {
    const auth = buildJobAuthorization(fakeJob());
    expect(auth.ctx.personId).toBe(SYSTEM_ACTOR_ID);
    expect(auth.ctx.personId).not.toBe('11111111-1111-4111-8111-111111111111');
    expect(auth.permission).toBe('jobs.retry');
    expect(auth.requestId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

// ── runWorker lifecycle (mocked queue) ───────────────────────────────────────

describe('runWorker', () => {
  it('claims → starts → executes → completes with org-scoped auth and live signal', async () => {
    const handler = vi.fn(async (ctx: JobExecutionContext) => {
      expect(ctx.job.id).toBe(JOB_A);
    });
    registerHandler('email', handler);
    vi.mocked(claimJob).mockResolvedValueOnce(fakeJob()).mockResolvedValue(null);

    const runPromise = runWorker({ workerId: 'w-1', pollIntervalMs: 10 });
    await sleep(80);
    process.emit('SIGINT');
    await runPromise;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(startJob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startJob).mock.calls[0]![1]).toBe(JOB_A);
    expect(completeJob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(completeJob).mock.calls[0]![1]).toBe(JOB_A);

    const ctx = handler.mock.calls[0]![0]!;
    expect(ctx.job.id).toBe(JOB_A);
    expect(ctx.auth.ctx.orgId).toBe(ORG_ID);
    expect(ctx.auth.ctx.personId).toBe(SYSTEM_ACTOR_ID);
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps the heartbeat alive during a long handler execution', async () => {
    registerHandler('email', async () => {
      await sleep(90);
    });
    vi.mocked(claimJob).mockResolvedValueOnce(fakeJob()).mockResolvedValue(null);

    const runPromise = runWorker({
      workerId: 'w-hb',
      pollIntervalMs: 10,
      heartbeatIntervalMs: 25,
    });
    await sleep(140);
    process.emit('SIGINT');
    await runPromise;

    expect(vi.mocked(heartbeatJob).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(vi.mocked(heartbeatJob).mock.calls[0]!).toEqual(['w-hb', JOB_A]);
    expect(completeJob).toHaveBeenCalledTimes(1);
  });

  it('handler throw → failJob retryable + backoff, and the loop survives to the next job', async () => {
    registerHandler('email', async (ctx) => {
      if (ctx.job.id === JOB_A) {
        throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      }
    });
    vi.mocked(claimJob)
      .mockResolvedValueOnce(fakeJob({ id: JOB_A, attempts: 2 }))
      .mockResolvedValueOnce(fakeJob({ id: JOB_B }))
      .mockResolvedValue(null);

    const runPromise = runWorker({ workerId: 'w-2', pollIntervalMs: 10 });
    await sleep(80);
    process.emit('SIGINT');
    await runPromise;

    // Failed job: retryable classification, attempts(2)+1 < maxAttempts(5) → failed path
    expect(failJob).toHaveBeenCalledTimes(1);
    const failCall = vi.mocked(failJob).mock.calls[0]!;
    expect(failCall[1]).toBe(JOB_A);
    expect(failCall[3]).toBe(true);
    expect(failCall[2].code).toBe('ETIMEDOUT');
    expect(failCall[2].retryable).toBe(true);

    // Backoff applied: SECURITY DEFINER jobs_apply_backoff (migration 0050)
    // with the absolute due time next_run_at = now + backoffDelayMs(2) ∈
    // [4000, 5000)ms. Never a raw UPDATE against the FORCED-RLS jobs table.
    const backoff = hoisted.executed.find((s) => s.sql.includes('jobs_apply_backoff'));
    expect(backoff).toBeDefined();
    expect(backoff!.sql).not.toMatch(/update\s+jobs/i);
    expect(backoff!.params[0]).toBe(JOB_A);
    const dueIn = Number(backoff!.params[1]) - Date.now();
    expect(dueIn).toBeGreaterThanOrEqual(3900); // ms of slack for test time
    expect(dueIn).toBeLessThan(5100);

    // The loop did NOT crash: the second job completed normally.
    expect(completeJob).toHaveBeenCalledTimes(1);
    expect(vi.mocked(completeJob).mock.calls[0]![1]).toBe(JOB_B);
  });

  it('non-retryable handler throw → dead_letter without backoff', async () => {
    registerHandler('email', async () => {
      throw Object.assign(new Error('bad input'), { code: 'VALIDATION_ERROR' });
    });
    vi.mocked(claimJob).mockResolvedValueOnce(fakeJob()).mockResolvedValue(null);

    const runPromise = runWorker({ workerId: 'w-3', pollIntervalMs: 10 });
    await sleep(80);
    process.emit('SIGINT');
    await runPromise;

    expect(failJob).toHaveBeenCalledTimes(1);
    const failCall = vi.mocked(failJob).mock.calls[0]!;
    expect(failCall[3]).toBe(false);
    expect(failCall[2].retryable).toBe(false);
    expect(hoisted.executed).toHaveLength(0); // no backoff SQL for dead-letter path
    expect(completeJob).not.toHaveBeenCalled();
  });

  it('unregistered job type → CONFIG_ERROR dead-letter, worker keeps running', async () => {
    registerHandler('webhook', async () => {});
    vi.mocked(claimJob)
      .mockResolvedValueOnce(fakeJob({ type: 'email' }))
      .mockResolvedValue(null);

    const runPromise = runWorker({ workerId: 'w-4', pollIntervalMs: 10 });
    await sleep(80);
    process.emit('SIGINT');
    await runPromise;

    expect(failJob).toHaveBeenCalledTimes(1);
    const failCall = vi.mocked(failJob).mock.calls[0]!;
    expect(failCall[2].code).toBe('CONFIG_ERROR');
    expect(failCall[3]).toBe(false);
    expect(startJob).not.toHaveBeenCalled();
  });

  it('a claimJob rejection never kills the worker', async () => {
    registerHandler('email', async () => {});
    vi.mocked(claimJob).mockRejectedValueOnce(new Error('db blip')).mockResolvedValue(null);

    const runPromise = runWorker({ workerId: 'w-5', pollIntervalMs: 10 });
    await sleep(80);
    process.emit('SIGINT');
    await runPromise; // would throw if the claim error escaped the loop

    expect(startJob).not.toHaveBeenCalled();
  });

  it('SIGINT during an in-flight job aborts the signal and waits for completion', async () => {
    let observedSignal: AbortSignal | null = null;
    registerHandler('email', async (ctx) => {
      observedSignal = ctx.signal;
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) return resolve();
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    vi.mocked(claimJob).mockResolvedValueOnce(fakeJob()).mockResolvedValue(null);

    const runPromise = runWorker({
      workerId: 'w-6',
      pollIntervalMs: 10,
      shutdownTimeoutMs: 5000,
    });
    await sleep(60);
    expect(observedSignal).not.toBeNull();
    expect(observedSignal!.aborted).toBe(false);
    process.emit('SIGINT');
    await runPromise;

    expect(observedSignal!.aborted).toBe(true);
    expect(completeJob).toHaveBeenCalledTimes(1);
    expect(hoisted.executed).toHaveLength(0); // no claim release: the job finished in time
  });

  it('SIGINT while idle resolves without doing work', async () => {
    registerHandler('email', async () => {});
    vi.mocked(claimJob).mockResolvedValue(null);

    const runPromise = runWorker({ workerId: 'w-7', pollIntervalMs: 50 });
    process.emit('SIGINT');
    await runPromise;

    expect(claimJob).toHaveBeenCalled();
    expect(startJob).not.toHaveBeenCalled();
  });

  it('shutdown timeout releases the claim of a handler that ignores the abort', async () => {
    let observedSignal: AbortSignal | null = null;
    registerHandler('email', async (ctx) => {
      observedSignal = ctx.signal;
      await new Promise(() => {}); // never resolves, ignores abort
    });
    vi.mocked(claimJob).mockResolvedValueOnce(fakeJob()).mockResolvedValue(null);

    const runPromise = runWorker({
      workerId: 'w-8',
      pollIntervalMs: 10,
      shutdownTimeoutMs: 120,
    });
    await sleep(60);
    process.emit('SIGINT');
    await runPromise;

    expect(observedSignal!.aborted).toBe(true);
    // SECURITY DEFINER jobs_release_claim (migration 0050), never a raw
    // UPDATE against the FORCED-RLS jobs table.
    const release = hoisted.executed.find((s) => s.sql.includes('jobs_release_claim'));
    expect(release).toBeDefined();
    expect(release!.sql).not.toMatch(/update\s+jobs/i);
    expect(release!.params).toContain(JOB_A); // guarded to this job's id
    expect(release!.params).toContain('w-8'); // and to this worker's claim
    expect(completeJob).not.toHaveBeenCalled();
  });
});

// ── reapStaleJobs (mocked db) ───────────────────────────────────────────────

describe('reapStaleJobs', () => {
  it('calls the SECURITY DEFINER reaper with the bound threshold (never a raw UPDATE)', async () => {
    const count = await reapStaleJobs(90_000);

    expect(count).toBe(1);
    expect(hoisted.executed).toHaveLength(1);
    const stmt = hoisted.executed[0]!;
    expect(stmt.sql).toContain('jobs_reap_stale');
    expect(stmt.sql).not.toMatch(/update\s+public\.jobs/i);
    expect(stmt.sql).not.toMatch(/update\s+jobs/i);
    expect(stmt.params).toEqual([90_000]);
  });

  it('uses the 60s default threshold', async () => {
    await reapStaleJobs();
    expect(hoisted.executed).toHaveLength(1);
    expect(hoisted.executed[0]!.sql).toContain('jobs_reap_stale');
    expect(hoisted.executed[0]!.params).toEqual([60_000]);
  });

  it('rejects an invalid threshold', async () => {
    await expect(reapStaleJobs(-1)).rejects.toThrow(/thresholdMs/);
    await expect(reapStaleJobs(NaN)).rejects.toThrow(/thresholdMs/);
    expect(hoisted.executed).toHaveLength(0);
  });
});
