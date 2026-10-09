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
 *   - runWorker in-loop stale reap (Phase 12, F-12-02): reapStaleJobs fires
 *     on the reapIntervalMs cadence, 0 disables it, reap ticks never block
 *     claiming. The runner.ts startup reap and the live-DB reap semantics
 *     live in tests/jobs/reaper-live.test.ts
 *   - runWorker adaptive idle poll (Phase 12, F-12-04): the sleep after an
 *     empty claim backs off geometrically from pollIntervalMs to the
 *     pollMaxIdleMs ceiling and resets to pollIntervalMs on any claimed job
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
import type { JobExecutionContext, WorkerConfig } from '@/lib/jobs/worker';

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

// ── runWorker in-loop stale reap (Phase 12, F-12-02) ────────────────────────

describe('runWorker in-loop stale reap', () => {
  it('reaps on the reapIntervalMs cadence through the 0049 definer (60s default threshold)', async () => {
    registerHandler('email', async () => {});
    vi.mocked(claimJob).mockResolvedValue(null);

    const runPromise = runWorker({ workerId: 'w-reap', pollIntervalMs: 10, reapIntervalMs: 30 });
    await sleep(120);
    process.emit('SIGINT');
    await runPromise;

    // The mocked drizzle records every worker-plane statement; on an idle
    // loop the only statements are reaps. Each goes through the SECURITY
    // DEFINER with the default 60s staleness threshold — never a raw UPDATE.
    const reaps = hoisted.executed.filter((s) => s.sql.includes('jobs_reap_stale'));
    expect(reaps.length).toBeGreaterThanOrEqual(1);
    for (const reap of reaps) {
      expect(reap.sql).not.toMatch(/update\s+public\.jobs/i);
      expect(reap.params).toEqual([60_000]);
    }
    expect(startJob).not.toHaveBeenCalled();
  });

  it('reapIntervalMs 0 disables the in-loop reap', async () => {
    registerHandler('email', async () => {});
    vi.mocked(claimJob).mockResolvedValue(null);

    const runPromise = runWorker({ workerId: 'w-noreap', pollIntervalMs: 10, reapIntervalMs: 0 });
    await sleep(100);
    process.emit('SIGINT');
    await runPromise;

    expect(hoisted.executed.filter((s) => s.sql.includes('jobs_reap_stale'))).toHaveLength(0);
  });

  it('the loop keeps claiming after in-loop reaps fire (reap ticks never block claims)', async () => {
    registerHandler('email', async () => {});
    // Claim nothing for the first few polls (reap ticks fire meanwhile),
    // then hand over a job: it must still be claimed and completed. The
    // reap call itself is wrapped in the same swallow-on-error posture as
    // the retry sweep (`.catch(() => undefined)` at the call site), so a
    // DB blip during a reap cannot kill the loop either.
    vi.mocked(claimJob)
      .mockResolvedValue(null)
      .mockResolvedValue(null)
      .mockResolvedValue(null)
      .mockResolvedValue(null)
      .mockResolvedValue(null)
      .mockResolvedValueOnce(fakeJob())
      .mockResolvedValue(null);

    const runPromise = runWorker({
      workerId: 'w-reapsurvive',
      pollIntervalMs: 10,
      reapIntervalMs: 25,
    });
    await sleep(150);
    process.emit('SIGINT');
    await runPromise;

    expect(hoisted.executed.some((s) => s.sql.includes('jobs_reap_stale'))).toBe(true);
    expect(completeJob).toHaveBeenCalledTimes(1);
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

// ── runWorker adaptive idle poll (Phase 12, F-12-04) ─────────────────────────

describe('runWorker adaptive idle poll', () => {
  const gapsBetween = (stamps: number[]): number[] => stamps.slice(1).map((t, i) => t - stamps[i]!);

  /** Run a worker whose claims are scripted by `claim`, recording claim times. */
  async function observeClaims(
    config: Partial<WorkerConfig>,
    observeMs: number,
    claim: () => Promise<Job | null>,
    stamps: number[],
  ): Promise<void> {
    vi.mocked(claimJob).mockImplementation(async () => {
      stamps.push(Date.now());
      return claim();
    });
    const runPromise = runWorker({
      workerId: 'w-idle-poll',
      reapIntervalMs: 0,
      retrySweepIntervalMs: 0,
      ...config,
    });
    await sleep(observeMs);
    process.emit('SIGINT');
    await runPromise;
  }

  it('backs off geometrically from pollIntervalMs to the pollMaxIdleMs ceiling', async () => {
    registerHandler('email', async () => {});
    const stamps: number[] = [];
    // Sleeps: 25, 50, 100, 200, 200, … — ~7 claims in the window, where
    // fixed 25 ms polling would claim ~38 times.
    await observeClaims({ pollIntervalMs: 25, pollMaxIdleMs: 200 }, 950, async () => null, stamps);

    const gaps = gapsBetween(stamps);
    expect(gaps.length).toBeGreaterThanOrEqual(5);
    expect(stamps.length).toBeLessThanOrEqual(10);
    // Starts at the base interval, then doubles (within timer tolerance).
    expect(gaps[0]).toBeGreaterThanOrEqual(15);
    expect(gaps[0]).toBeLessThanOrEqual(80);
    expect(gaps[1]).toBeGreaterThanOrEqual(gaps[0]! + 8);
    expect(gaps[2]).toBeGreaterThanOrEqual(gaps[1]! + 20);
    // Reaches the ceiling and never sleeps past it.
    expect(gaps[3]).toBeGreaterThanOrEqual(140);
    for (const gap of gaps) expect(gap).toBeLessThanOrEqual(320);
    expect(gaps[gaps.length - 1]).toBeGreaterThanOrEqual(150);
    expect(startJob).not.toHaveBeenCalled();
  });

  it('holds the ceiling over a long idle (no drift back, no overshoot)', async () => {
    registerHandler('email', async () => {});
    const stamps: number[] = [];
    // Sleeps: 20, 40, 60, 60, 60, … — ~22 claims in the window, where
    // fixed 20 ms polling would claim ~60 times.
    await observeClaims({ pollIntervalMs: 20, pollMaxIdleMs: 60 }, 1200, async () => null, stamps);

    const gaps = gapsBetween(stamps);
    expect(stamps.length).toBeLessThanOrEqual(30);
    expect(gaps.length).toBeGreaterThanOrEqual(12);
    expect(gaps[0]).toBeLessThanOrEqual(45); // started at the base interval
    for (const gap of gaps) expect(gap).toBeLessThanOrEqual(110); // capped at 60 + slack
    // Settled at the ceiling: the tail gaps are neither the base interval
    // (backoff lost) nor above the ceiling (backoff unbounded).
    for (const gap of gaps.slice(-5)) {
      expect(gap).toBeGreaterThanOrEqual(45);
      expect(gap).toBeLessThanOrEqual(110);
    }
  });

  it('resets the idle sleep to pollIntervalMs on any claimed job', async () => {
    registerHandler('email', async () => {});
    const stamps: number[] = [];
    let calls = 0;
    // Four empty claims drive the backoff deep (sleeps 25, 50, 100, 200 —
    // the next would be the 400 ceiling); the fifth claim returns a job.
    await observeClaims(
      { pollIntervalMs: 25, pollMaxIdleMs: 400 },
      1000,
      async () => {
        calls += 1;
        return calls === 5 ? fakeJob() : null;
      },
      stamps,
    );

    expect(completeJob).toHaveBeenCalledTimes(1);
    const gaps = gapsBetween(stamps);
    // Proof the worker really was deep in backoff before the claim…
    expect(gaps[3]).toBeGreaterThanOrEqual(140);
    // …claimed the next job immediately after executing (no sleep inserted)…
    expect(gaps[4]).toBeLessThanOrEqual(60);
    // …and the first idle sleep after the job is the base interval again,
    // not the 400 ms the backoff had grown to.
    expect(gaps[5]).toBeGreaterThanOrEqual(12);
    expect(gaps[5]).toBeLessThanOrEqual(110);
  });

  it('a pollMaxIdleMs below pollIntervalMs never shortens the base interval', async () => {
    registerHandler('email', async () => {});
    const stamps: number[] = [];
    await observeClaims({ pollIntervalMs: 40, pollMaxIdleMs: 10 }, 320, async () => null, stamps);

    const gaps = gapsBetween(stamps);
    expect(gaps.length).toBeGreaterThanOrEqual(5);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(28);
      expect(gap).toBeLessThanOrEqual(95);
    }
  });
});
