/**
 * REL-11 — worker liveness: is the worker loop still making progress?
 *
 * The job lease (queue.ts, renewed every 15 s while a handler runs) proves that the process is
 * alive, not that it is getting anywhere: its timer keeps renewing the claim even when the
 * handler awaits something that never settles, so the reaper never frees that job and nothing
 * notices. This watchdog closes that gap from inside the process, without touching the
 * database (Neon scale-to-zero is a locked decision, enforced by the repository's guard tests).
 *
 * How it works. Before every wait, the worker loop says what it is about to wait for and how
 * long that may take — `expect(phase, waitMs?)`. A deep sleep or an idle sleep passes the exact
 * duration it chose; a database pass, a maintenance pass or a job gets a budget (below). The
 * next `expect()` is the proof that the previous wait ended. A timer (unref'd: it never keeps
 * the process alive) compares a MONOTONIC clock against "armed at + allowed + grace"; the loop
 * counts as STALLED only after TWO consecutive overdue checks, and is OK again as soon as it
 * moves on. A suspended host does not trip it: the monotonic clock does not advance across a
 * suspend, and a deep sleep is never a stall because its deadline is the sleep itself.
 *
 * DEGRADED is not a stall. The database not answering (claim or next-due lookup failing) and
 * due work that a full pass did not clear (a pass that keeps failing, a job type this worker
 * does not take) are reported as degraded: the loop is progressing — backing off — and
 * restarting the worker would not fix either.
 *
 * A blocked event loop cannot answer anything, /healthz included: outside, a monitor sees the
 * request time out; inside, the late check that follows is logged as `event-loop-blocked`.
 *
 * This first version only REPORTS. It never aborts a job, never exits, and changes no retry,
 * reap or dead-letter behaviour; what to do about a stall is decided by a human (DEPLOYMENT.md).
 */

/** What the worker loop is waiting for. Never carries an id, a payload or an organization. */
export type LivenessPhase =
  | 'starting'
  | 'scheduler'
  | 'retry-sweep'
  | 'reap'
  | 'reminder-sweep'
  | 'maintenance'
  | 'claim'
  | 'idle'
  | 'next-due'
  | 'deep-sleep'
  | 'job'
  | 'stopped';

export type LivenessStatus = 'ok' | 'degraded' | 'stalled';

export type DegradedReason = 'database-unavailable' | 'overdue-work';

/** The part of the monitor the worker loop talks to (WorkerConfig.liveness). */
export interface LivenessReporter {
  /**
   * The loop is about to wait in `phase`. `waitMs` is the exact length of a sleep the loop
   * chose itself ('idle', 'deep-sleep'); every other phase is held to its budget. `jobType` is
   * the job's type ('email', 'webhook' …) — never its id.
   */
  expect(phase: LivenessPhase, waitMs?: number, jobType?: string): void;
  degraded(reason: DegradedReason): void;
  recovered(reason: DegradedReason): void;
}

/**
 * How long each kind of wait may take before it is overdue. Defaults and their evidence
 * (main @ d8ae017; details in DEPLOYMENT.md, "Worker liveness"):
 *   passMs 300000 (5 min) — a sweep, reap, claim, next-due lookup or scheduler tick is a few
 *     worker-plane transactions. Establishing a connection is bounded (worker-pool.ts: 10 s
 *     timeout, 4 attempts, 1.75 s of back-off ≈ 41.75 s worst case); a query is not (no
 *     statement timeout), so the budget is a conservative multiple, not a measured bound.
 *   maintenanceMs 900000 (15 min) — partition extension plus retention in batches of at most
 *     5000 rows per target (maintenance.ts); its duration at production volume is unmeasured.
 *   jobMs 900000 (15 min) — a CHOSEN value, not a derived bound: no handler has a total
 *     deadline. A webhook makes at most 3 requests (2 redirects), each with a socket
 *     INACTIVITY timeout of at most 30 s (types.ts, handlers.ts `req.setTimeout`), so an
 *     endpoint that keeps trickling bytes can hold it indefinitely. An email goes through the
 *     Resend SDK, which passes no abort signal, so only Node's fetch default timers bound it,
 *     and those are idle timers too. workflow_run and the other types are database-only
 *     (workflow actions enqueue jobs rather than calling out). 15 minutes is far beyond any
 *     healthy external call and short enough to surface a hung one the same hour.
 *   graceMs 60000 — added to every allowance: the reaper's own staleness threshold
 *     (jobs_reap_stale, 60 s), and above the worst-case connection establishment.
 * Every value is configurable (runner.ts, WORKER_*_STALL_MS); none is a measured production
 * figure.
 */
export interface LivenessBudgets {
  passMs: number;
  maintenanceMs: number;
  jobMs: number;
  graceMs: number;
}

export const DEFAULT_LIVENESS_BUDGETS: Readonly<LivenessBudgets> = Object.freeze({
  passMs: 300_000,
  maintenanceMs: 900_000,
  jobMs: 900_000,
  graceMs: 60_000,
});

/** The watchdog's cadence: the job lease's own renewal interval. No database involved. */
export const DEFAULT_LIVENESS_CHECK_MS = 15_000;

/** Consecutive overdue checks before the loop counts as stalled. */
export const STALL_CHECKS = 2;

export type LivenessEvent =
  | {
      kind: 'transition';
      status: LivenessStatus;
      previous: LivenessStatus;
      phase: LivenessPhase;
      /** stalled: how far past its allowance (incl. grace) the current wait is. */
      overdueMs?: number;
      /** ok after a stall: how long the stalled wait lasted in the end. */
      stalledForMs?: number;
      jobType?: string;
      reasons: DegradedReason[];
    }
  | { kind: 'event-loop-blocked'; lagMs: number; phase: LivenessPhase };

export interface LivenessMonitorOptions {
  budgets?: Partial<LivenessBudgets>;
  checkIntervalMs?: number;
  /** Monotonic milliseconds. Default: performance.now(). Never Date.now(). */
  now?: () => number;
  onEvent?: (event: LivenessEvent) => void;
}

export interface PhaseStats {
  count: number;
  maxMs: number;
}

const PASS_PHASES: ReadonlySet<LivenessPhase> = new Set([
  'starting',
  'scheduler',
  'retry-sweep',
  'reap',
  'reminder-sweep',
  'claim',
  'next-due',
]);

export class LivenessMonitor implements LivenessReporter {
  readonly budgets: Readonly<LivenessBudgets>;
  readonly checkIntervalMs: number;
  private readonly now: () => number;
  private readonly onEvent: (event: LivenessEvent) => void;

  private phase: LivenessPhase = 'starting';
  private jobType: string | undefined;
  private armedAt: number;
  private allowedMs: number;
  private overdueChecks = 0;
  private stalled = false;
  private readonly reasons = new Set<DegradedReason>();
  private readonly stats = new Map<LivenessPhase, PhaseStats>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextCheckAt: number | null = null;

  constructor(options: LivenessMonitorOptions = {}) {
    this.budgets = Object.freeze({ ...DEFAULT_LIVENESS_BUDGETS, ...options.budgets });
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_LIVENESS_CHECK_MS;
    this.now = options.now ?? (() => performance.now());
    this.onEvent = options.onEvent ?? (() => undefined);
    this.armedAt = this.now();
    this.allowedMs = this.budgets.passMs;
  }

  expect(phase: LivenessPhase, waitMs?: number, jobType?: string): void {
    const t = this.now();
    this.record(this.phase, t - this.armedAt);
    const wasStalled = this.stalled;
    const stalledPhase = this.phase;
    const stalledJobType = this.jobType;
    const stalledForMs = t - this.armedAt;

    this.phase = phase;
    this.jobType = phase === 'job' ? jobType : undefined;
    this.armedAt = t;
    this.allowedMs = this.allowanceFor(phase, waitMs);
    this.overdueChecks = 0;

    if (wasStalled) {
      this.stalled = false;
      this.emitTransition('stalled', {
        phase: stalledPhase,
        stalledForMs,
        ...(stalledJobType !== undefined ? { jobType: stalledJobType } : {}),
      });
    }
  }

  degraded(reason: DegradedReason): void {
    if (this.reasons.has(reason)) return;
    const previous = this.status();
    this.reasons.add(reason);
    if (this.status() !== previous) this.emitTransition(previous, { phase: this.phase });
  }

  recovered(reason: DegradedReason): void {
    if (!this.reasons.has(reason)) return;
    const previous = this.status();
    this.reasons.delete(reason);
    if (this.status() !== previous) this.emitTransition(previous, { phase: this.phase });
  }

  /** One watchdog look. Public so tests (and the timer) can drive it deterministically. */
  check(): void {
    const t = this.now();
    if (this.nextCheckAt !== null) {
      // Late by more than a whole check interval (and the grace): ordinary timer jitter is a
      // millisecond or two, so a grace of 0 must not turn every check into a report.
      const lagMs = t - this.nextCheckAt;
      if (lagMs > Math.max(this.budgets.graceMs, this.checkIntervalMs)) {
        this.emit({ kind: 'event-loop-blocked', lagMs: Math.round(lagMs), phase: this.phase });
      }
      this.nextCheckAt = t + this.checkIntervalMs;
    }
    if (this.phase === 'stopped' || this.stalled) return;
    const overdueMs = t - (this.armedAt + this.allowedMs + this.budgets.graceMs);
    if (overdueMs <= 0) {
      this.overdueChecks = 0;
      return;
    }
    this.overdueChecks += 1;
    if (this.overdueChecks < STALL_CHECKS) return;
    const previous = this.status();
    this.stalled = true;
    this.emitTransition(previous, {
      phase: this.phase,
      overdueMs: Math.round(overdueMs),
      ...(this.jobType !== undefined ? { jobType: this.jobType } : {}),
    });
  }

  status(): LivenessStatus {
    if (this.stalled) return 'stalled';
    return this.reasons.size > 0 ? 'degraded' : 'ok';
  }

  /** Longest observed wait per phase since start — the measurements the budgets rest on. */
  summary(): Record<string, PhaseStats> {
    return Object.fromEntries(
      [...this.stats.entries()].map(([p, s]) => [
        p,
        { count: s.count, maxMs: Math.round(s.maxMs) },
      ]),
    );
  }

  start(): void {
    if (this.timer !== null) return;
    this.nextCheckAt = this.now() + this.checkIntervalMs;
    this.timer = setInterval(() => this.check(), this.checkIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.nextCheckAt = null;
    // Shutting down is not a recovery: record the last wait and go quiet, with no event — a
    // worker stopped while stalled must not log "liveness: ok" on its way out.
    this.record(this.phase, this.now() - this.armedAt);
    this.phase = 'stopped';
    this.jobType = undefined;
    this.allowedMs = Number.POSITIVE_INFINITY;
    this.overdueChecks = 0;
  }

  private allowanceFor(phase: LivenessPhase, waitMs: number | undefined): number {
    if (phase === 'idle' || phase === 'deep-sleep') return Math.max(0, waitMs ?? 0);
    if (phase === 'maintenance') return this.budgets.maintenanceMs;
    if (phase === 'job') return this.budgets.jobMs;
    if (PASS_PHASES.has(phase)) return this.budgets.passMs;
    return Number.POSITIVE_INFINITY; // 'stopped'
  }

  private record(phase: LivenessPhase, ms: number): void {
    const s = this.stats.get(phase) ?? { count: 0, maxMs: 0 };
    s.count += 1;
    if (ms > s.maxMs) s.maxMs = ms;
    this.stats.set(phase, s);
  }

  private emitTransition(
    previous: LivenessStatus,
    detail: { phase: LivenessPhase; overdueMs?: number; stalledForMs?: number; jobType?: string },
  ): void {
    this.emit({
      kind: 'transition',
      status: this.status(),
      previous,
      phase: detail.phase,
      ...(detail.overdueMs !== undefined ? { overdueMs: detail.overdueMs } : {}),
      ...(detail.stalledForMs !== undefined
        ? { stalledForMs: Math.round(detail.stalledForMs) }
        : {}),
      ...(detail.jobType !== undefined ? { jobType: detail.jobType } : {}),
      reasons: [...this.reasons].sort(),
    });
  }

  /**
   * Reporting must never change what the worker does: expect() runs inside the worker loop and
   * check() on the timer, so a throwing listener (a broken logger) is contained here.
   */
  private emit(event: LivenessEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // Swallowed on purpose: a liveness report is worth less than the loop it describes.
    }
  }
}
