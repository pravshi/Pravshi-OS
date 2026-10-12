/**
 * WP-W — runWorker in 'deep-sleep' (low-cost) mode. DB-free: the queue, the sweeps, the
 * maintenance pass and the driver are mocked, and every one of them records a timestamped
 * "database touch". What is proven:
 *
 *   - restart: a fresh worker runs every pass (reap, retry, reminders, scheduler,
 *     maintenance) BEFORE its first claim, so overdue work is drained first;
 *   - idle: after the active window it sleeps until the next due instant and touches the
 *     database not at all while asleep (what lets Neon compute suspend);
 *   - a wake signal cuts the sleep short; duplicate signals coalesce;
 *   - nothing due: it sleeps the safety cap and looks again (lost signals are found);
 *   - database unavailable (next-due lookup or claim throws): it backs off, never crashes,
 *     and resumes when the database answers again;
 *   - an overdue item that never clears makes it back off, not spin;
 *   - the cap is clamped to 24 h so maintenance runs at least daily;
 *   - shutdown during a deep sleep is immediate;
 *   - 'poll' mode never asks for the next due instant.
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
// Since 0070 the worker plane connects as app_worker (worker-pool); the same mocked
// connect serves it, so assertions on connectWithWake keep their meaning.
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
          return { rows: [{ reaped: '0' }], rowCount: 0 };
        },
      }),
  }),
}));

import {
  MAX_DEEP_SLEEP_MS,
  registerHandler,
  resetHandlerRegistry,
  runWorker,
} from '@/lib/jobs/worker';
import { WakeLatch } from '@/lib/jobs/wake-latch';
import { claimJob, completeJob } from '@/lib/jobs/queue';
import type { Job } from '@/lib/jobs/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeJob(): Job {
  const now = new Date().toISOString();
  return {
    id: '22222222-2222-4222-8222-222222222222',
    orgId: '11111111-1111-4111-8111-111111111111',
    type: 'email',
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

beforeEach(() => {
  hoisted.touches.length = 0;
  resetHandlerRegistry();
  registerHandler('email', async () => {});
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

/** Start a deep-sleep worker; returns a stopper that SIGINTs and awaits it. */
function start(
  over: Partial<Parameters<typeof runWorker>[0]> & { nextDueAt: () => Promise<Date | null> },
) {
  const sleeps: number[] = [];
  const actives: number[] = [];
  const latch = over.wakeLatch ?? new WakeLatch();
  const run = runWorker({
    workerId: 'w-deep',
    idleMode: 'deep-sleep',
    pollIntervalMs: 5,
    pollMaxIdleMs: 10,
    activeWindowMs: 30,
    maxSleepMs: 60_000,
    wakeLatch: latch,
    schedulerTick: async () => touch('scheduler'),
    onDeepSleep: (_at, ms) => sleeps.push(ms),
    onActive: (at) => actives.push(at),
    ...over,
  });
  return {
    latch,
    sleeps,
    actives,
    stop: async () => {
      process.emit('SIGINT');
      await run;
    },
  };
}

describe("runWorker idleMode 'deep-sleep'", () => {
  it('requires nextDueAt', async () => {
    await expect(runWorker({ workerId: 'w', idleMode: 'deep-sleep' })).rejects.toThrow(/nextDueAt/);
  });

  it('after a restart runs every pass before the first claim, draining overdue work first', async () => {
    const w = start({ nextDueAt: async () => null });
    await sleep(15);
    await w.stop();
    const firstClaim = hoisted.touches.findIndex((t) => t.what === 'claim');
    const before = hoisted.touches.slice(0, firstClaim).map((t) => t.what);
    expect(before).toEqual(
      expect.arrayContaining(['scheduler', 'retry', 'reap', 'reminders', 'maintenance']),
    );
  });

  it('claims overdue jobs immediately on start (no sleep first)', async () => {
    vi.mocked(claimJob)
      .mockImplementationOnce(async () => {
        touch('claim');
        return fakeJob();
      })
      .mockImplementation(async () => {
        touch('claim');
        return null;
      });
    const w = start({ nextDueAt: async () => null });
    await sleep(40);
    await w.stop();
    expect(completeJob).toHaveBeenCalledTimes(1);
  });

  it('sleeps until the next due instant and touches the database not at all meanwhile', async () => {
    const dueIn = 400;
    const startedAt = Date.now();
    const w = start({ nextDueAt: async () => new Date(startedAt + dueIn) });
    await sleep(dueIn + 150);
    await w.stop();

    expect(w.sleeps.length).toBeGreaterThanOrEqual(1);
    const sleptAt = startedAt + 30; // after the active window
    // No database touch strictly inside the sleep (allowing scheduling slack).
    const during = hoisted.touches.filter(
      (t) => t.at > sleptAt + 60 && t.at < startedAt + dueIn - 30,
    );
    expect(during).toEqual([]);
    // ...and on the due instant every pass ran again.
    const after = hoisted.touches.filter((t) => t.at >= startedAt + dueIn - 30).map((t) => t.what);
    expect(after).toEqual(expect.arrayContaining(['reminders', 'scheduler', 'retry', 'claim']));
  });

  it('a wake signal cuts the sleep short and the new job is claimed', async () => {
    const w = start({ nextDueAt: async () => null });
    await sleep(80); // now deep asleep (cap 60 s)
    expect(w.sleeps.length).toBe(1);
    vi.mocked(claimJob)
      .mockImplementationOnce(async () => {
        touch('claim');
        return fakeJob();
      })
      .mockImplementation(async () => {
        touch('claim');
        return null;
      });
    const rungAt = Date.now();
    w.latch.ring();
    await sleep(60);
    await w.stop();
    expect(completeJob).toHaveBeenCalledTimes(1);
    const firstClaimAfter = hoisted.touches.find((t) => t.what === 'claim' && t.at >= rungAt);
    expect(firstClaimAfter!.at - rungAt).toBeLessThan(50);
  });

  it('duplicate wake signals coalesce into one wake', async () => {
    const w = start({ nextDueAt: async () => null });
    await sleep(80);
    for (let i = 0; i < 25; i++) w.latch.ring();
    await sleep(120);
    await w.stop();
    // Start + one coalesced wake (+ at most one remembered ring), never 25.
    expect(w.actives.length).toBeLessThanOrEqual(3);
  });

  it('with nothing due it sleeps the safety cap and then looks again', async () => {
    const nextDueAt = vi.fn(async () => null);
    const w = start({ nextDueAt, maxSleepMs: 120 });
    await sleep(500);
    await w.stop();
    expect(w.sleeps.every((ms) => ms === 120)).toBe(true);
    expect(nextDueAt.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a database outage never crashes it: it backs off and resumes when the database answers', async () => {
    let down = true;
    const nextDueAt = vi.fn(async () => {
      if (down) throw Object.assign(new Error('compute suspended'), { code: '57P01' });
      return null;
    });
    vi.mocked(claimJob).mockImplementation(async () => {
      touch('claim');
      if (down) throw new Error('connection refused');
      return null;
    });
    const w = start({ nextDueAt, maxSleepMs: 100 });
    await sleep(350);
    const callsWhileDown = nextDueAt.mock.calls.length;
    expect(callsWhileDown).toBeGreaterThanOrEqual(1);
    expect(callsWhileDown).toBeLessThan(15); // backing off, not spinning
    down = false;
    vi.mocked(claimJob)
      .mockImplementationOnce(async () => {
        touch('claim');
        return fakeJob();
      })
      .mockImplementation(async () => {
        touch('claim');
        return null;
      });
    await sleep(400);
    await w.stop();
    expect(completeJob).toHaveBeenCalledTimes(1); // the queued job was not lost
  });

  it('an overdue item that never clears makes it back off instead of spinning', async () => {
    const stuck = new Date(Date.now() - 60_000);
    const nextDueAt = vi.fn(async () => stuck);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = start({ nextDueAt, maxSleepMs: 100, activeWindowMs: 10 });
    await sleep(600);
    await w.stop();
    expect(nextDueAt.mock.calls.length).toBeLessThan(20);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('did not clear'))).toBe(true);
  });

  it('clamps the safety cap to 24 h, so maintenance runs at least daily', async () => {
    const w = start({ nextDueAt: async () => null, maxSleepMs: 3 * MAX_DEEP_SLEEP_MS });
    await sleep(80);
    await w.stop();
    expect(w.sleeps[0]).toBe(MAX_DEEP_SLEEP_MS);
  });

  it('a long sleep ends at once on shutdown', async () => {
    const w = start({ nextDueAt: async () => null, maxSleepMs: 10 * 60_000 });
    await sleep(80);
    const stoppedAt = Date.now();
    await w.stop();
    expect(Date.now() - stoppedAt).toBeLessThan(500);
  });

  it("'poll' mode never asks for the next due instant", async () => {
    const nextDueAt = vi.fn(async () => null);
    const run = runWorker({ workerId: 'w-poll', pollIntervalMs: 5, nextDueAt });
    await sleep(60);
    process.emit('SIGINT');
    await run;
    expect(nextDueAt).not.toHaveBeenCalled();
  });
});
