/**
 * REL-11 — the real worker loop (runWorker, deep-sleep mode) reporting to a real liveness
 * watchdog with short budgets. DB-free: the queue, sweeps, maintenance and driver are mocked
 * and every "database touch" is recorded, as in worker-deep-sleep.test.ts.
 *
 * What is proven, end to end through the loop:
 *   - healthy operation (active idle, then a deep sleep far longer than every budget) is
 *     never a stall;
 *   - a job whose handler never settles is detected as stalled — phase 'job', its type only —
 *     and detecting it adds no database traffic;
 *   - a slow but legitimate job (longer than a pass budget, inside the job budget) is not;
 *   - a stalled job that finally returns is reported recovered and completes normally;
 *   - a database outage and overdue work that will not clear are degraded, never stalled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  touches: [] as Array<{ at: number; what: string }>,
}));
const touch = (what: string) => hoisted.touches.push({ at: Date.now(), what });

vi.mock('@/lib/jobs/queue', () => ({
  claimJob: vi.fn(async () => {
    touch('claim');
    return null;
  }),
  startJob: vi.fn(async () => undefined),
  completeJob: vi.fn(async () => undefined),
  failJob: vi.fn(async () => undefined),
  heartbeatJob: vi.fn(async () => undefined),
}));
vi.mock('@/lib/jobs/retry-sweeper', () => ({
  sweepRetryableJobs: vi.fn(async () => {
    touch('retry');
    return 0;
  }),
}));
vi.mock('@/lib/jobs/reminder-sweep', () => ({
  sweepDueTaskReminders: vi.fn(async () => {
    touch('reminders');
    return { claimed: 0, delivered: 0, skipped: 0, failed: 0 };
  }),
}));
vi.mock('@/lib/jobs/maintenance', () => ({
  runDbMaintenance: vi.fn(async () => {
    touch('maintenance');
    return { partitions: null, retention: null };
  }),
  sqlstateOf: () => 'none',
}));
vi.mock('@/lib/db/worker-pool', async () => ({
  connectWorkerWithWake: (await import('@/lib/db/pool')).connectWithWake,
}));
vi.mock('@/lib/db/pool', () => ({
  connectWithWake: vi.fn(async () => ({ release: () => undefined })),
}));
vi.mock('drizzle-orm/neon-serverless', () => ({
  drizzle: () => ({
    transaction: async (fn: (tx: { execute: () => Promise<unknown> }) => Promise<unknown>) =>
      fn({
        execute: async () => {
          touch('reap');
          return { rows: [{ reaped: '0', released: 'true' }], rowCount: 0 };
        },
      }),
  }),
}));

import { registerHandler, resetHandlerRegistry, runWorker } from '@/lib/jobs/worker';
import { WakeLatch } from '@/lib/jobs/wake-latch';
import { LivenessMonitor, type LivenessEvent } from '@/lib/jobs/liveness';
import { claimJob, completeJob } from '@/lib/jobs/queue';
import type { Job } from '@/lib/jobs/types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Short budgets so the suite runs in seconds; the logic is the one production uses.
const BUDGETS = { passMs: 300, maintenanceMs: 300, jobMs: 1_000, graceMs: 200 };
const STALL_AFTER_JOB_MS = BUDGETS.jobMs + BUDGETS.graceMs;

function fakeJob(type: Job['type'] = 'email'): Job {
  const now = new Date().toISOString();
  return {
    id: '22222222-2222-4222-8222-222222222222',
    orgId: '11111111-1111-4111-8111-111111111111',
    type,
    status: 'claimed',
    priority: 0,
    payload: {},
    attempts: 0,
    maxAttempts: 5,
    nextRunAt: now,
    claimedBy: 'w',
    claimedAt: now,
    heartbeatAt: now,
    dedupKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  };
}

function claimsOnce(job: Job) {
  vi.mocked(claimJob)
    .mockImplementationOnce(async () => {
      touch('claim');
      return job;
    })
    .mockImplementation(async () => {
      touch('claim');
      return null;
    });
}

beforeEach(() => {
  hoisted.touches.length = 0;
  resetHandlerRegistry();
  vi.mocked(claimJob).mockReset();
  vi.mocked(claimJob).mockImplementation(async () => {
    touch('claim');
    return null;
  });
  vi.mocked(completeJob).mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function start(nextDueAt: () => Promise<Date | null>) {
  const events: LivenessEvent[] = [];
  const liveness = new LivenessMonitor({
    budgets: BUDGETS,
    checkIntervalMs: 20,
    onEvent: (e) => events.push(e),
  });
  liveness.start();
  const latch = new WakeLatch();
  const run = runWorker({
    workerId: 'w-liveness',
    idleMode: 'deep-sleep',
    pollIntervalMs: 5,
    pollMaxIdleMs: 10,
    // Long enough that a run of claim failures stays inside the active window on a busy machine.
    activeWindowMs: 200,
    maxSleepMs: 60_000,
    shutdownTimeoutMs: 50,
    heartbeatIntervalMs: 15_000,
    wakeLatch: latch,
    schedulerTick: async () => touch('scheduler'),
    nextDueAt,
    liveness,
  });
  const statuses = () =>
    events.flatMap((e) => (e.kind === 'transition' ? [`${e.previous}->${e.status}`] : []));
  return {
    liveness,
    latch,
    events,
    statuses,
    stop: async () => {
      process.emit('SIGINT');
      await run;
      liveness.stop();
    },
  };
}

async function until(cond: () => boolean, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
}

describe('worker loop + liveness watchdog', () => {
  it('healthy: active idle, then a deep sleep far longer than every budget, is never a stall', async () => {
    const w = start(async () => null); // nothing due: sleeps maxSleepMs (60 s)
    await sleep(STALL_AFTER_JOB_MS + 400);
    expect(w.liveness.status()).toBe('ok');
    expect(w.statuses()).toEqual([]);
    // Completed waits are in the summary; the deep sleep it is now in is still running.
    expect(w.liveness.summary()).toHaveProperty('idle');
    expect(w.liveness.summary()).toHaveProperty('next-due');
    await w.stop();
  });

  it('a never-settling job is stalled (phase job, type only) and detecting it adds no database traffic', async () => {
    registerHandler('email', () => new Promise<void>(() => {})); // never settles, ignores abort
    claimsOnce(fakeJob('email'));
    const w = start(async () => null);

    await until(() => w.liveness.status() === 'stalled');
    const stall = w.events.find((e) => e.kind === 'transition' && e.status === 'stalled');
    expect(stall).toMatchObject({ phase: 'job', jobType: 'email' });
    expect(JSON.stringify(stall)).not.toContain('22222222'); // no job id
    expect(JSON.stringify(stall)).not.toContain('11111111'); // no org id

    const touchesAtStall = hoisted.touches.length;
    await sleep(300); // the watchdog keeps checking every 20 ms
    expect(hoisted.touches.length).toBe(touchesAtStall);
    expect(w.liveness.status()).toBe('stalled');
    await w.stop();
  });

  it('a slow but legitimate job — past the pass budget, inside the job budget — is not a stall', async () => {
    const slowMs = BUDGETS.passMs * 2; // 600 ms: well past a pass, well inside 1 000 + 200
    registerHandler('webhook', () => sleep(slowMs));
    claimsOnce(fakeJob('webhook'));
    const w = start(async () => null);

    await until(() => vi.mocked(completeJob).mock.calls.length === 1);
    await sleep(100);
    expect(w.statuses()).toEqual([]);
    expect(w.liveness.status()).toBe('ok');
    await w.stop();
  });

  it('a stalled job that finally returns is reported recovered and completes normally', async () => {
    // Returns a full second after the stall is due: room for a loaded machine's timer delays.
    registerHandler('notification', () => sleep(STALL_AFTER_JOB_MS + 1_000));
    claimsOnce(fakeJob('notification'));
    const w = start(async () => null);

    await until(() => vi.mocked(completeJob).mock.calls.length === 1);
    await sleep(50);
    expect(w.statuses()).toEqual(['ok->stalled', 'stalled->ok']);
    expect(w.liveness.status()).toBe('ok');
    await w.stop();
  });

  it('a database outage (next-due lookup failing) is degraded, never stalled', async () => {
    const w = start(async () => {
      throw new Error('connection refused');
    });
    await until(() => w.liveness.status() === 'degraded');
    await sleep(STALL_AFTER_JOB_MS); // the loop sits in its 30 s back-off: an exact, known wait
    expect(w.liveness.status()).toBe('degraded');
    expect(w.statuses()).toEqual(['ok->degraded']);
    await w.stop();
  });

  it('claims failing then succeeding: degraded, then ok again', async () => {
    let failures = 3;
    vi.mocked(claimJob).mockImplementation(async () => {
      touch('claim');
      if (failures-- > 0) throw new Error('connection reset');
      return null;
    });
    const w = start(async () => null);
    await until(() => w.statuses().includes('degraded->ok'));
    expect(w.statuses().slice(0, 2)).toEqual(['ok->degraded', 'degraded->ok']);
    expect(w.statuses()).not.toContain('ok->stalled');
    await w.stop();
  });

  it('overdue work that clears again is reported recovered: degraded, then ok', async () => {
    const past = new Date(Date.now() - 60_000);
    let cleared = false;
    const w = start(async () => (cleared ? new Date(Date.now() + 60_000) : past));
    await until(() => w.liveness.status() === 'degraded');
    cleared = true;
    w.latch.ring(); // a wake: the next look finds the work gone
    await until(() => w.statuses().includes('degraded->ok'));
    expect(w.statuses()).toEqual(['ok->degraded', 'degraded->ok']);
    await w.stop();
  });

  it('overdue work that will not clear is degraded (back-off), never stalled', async () => {
    const past = new Date(Date.now() - 60_000); // the same overdue instant every time
    const w = start(async () => past);
    await until(() => w.liveness.status() === 'degraded');
    await sleep(STALL_AFTER_JOB_MS);
    expect(w.liveness.status()).toBe('degraded');
    expect(w.statuses()).toEqual(['ok->degraded']);
    await w.stop();
  });
});
