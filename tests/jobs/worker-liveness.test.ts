/**
 * REL-11 — the worker-loop watchdog (src/worker/liveness.ts), driven by a fake monotonic
 * clock: every check is deterministic and nothing here touches a database or a real timer
 * (except the one test that proves the timer is unref'd and reads a lagging clock).
 *
 * What is proven:
 *   - a healthy deep sleep of any length, and an idle sleep, never count as a stall;
 *   - a wait past its allowance (incl. grace) is a stall only on the SECOND overdue check;
 *   - moving on (the next expect) re-arms the deadline and clears a stall, reported once;
 *   - passes, maintenance and jobs are held to their own budgets: a job slower than a pass
 *     budget but inside the job budget is not a stall;
 *   - database outages and overdue work are degraded, never stalled; a stall outranks them;
 *   - only the monotonic clock is used (a wall-clock jump changes nothing);
 *   - events carry phase, timings, job type and reasons — never an id or a payload;
 *   - a late check (blocked event loop) is reported as such.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LIVENESS_BUDGETS,
  DEFAULT_LIVENESS_CHECK_MS,
  LivenessMonitor,
  STALL_CHECKS,
  type LivenessEvent,
} from '@/worker/liveness';

const BUDGETS = { passMs: 1_000, maintenanceMs: 5_000, jobMs: 10_000, graceMs: 500 };

function rig(budgets: Partial<typeof BUDGETS> = BUDGETS) {
  let t = 0;
  const events: LivenessEvent[] = [];
  const m = new LivenessMonitor({ budgets, now: () => t, onEvent: (e) => events.push(e) });
  return {
    m,
    events,
    at: (ms: number) => {
      t = ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    transitions: () => events.filter((e) => e.kind === 'transition'),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LivenessMonitor — defaults', () => {
  it('ships the documented defaults: 5 min pass, 15 min maintenance and job, 60 s grace, 15 s checks, 2 checks', () => {
    expect(DEFAULT_LIVENESS_BUDGETS).toEqual({
      passMs: 300_000,
      maintenanceMs: 900_000,
      jobMs: 900_000,
      graceMs: 60_000,
    });
    expect(DEFAULT_LIVENESS_CHECK_MS).toBe(15_000);
    expect(STALL_CHECKS).toBe(2);
  });
});

describe('LivenessMonitor — no false stalls', () => {
  it('a deep sleep of 24 h, checked throughout, is never a stall', () => {
    const r = rig();
    r.m.expect('deep-sleep', 24 * 3_600_000);
    for (let i = 0; i < 24 * 60; i++) {
      r.advance(60_000);
      r.m.check();
    }
    expect(r.m.status()).toBe('ok');
    expect(r.transitions()).toEqual([]);
  });

  it('an idle sleep is held to its own length, not to the pass budget', () => {
    const r = rig();
    r.m.expect('idle', 10_000); // the adaptive poll ceiling
    for (let i = 0; i < 10; i++) {
      r.advance(1_000);
      r.m.check();
    }
    expect(r.m.status()).toBe('ok');
  });

  it('a slow but legitimate job — longer than a pass budget, inside the job budget — is not a stall', () => {
    const r = rig();
    r.m.expect('job', undefined, 'email');
    for (let ms = 0; ms < BUDGETS.jobMs + BUDGETS.graceMs; ms += 250) {
      r.advance(250);
      r.m.check();
    }
    expect(r.m.status()).toBe('ok');
    expect(r.transitions()).toEqual([]);
  });

  it('maintenance gets its own, longer budget', () => {
    const r = rig();
    r.m.expect('maintenance');
    r.advance(BUDGETS.passMs * 3); // past a pass budget, inside the maintenance budget
    r.m.check();
    r.advance(100);
    r.m.check();
    expect(r.m.status()).toBe('ok');
  });

  it('a wall-clock jump changes nothing: the default clock is monotonic, not Date', () => {
    // No injected clock: the monitor's own default (performance.now) is what is under test.
    const m = new LivenessMonitor({ budgets: BUDGETS });
    m.expect('claim');
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2099, 0, 1)); // ~73 years ahead
    m.check();
    m.check();
    expect(m.status()).toBe('ok');
  });
});

describe('LivenessMonitor — stall detection', () => {
  it('a wait past its allowance is a stall only on the second consecutive overdue check', () => {
    const r = rig();
    r.m.expect('claim');
    r.advance(BUDGETS.passMs + BUDGETS.graceMs + 1);
    r.m.check();
    expect(r.m.status()).toBe('ok'); // one overdue check is not enough
    r.advance(100);
    r.m.check();
    expect(r.m.status()).toBe('stalled');
    expect(r.transitions()).toEqual([
      {
        kind: 'transition',
        status: 'stalled',
        previous: 'ok',
        phase: 'claim',
        overdueMs: 101,
        reasons: [],
      },
    ]);
  });

  it('an overdue check followed by progress never becomes a stall', () => {
    const r = rig();
    r.m.expect('reap');
    r.advance(BUDGETS.passMs + BUDGETS.graceMs + 1);
    r.m.check();
    r.m.expect('claim'); // the reap returned
    r.m.check();
    expect(r.m.status()).toBe('ok');
    expect(r.transitions()).toEqual([]);
  });

  it('a never-settling job is a stall once the job budget and grace have passed, reporting its type only', () => {
    const r = rig();
    r.m.expect('job', undefined, 'webhook');
    r.advance(BUDGETS.jobMs + BUDGETS.graceMs + 10);
    r.m.check();
    r.m.check();
    expect(r.m.status()).toBe('stalled');
    const [stall] = r.transitions();
    expect(stall).toMatchObject({ status: 'stalled', phase: 'job', jobType: 'webhook' });
  });

  it('a stall is reported once, however many checks follow', () => {
    const r = rig();
    r.m.expect('next-due');
    r.advance(BUDGETS.passMs + BUDGETS.graceMs + 1);
    for (let i = 0; i < 20; i++) r.m.check();
    expect(r.transitions()).toHaveLength(1);
  });

  it('moving on clears the stall, reports how long it lasted, and re-arms the next deadline', () => {
    const r = rig();
    r.m.expect('job', undefined, 'email');
    r.advance(BUDGETS.jobMs + BUDGETS.graceMs + 1);
    r.m.check();
    r.m.check();
    expect(r.m.status()).toBe('stalled');

    r.advance(4_000);
    r.m.expect('claim'); // the job finally returned
    expect(r.m.status()).toBe('ok');
    expect(r.transitions()[1]).toEqual({
      kind: 'transition',
      status: 'ok',
      previous: 'stalled',
      phase: 'job',
      stalledForMs: BUDGETS.jobMs + BUDGETS.graceMs + 1 + 4_000,
      jobType: 'email',
      reasons: [],
    });

    // Re-armed: the new phase gets its full allowance again.
    r.advance(BUDGETS.passMs);
    r.m.check();
    r.m.check();
    expect(r.m.status()).toBe('ok');
  });

  it('a wake cuts a deep sleep short and re-arms: the next phase is held to its own budget', () => {
    const r = rig();
    r.m.expect('deep-sleep', 7_200_000);
    r.advance(30_000); // rung after 30 s
    r.m.expect('scheduler');
    r.advance(BUDGETS.passMs + BUDGETS.graceMs + 1);
    r.m.check();
    r.m.check();
    expect(r.m.status()).toBe('stalled'); // the 2 h sleep allowance did not carry over
    expect(r.transitions()[0]).toMatchObject({ phase: 'scheduler' });
  });

  it('stopping during a stall emits nothing: a shutdown is not a recovery', () => {
    const r = rig();
    r.m.expect('job', undefined, 'email');
    r.advance(BUDGETS.jobMs + BUDGETS.graceMs + 1);
    r.m.check();
    r.m.check();
    expect(r.transitions()).toHaveLength(1); // the stall
    r.m.stop();
    expect(r.transitions()).toHaveLength(1); // no "ok" on the way out
    expect(r.m.summary()).toMatchObject({ job: { count: 1 } });
  });

  it('a stopped monitor never reports a stall', () => {
    const r = rig();
    r.m.stop();
    r.advance(10 * 3_600_000);
    r.m.check();
    r.m.check();
    expect(r.m.status()).toBe('ok');
  });
});

describe('LivenessMonitor — degraded is not stalled', () => {
  it('a database outage is degraded, and recovery is reported', () => {
    const r = rig();
    r.m.degraded('database-unavailable');
    expect(r.m.status()).toBe('degraded');
    r.m.degraded('database-unavailable'); // repeated: no new event
    r.m.recovered('database-unavailable');
    expect(r.m.status()).toBe('ok');
    expect(r.transitions().map((e) => (e.kind === 'transition' ? e.status : ''))).toEqual([
      'degraded',
      'ok',
    ]);
  });

  it('overdue work that will not clear is degraded, never stalled, while the loop backs off', () => {
    const r = rig();
    r.m.degraded('overdue-work');
    let backoff = 30_000;
    for (let i = 0; i < 6; i++) {
      r.m.expect('deep-sleep', backoff);
      r.advance(backoff);
      r.m.check();
      r.m.check();
      backoff = Math.min(backoff * 2, 7_200_000);
    }
    expect(r.m.status()).toBe('degraded');
    expect(r.transitions()).toHaveLength(1);
  });

  it('a stall outranks degraded, and the reasons survive it', () => {
    const r = rig();
    r.m.degraded('database-unavailable');
    r.m.expect('claim');
    r.advance(BUDGETS.passMs + BUDGETS.graceMs + 1);
    r.m.check();
    r.m.check();
    expect(r.m.status()).toBe('stalled');
    r.m.expect('idle', 1_000);
    expect(r.m.status()).toBe('degraded');
  });
});

describe('LivenessMonitor — what it reports', () => {
  it('events carry only phase, status, timings, job type and reasons', () => {
    const r = rig();
    r.m.degraded('overdue-work');
    r.m.expect('job', undefined, 'notification');
    r.advance(BUDGETS.jobMs + BUDGETS.graceMs + 1);
    r.m.check();
    r.m.check();
    r.m.expect('claim');
    const allowed = new Set([
      'kind',
      'status',
      'previous',
      'phase',
      'overdueMs',
      'stalledForMs',
      'jobType',
      'reasons',
    ]);
    for (const e of r.events) for (const key of Object.keys(e)) expect(allowed).toContain(key);
    expect(JSON.stringify(r.events)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i); // no uuid anywhere
  });

  it('the summary records the longest wait per phase — the figures the budgets are checked against', () => {
    const r = rig();
    r.m.expect('claim');
    r.advance(120);
    r.m.expect('job', undefined, 'email');
    r.advance(900);
    r.m.expect('claim');
    r.advance(80);
    r.m.expect('idle', 1_000);
    expect(r.m.summary()).toMatchObject({
      starting: { count: 1, maxMs: 0 },
      claim: { count: 2, maxMs: 120 },
      job: { count: 1, maxMs: 900 },
    });
  });

  it('a check that runs late — a blocked event loop — is reported with its lag', () => {
    vi.useFakeTimers();
    let t = 0;
    const events: LivenessEvent[] = [];
    const m = new LivenessMonitor({
      budgets: BUDGETS,
      checkIntervalMs: 100,
      now: () => t,
      onEvent: (e) => events.push(e),
    });
    m.start();
    m.expect('idle', 60_000);
    t = 100;
    vi.advanceTimersByTime(100); // on time
    t = 100 + 100 + 2_000; // the next check runs 2 s late
    vi.advanceTimersByTime(100);
    m.stop();
    expect(events).toEqual([{ kind: 'event-loop-blocked', lagMs: 2_000, phase: 'idle' }]);
  });

  it('with a grace of 0, ordinary timer jitter is not reported as a blocked event loop', () => {
    vi.useFakeTimers();
    let t = 0;
    const events: LivenessEvent[] = [];
    const m = new LivenessMonitor({
      budgets: { ...BUDGETS, graceMs: 0 },
      checkIntervalMs: 100,
      now: () => t,
      onEvent: (e) => events.push(e),
    });
    m.start();
    m.expect('idle', 60_000);
    for (let i = 1; i <= 10; i++) {
      t = i * 100 + 2; // every check 2 ms late
      vi.advanceTimersByTime(100);
    }
    m.stop();
    expect(events).toEqual([]);
  });

  it('a listener that throws never reaches the worker loop or the timer', () => {
    let t = 0;
    const m = new LivenessMonitor({
      budgets: BUDGETS,
      now: () => t,
      onEvent: () => {
        throw new Error('broken logger');
      },
    });
    m.expect('job', undefined, 'email');
    t = BUDGETS.jobMs + BUDGETS.graceMs + 1;
    expect(() => {
      m.check();
      m.check(); // emits the stall
      m.degraded('database-unavailable');
      m.expect('claim'); // emits the recovery
    }).not.toThrow();
    expect(m.status()).toBe('degraded');
  });

  it('its timer never keeps the process alive', () => {
    const m = new LivenessMonitor({ checkIntervalMs: 10_000 });
    const spy = vi.spyOn(globalThis, 'setInterval');
    m.start();
    const timer = spy.mock.results[0]!.value as ReturnType<typeof setInterval>;
    expect(timer.hasRef()).toBe(false);
    m.stop();
  });
});
