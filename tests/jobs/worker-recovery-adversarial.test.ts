/**
 * Phase 12 Wave J (adversarial) — worker crash-recovery composition.
 *
 * Wave B pinned the pieces separately: the in-loop reap fires on cadence
 * (worker-lifecycle.test.ts), the startup reap runs before the first claim
 * (runner.ts wiring), the 0049 definer's row semantics — a live heartbeat
 * is never reaped, a stale claim is reset with the attempt burned — are
 * proven against real Postgres in tests/jobs/reaper-live.test.ts, and the
 * idle backoff sequence/reset is pinned in the F-12-04 block.
 *
 * This suite attacks the COMPOSITION the pieces make in production:
 *
 *  1. A job claimed and actively heartbeating while in-loop reap ticks
 *     fire around it completes exactly once — the reaper's cadence never
 *     disturbs in-flight work at the wiring level (the definer-level
 *     guarantee that its row is untouched is reaper-live's case 3).
 *  2. Across a simulated restart (worker A stops; a fresh worker B starts
 *     the way runner.ts starts it), the startup reap is recorded BEFORE
 *     B's first claim — the ordering that makes a dead predecessor's work
 *     recoverable immediately instead of one reap interval later.
 *  3. A stale claim freed by a reap while the worker sits in DEEP idle
 *     backoff is claimed within the backoff ceiling — backoff delays the
 *     claim by at most pollMaxIdleMs (the F-12-04 contract), it does not
 *     starve reaped work, and claim volume stays bounded meanwhile.
 *  4. reapIntervalMs: 0 disables ONLY the in-loop reap: the loop issues
 *     zero reap statements, while the startup-reap act (an explicit
 *     reapStaleJobs() call, as runner.ts makes) still fires — the two
 *     switches are independent.
 *
 * DB-free in the worker-lifecycle idiom: queue, pool connector and the
 * drizzle client are mocked; the mocked execute records every worker-plane
 * statement, which is what makes reap/claim ordering observable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  executed: [] as Array<{ sql: string; params: unknown[] }>,
  order: [] as string[],
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
          if (rendered.sql.includes('jobs_reap_stale')) hoisted.order.push('reap');
          return { rows: [{ reaped: '1' }], rowCount: 1 };
        },
      }),
  }),
}));

import { reapStaleJobs, registerHandler, resetHandlerRegistry, runWorker } from '@/lib/jobs/worker';
import { claimJob, completeJob, failJob, heartbeatJob, startJob } from '@/lib/jobs/queue';
import type { Job } from '@/lib/jobs/types';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const JOB_A = '22222222-2222-4222-8222-222222222222';

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
const reapStatements = () => hoisted.executed.filter((s) => s.sql.includes('jobs_reap_stale'));

beforeEach(() => {
  resetHandlerRegistry();
  vi.clearAllMocks();
  hoisted.executed.length = 0;
  hoisted.order.length = 0;
});

describe('worker recovery composition (Phase 12 Wave J)', () => {
  it('a heartbeating in-flight job completes exactly once while reap ticks fire around it', async () => {
    registerHandler('email', async () => {
      await sleep(130);
    });
    vi.mocked(claimJob).mockResolvedValueOnce(fakeJob()).mockResolvedValue(null);

    const runPromise = runWorker({
      workerId: 'wj-live',
      pollIntervalMs: 10,
      heartbeatIntervalMs: 20,
      reapIntervalMs: 25,
      retrySweepIntervalMs: 0,
    });
    await sleep(240);
    process.emit('SIGINT');
    await runPromise;

    // The job ran to completion exactly once, undisturbed…
    expect(startJob).toHaveBeenCalledTimes(1);
    expect(completeJob).toHaveBeenCalledTimes(1);
    expect(failJob).not.toHaveBeenCalled();
    // …its heartbeat kept firing the whole execution (the liveness signal
    // the 0049 definer's predicate protects — proven live in reaper-live)…
    expect(vi.mocked(heartbeatJob).mock.calls.length).toBeGreaterThanOrEqual(3);
    // …and reap ticks really did fire on cadence in the same window.
    expect(reapStatements().length).toBeGreaterThanOrEqual(2);
    for (const reap of reapStatements()) {
      expect(reap.params).toEqual([60_000]);
    }
  });

  it('across a restart, the startup reap is recorded before the new worker’s first claim', async () => {
    registerHandler('email', async () => {});

    // Phase 1 — worker A claims and completes a job, then shuts down.
    vi.mocked(claimJob).mockResolvedValueOnce(fakeJob()).mockResolvedValue(null);
    const runA = runWorker({
      workerId: 'wj-a',
      pollIntervalMs: 10,
      reapIntervalMs: 0,
      retrySweepIntervalMs: 0,
    });
    await sleep(70);
    process.emit('SIGINT');
    await runA;
    expect(completeJob).toHaveBeenCalledTimes(1);

    // Phase 2 — the restart, sequenced exactly as runner.ts sequences it:
    // reapStaleJobs() once at startup, THEN runWorker claims. B runs with
    // the in-loop reap disabled so the only reap in the log is the startup
    // act — its position relative to B's first claim is the assertion.
    hoisted.order.length = 0;
    hoisted.executed.length = 0;
    vi.mocked(claimJob).mockClear();
    let bCalls = 0;
    vi.mocked(claimJob).mockImplementation(async () => {
      hoisted.order.push('claim');
      bCalls += 1;
      return bCalls === 1 ? fakeJob() : null;
    });

    await reapStaleJobs();
    const runB = runWorker({
      workerId: 'wj-b',
      pollIntervalMs: 10,
      reapIntervalMs: 0,
      retrySweepIntervalMs: 0,
    });
    await sleep(70);
    process.emit('SIGINT');
    await runB;

    expect(hoisted.order[0]).toBe('reap');
    expect(hoisted.order.indexOf('claim')).toBeGreaterThan(hoisted.order.indexOf('reap'));
    // B did the recovered work: the job it claimed completed (A's
    // completion plus B's = 2 across the restart).
    expect(completeJob).toHaveBeenCalledTimes(2);
  });

  it('a claim freed by a reap during deep idle backoff is claimed within the backoff ceiling', async () => {
    registerHandler('email', async () => {});
    const stamps: number[] = [];
    let calls = 0;
    let successIndex = -1;
    vi.mocked(claimJob).mockImplementation(async () => {
      stamps.push(Date.now());
      calls += 1;
      // The queue stays empty until the in-loop reaper has fired (its
      // statement is in the log) AND the worker is deep in backoff —
      // then the freed claim becomes visible, as it would the moment the
      // 0049 definer resets a stale row to 'pending'.
      const reaped = hoisted.executed.some((s) => s.sql.includes('jobs_reap_stale'));
      if (reaped && calls >= 6 && successIndex === -1) {
        successIndex = stamps.length - 1;
        return fakeJob();
      }
      return null;
    });

    const runPromise = runWorker({
      workerId: 'wj-backoff',
      pollIntervalMs: 25,
      pollMaxIdleMs: 200,
      reapIntervalMs: 30,
      retrySweepIntervalMs: 0,
    });
    await sleep(950);
    process.emit('SIGINT');
    await runPromise;

    expect(reapStatements().length).toBeGreaterThanOrEqual(1);
    expect(completeJob).toHaveBeenCalledTimes(1);
    // Backoff held while idle (fixed 25 ms polling would claim ~35 times)…
    expect(stamps.length).toBeLessThanOrEqual(12);
    // …and the successful claim followed the previous poll by at most the
    // 200 ms ceiling (+ timer slack): reaped work is delayed by the
    // contracted ceiling, never starved past it.
    expect(successIndex).toBeGreaterThanOrEqual(1);
    const successGap = stamps[successIndex]! - stamps[successIndex - 1]!;
    expect(successGap).toBeLessThanOrEqual(320);
  });

  it('reapIntervalMs 0 disables only the in-loop reap — the startup reap still fires on demand', async () => {
    registerHandler('email', async () => {});
    vi.mocked(claimJob).mockResolvedValue(null);

    const runPromise = runWorker({
      workerId: 'wj-noloop',
      pollIntervalMs: 10,
      reapIntervalMs: 0,
      retrySweepIntervalMs: 0,
    });
    await sleep(110);
    process.emit('SIGINT');
    await runPromise;

    expect(reapStatements()).toHaveLength(0);

    // The startup act is a separate, explicit call (runner.ts) — disabling
    // the cadence must not disable it.
    await reapStaleJobs();
    expect(reapStatements()).toHaveLength(1);
    expect(reapStatements()[0]!.params).toEqual([60_000]);
  });
});
