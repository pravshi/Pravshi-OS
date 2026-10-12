/**
 * Phase 6 Worker Runtime — claim → execute → complete/fail loop.
 *
 * Owner: Worker Runtime Engineer. Other agents MUST NOT modify this file.
 *
 * Contract: ~/workspace/goals/pravshi-os-build/hidden_files/phase6-architecture-contracts.md §3.4
 *
 * ── EXECUTION MODEL ──────────────────────────────────────────────────────────
 * runWorker() is the long-running claim/execute loop:
 *   1. claimJob(workerId, types) — atomic SKIP LOCKED claim (queue.ts)
 *   2. build a §3.6 system-actor Authorization, org_id taken from the JOB ROW
 *   3. startJob — claimed → running
 *   4. run the registered handler with a heartbeat ticker keeping the claim alive
 *   5. completeJob on success; on throw: classifyError → failJob
 *      (retryable → 'failed' with backoff next_run_at, else → 'dead_letter')
 *
 * A failed job never crashes the worker: every queue/handler error is caught
 * per-job and the loop continues. Jobs run AT LEAST ONCE — handlers must be
 * idempotent (dedup keys, step_key) because crash/shutdown recovery can
 * re-deliver a job another worker partially processed.
 *
 * ── IDLE POLLING ─────────────────────────────────────────────────────────────
 * When a claim returns null, the idle sleep backs off geometrically (×2)
 * from pollIntervalMs (default 1 s) to a pollMaxIdleMs ceiling (default
 * 10 s), resetting to pollIntervalMs on any claimed job (Phase 12,
 * F-12-04). An idle worker therefore polls at most once per 10 s instead
 * of once per second, so a running worker no longer holds the database
 * awake by existence alone. Tradeoff: worst-case claim latency for a job
 * arriving during deep idle is the 10 s ceiling — acceptable for every
 * current job type (none is user-blocking; user-facing work is
 * synchronous). The scheduler tick cadence is unchanged.
 *
 * ── SHUTDOWN ─────────────────────────────────────────────────────────────────
 * SIGTERM/SIGINT → stop claiming → fire the current job's AbortSignal → wait
 * for the in-flight job up to shutdownTimeoutMs → on timeout, release the
 * claim (status back to 'pending', claim fields cleared, no attempt burned)
 * so another worker can retry it, then resolve. runWorker() resolving means
 * the process may exit; the caller is responsible for process.exit().
 *
 * ── PRIVILEGE NOTE ───────────────────────────────────────────────────────────
 * claim/heartbeat/release/backoff run on the worker plane (plain pooled
 * transaction, no per-request identity) — the same model as claimJob/heartbeatJob
 * in queue.ts, via the privileged functions the Queue Engineer flagged
 * (contract §3.2 PRIVILEGE PATH). reapStaleJobs() and sweepRetryableJobs()
 * run through the SECURITY DEFINER worker-plane functions
 * public.jobs_reap_stale() and public.jobs_sweep_retryable() (migration
 * 0049), and releaseClaim()/applyRetryBackoff() run through
 * public.jobs_release_claim() and public.jobs_apply_backoff() (migration
 * 0050): a raw UPDATE would be fail-closed against the FORCED RLS on
 * public.jobs and match zero rows forever. The task-reminder sweep
 * (P1b, AUD-04) runs on the same model through
 * public.claim_due_task_reminders() (migration 0064) — see
 * reminder-sweep.ts for its claim/delivery contract. Database maintenance
 * (audit partitions + retention, WP-2) runs the same way through
 * public.maintain_audit_log_partitions() and public.run_data_retention()
 * (migration 0065) — see maintenance.ts.
 *
 * The synthesized Authorization is built directly per the §3.6 actor authority
 * rule (org from the job row, system actor); it is not issued by
 * requirePermission(). If the authz layer later requires issued authorizations
 * on the worker plane (assertAuthorization / the `issued` WeakSet), the system
 * actor needs a first-class issuance path — flag for the RBAC Engineer.
 */

import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import { connectWithWake } from '../db/pool';
import type { Tx } from '../db/authorized';
import type { Authorization } from '../authz/require-permission';
import { claimJob, completeJob, failJob, heartbeatJob, startJob } from './queue';
import { sweepRetryableJobs } from './retry-sweeper';
import { sweepDueTaskReminders } from './reminder-sweep';
import { runDbMaintenance, sqlstateOf } from './maintenance';
import { WakeLatch } from './wake-latch';
import { backoffDelayMs, classifyError } from './retry';
import { JOB_TYPE_SET, type Job, type JobType } from './types';

// ── Config & context ────────────────────────────────────────────────────────

export interface WorkerConfig {
  /** Unique per process, e.g. `worker-${hostname}-${pid}`. Max 128 chars. */
  workerId: string;
  /** Job types this worker handles. Empty/undefined = all types. */
  types?: JobType[];
  /** Idle sleep between claim attempts. Default 1000. */
  pollIntervalMs?: number;
  /**
   * Idle-poll backoff ceiling (Phase 12, F-12-04): when a claim returns no
   * job, the idle sleep grows geometrically (×2) from pollIntervalMs up to
   * this ceiling, and resets to pollIntervalMs on any claimed job. Default
   * 10000. A job arriving during deep idle can therefore wait up to this
   * long before it is claimed — acceptable for every current job type
   * (none is user-blocking; user-facing work is synchronous). A ceiling at
   * or below pollIntervalMs simply disables the backoff growth.
   */
  pollMaxIdleMs?: number;
  /** Liveness ping while a handler runs. Default 15000. */
  heartbeatIntervalMs?: number;
  /** Max wait for the in-flight job on SIGTERM/SIGINT. Default 30000. */
  shutdownTimeoutMs?: number;
  /**
   * Automatic retry-sweeper cadence: every this many ms, 'failed' jobs whose
   * backoff elapsed are re-driven to 'pending' (retry-sweeper.ts). Default
   * 30000; 0 or negative disables the automatic sweep. The first sweep fires
   * one interval after worker start.
   */
  retrySweepIntervalMs?: number;
  /**
   * Stale-claim reaper cadence (Phase 12, F-12-02): every this many ms,
   * reapStaleJobs() resets 'claimed'/'running' jobs whose heartbeat went
   * stale back to 'pending' (0049 definer). This is the steady-state lease
   * expiry path — before it existed, lease expiry depended on per-org
   * cleanup jobs that nothing scheduled, so a job orphaned by a dead worker
   * could sit claimed forever. Default 300000; 0 or negative disables the
   * in-loop reap. The first in-loop reap fires one interval after worker
   * start; runner.ts additionally reaps once at startup, before the first
   * claim.
   */
  reapIntervalMs?: number;
  /**
   * Task-reminder sweep cadence (P1b, AUD-04): every this many ms, due
   * task reminders are claimed (migration 0064) and delivered as TASK_DUE
   * notifications (reminder-sweep.ts). Reminders are minute-granularity
   * user data, so the cadence matches the scheduler tick. Default 60000;
   * 0 or negative disables the sweep. The first sweep fires one interval
   * after worker start.
   */
  reminderSweepIntervalMs?: number;
  /**
   * Database maintenance cadence (Core V1 audit WP-2, migration 0065): every
   * this many ms, runDbMaintenance() keeps audit_logs partitioned twelve
   * months ahead and deletes rows past their retention periods, in bounded
   * batches (maintenance.ts). Default 3600000 (hourly — both steps are cheap
   * when there is nothing to do); 0 or negative disables it. The first
   * in-loop pass fires one interval after worker start; runner.ts
   * additionally runs one pass at startup.
   */
  maintenanceIntervalMs?: number;
  /**
   * What the worker does when the queue is empty (WP-W).
   *   'poll' (default): the adaptive claim poll above — the database is read at least
   *     every pollMaxIdleMs, plus every sweep cadence, so Neon compute never suspends.
   *   'deep-sleep': low-cost mode for Neon Free. After activeWindowMs with nothing to do,
   *     the worker asks nextDueAt() when work next falls due and sends NO query until
   *     then (capped by maxSleepMs), or until wakeLatch is rung. On every wake it runs
   *     the reap, retry, reminder, scheduler and (when due) maintenance passes at once.
   */
  idleMode?: 'poll' | 'deep-sleep';
  /** deep-sleep: stay active this long after the last job or wake. Default 60000. */
  activeWindowMs?: number;
  /**
   * deep-sleep: the longest sleep, whatever nextDueAt() says — the safety net that finds
   * work whose wake signal was lost. Default 7200000 (2 h); clamped to 24 h so the
   * maintenance pass (audit partitions, retention) runs at least daily.
   */
  maxSleepMs?: number;
  /** deep-sleep: earliest due instant across the queue (public.worker_next_due_at()). */
  nextDueAt?: () => Promise<Date | null>;
  /** Rung by the wake endpoint (and by shutdown). Created internally when absent. */
  wakeLatch?: WakeLatch;
  /**
   * deep-sleep: the scheduler tick runs inside the loop (on schedulerTickIntervalMs while
   * active, and immediately on every wake) instead of on its own timer, so it cannot wake
   * the database during a sleep. In 'poll' mode runner.ts keeps its own interval.
   */
  schedulerTick?: () => Promise<unknown>;
  /** Default 60000. */
  schedulerTickIntervalMs?: number;
  /** Observability: the loop went active (start, wake) / went to deep sleep. */
  onActive?: (at: number) => void;
  onDeepSleep?: (at: number, sleepMs: number) => void;
}

/** deep-sleep never sleeps longer than a day: maintenance must run at least daily. */
export const MAX_DEEP_SLEEP_MS = 24 * 60 * 60 * 1000;
/** deep-sleep: first back-off when nextDueAt() fails or a due item will not clear. */
export const DEEP_SLEEP_ERROR_BACKOFF_MS = 30_000;

export type JobHandler = (ctx: JobExecutionContext) => Promise<void>;

export interface JobExecutionContext {
  job: Job;
  /** Org-scoped system-actor Authorization synthesized from the job row (§3.6). */
  auth: Authorization;
  /** Fires on SIGTERM/SIGINT so the handler can stop cooperatively. */
  signal: AbortSignal;
}

// ── Handler registry ────────────────────────────────────────────────────────

const handlers = new Map<JobType, JobHandler>();

/**
 * Register the handler for one job type. Throws on duplicate registration —
 * two handlers for one type is a wiring bug, never a merge.
 */
export function registerHandler(type: JobType, handler: JobHandler): void {
  if (!JOB_TYPE_SET.has(type)) {
    throw new Error(`INVALID_REQUEST: unknown job type '${type}'`);
  }
  if (typeof handler !== 'function') {
    throw new Error('INVALID_REQUEST: handler must be a function');
  }
  if (handlers.has(type)) {
    throw new Error(`INVALID_REQUEST: handler already registered for job type '${type}'`);
  }
  handlers.set(type, handler);
}

/** Test/maintenance utility: clear the global handler registry. */
export function resetHandlerRegistry(): void {
  handlers.clear();
}

// ── System-actor Authorization (§3.6 actor authority rule) ───────────────────

/**
 * Nil UUID reserved for the background system actor. It is never a real
 * person row — the job itself is the authority (it was enqueued by an
 * authorized user); the worker verifies org match, not user permissions.
 */
export const SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000000';

/**
 * Build an org-scoped Authorization for background execution.
 * org_id comes from the JOB ROW — never from the payload.
 */
export function buildJobAuthorization(job: Job): Authorization {
  const requestId = randomUUID();
  return Object.freeze({
    ctx: Object.freeze({ personId: SYSTEM_ACTOR_ID, orgId: job.orgId, aal: 'aal1' as const }),
    permission: 'jobs.retry', // worker-plane authority: start/complete/fail gate on jobs.retry
    scope: 'GLOBAL' as const,
    aal: 'aal1' as const,
    requestId,
    meta: Object.freeze({ requestId, ip: null, userAgent: null }),
  }) as Authorization;
}

// ── Worker-plane DB (no per-request identity; same model as queue.ts) ─────────

async function withWorkerDb<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await connectWithWake();
  try {
    const db = drizzle(client);
    return await db.transaction(fn);
  } finally {
    client.release();
  }
}

// ── Claim release & retry backoff (worker-plane, do NOT belong in queue.ts) ──

/**
 * Hand a claimed/running job back to the queue without burning an attempt:
 * status → pending, claim fields cleared, due immediately. Runs through
 * public.jobs_release_claim() (SECURITY DEFINER, migration 0050) — the
 * worker plane carries no per-request identity, so a raw UPDATE would match
 * zero rows under the FORCED RLS on public.jobs. The function's guarded
 * WHERE makes this a no-op if the job already moved on (e.g. the handler
 * finished and completeJob won the race): it returns false and we move on.
 */
async function releaseClaim(workerId: string, job: Job): Promise<void> {
  await withWorkerDb(async (tx) => {
    await tx.execute<{ released: string }>(
      sql`select public.jobs_release_claim(${job.id}, ${workerId})::text as released`,
    );
  });
}

/**
 * failJob() (§3.2) always stamps next_run_at = now(). For a retryable failure
 * the contract requires exponential backoff, so the worker applies it here.
 * Runs through public.jobs_apply_backoff() (SECURITY DEFINER, migration
 * 0050) — a raw UPDATE would be fail-closed against the FORCED RLS. The
 * function is guarded to 'failed', so a concurrent dead_letter transition
 * can never pick up a backoff delay.
 */
async function applyRetryBackoff(job: Job, delayMs: number): Promise<void> {
  const nextRunAt = new Date(Date.now() + Math.max(0, delayMs));
  await withWorkerDb(async (tx) => {
    await tx.execute<{ backoff_applied: string }>(
      sql`select public.jobs_apply_backoff(${job.id}, ${nextRunAt})::text as backoff_applied`,
    );
  });
}

// ── Job execution ───────────────────────────────────────────────────────────

interface InFlightJob {
  job: Job;
  auth: Authorization;
  abort: AbortController;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

interface WorkerState {
  shuttingDown: boolean;
  current: InFlightJob | null;
  shutdownTimer: ReturnType<typeof setTimeout> | null;
  settle: () => void;
}

/**
 * Execute one claimed job. Never throws: every failure is converted to
 * failJob so the loop survives a poison job.
 */
async function executeJob(
  workerId: string,
  heartbeatIntervalMs: number,
  job: Job,
  state: WorkerState,
): Promise<void> {
  const auth = buildJobAuthorization(job);
  const handler = handlers.get(job.type);

  if (!handler) {
    // No code path can ever succeed for this job — dead-letter it directly.
    // workerId is passed so the system-actor call takes the SECURITY
    // DEFINER privilege path (0047) instead of the permission gate.
    await failJob(
      auth,
      job.id,
      {
        code: 'CONFIG_ERROR',
        message: `no handler registered for job type '${job.type}'`,
        retryable: false,
      },
      false,
      workerId,
    ).catch(() => undefined);
    return;
  }

  try {
    await startJob(auth, job.id, workerId);
  } catch {
    // Lost the claim between claim and start (reaped or cancelled elsewhere).
    return;
  }

  const abort = new AbortController();
  const inFlight: InFlightJob = { job, auth, abort, heartbeatTimer: null };
  state.current = inFlight;

  inFlight.heartbeatTimer = setInterval(() => {
    heartbeatJob(workerId, job.id).catch(() => {
      // The claim is gone (reaped or released): another worker owns this job
      // now — stop doing work it will redo.
      abort.abort();
    });
  }, heartbeatIntervalMs);

  try {
    await handler({ job, auth, signal: abort.signal });
    try {
      await completeJob(auth, job.id, undefined, workerId);
    } catch {
      // Lost the claim mid-execution (reaper reset it to pending): the job
      // will be retried; the worker must not crash here.
    }
  } catch (err) {
    const jobError = classifyError(err);
    const attempts = job.attempts + 1;
    const willRetry = jobError.retryable && attempts < job.maxAttempts;
    try {
      await failJob(auth, job.id, jobError, jobError.retryable, workerId);
      if (willRetry) {
        await applyRetryBackoff(job, backoffDelayMs(job.attempts));
      }
    } catch {
      // failJob raced a reaper/shutdown release: the job is already pending.
    }
  } finally {
    if (inFlight.heartbeatTimer !== null) clearInterval(inFlight.heartbeatTimer);
    if (state.current === inFlight) state.current = null;
    if (state.shuttingDown) {
      // The in-flight job finished after a shutdown signal: cancel the
      // release deadline and let runWorker resolve.
      if (state.shutdownTimer !== null) {
        clearTimeout(state.shutdownTimer);
        state.shutdownTimer = null;
      }
      state.settle();
    }
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────

/**
 * Run the worker until SIGTERM/SIGINT. Resolves after graceful shutdown:
 * stop claiming → abort the in-flight job's signal → wait up to
 * shutdownTimeoutMs → release the claim if the handler ignored the abort →
 * resolve. The caller owns process lifetime (call process.exit after).
 *
 * The claim/execute loop runs detached: the returned promise resolves on
 * shutdown even if a handler never honors the abort signal (its claim is
 * released so the job is retried, not lost).
 */
export function runWorker(config: WorkerConfig): Promise<void> {
  const workerId = config.workerId;
  if (!workerId || workerId.length > 128) {
    return Promise.reject(new Error('INVALID_REQUEST: workerId is required (max 128 chars)'));
  }
  const types = config.types && config.types.length > 0 ? config.types : undefined;
  const pollIntervalMs = config.pollIntervalMs ?? 1000;
  const pollMaxIdleMs =
    config.pollMaxIdleMs !== undefined && Number.isFinite(config.pollMaxIdleMs)
      ? config.pollMaxIdleMs
      : 10000;
  // The ceiling never sits below the base interval: a misconfigured
  // pollMaxIdleMs degrades to constant pollIntervalMs polling, never to
  // sleeping less than the base interval between claims.
  const maxIdleSleepMs = Math.max(pollIntervalMs, pollMaxIdleMs);
  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? 15000;
  const shutdownTimeoutMs = config.shutdownTimeoutMs ?? 30000;
  const retrySweepIntervalMs = config.retrySweepIntervalMs ?? 30000;
  const reapIntervalMs = config.reapIntervalMs ?? 300000;
  const reminderSweepIntervalMs = config.reminderSweepIntervalMs ?? 60000;
  const maintenanceIntervalMs = config.maintenanceIntervalMs ?? 3600000;
  const deepSleep = config.idleMode === 'deep-sleep';
  const activeWindowMs = Math.max(0, config.activeWindowMs ?? 60000);
  const maxSleepMs = Math.min(
    MAX_DEEP_SLEEP_MS,
    Math.max(pollIntervalMs, config.maxSleepMs ?? 7200000),
  );
  const schedulerTickIntervalMs = config.schedulerTickIntervalMs ?? 60000;
  const latch = config.wakeLatch ?? new WakeLatch();
  if (deepSleep && typeof config.nextDueAt !== 'function') {
    return Promise.reject(new Error("INVALID_REQUEST: idleMode 'deep-sleep' requires nextDueAt"));
  }

  let settled = false;
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });

  const state: WorkerState = {
    shuttingDown: false,
    current: null,
    shutdownTimer: null,
    settle,
  };

  const onShutdown = (): void => {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    // Cut any idle or deep sleep short so the loop sees the shutdown now.
    latch.ring();
    state.current?.abort.abort();
    if (state.current === null) {
      // Idle: nothing in flight, resolve immediately.
      settle();
      return;
    }
    // In-flight: wait for the handler to honor the abort, up to the deadline.
    state.shutdownTimer = setTimeout(() => {
      const inFlight = state.current;
      state.current = null;
      state.shutdownTimer = null;
      void (async () => {
        if (inFlight) {
          if (inFlight.heartbeatTimer !== null) clearInterval(inFlight.heartbeatTimer);
          // The handler ignored the abort: hand the claim back so the job is
          // retried instead of lost.
          await releaseClaim(workerId, inFlight.job).catch(() => undefined);
        }
        // The loop is still awaiting the uncooperative handler, so clean up
        // the signal listeners here instead of the loop's finally block.
        process.removeListener('SIGTERM', onShutdown);
        process.removeListener('SIGINT', onShutdown);
        settle();
      })();
    }, shutdownTimeoutMs);
  };

  const loop = async (): Promise<void> => {
    try {
      let nextRetrySweepMs = Date.now() + retrySweepIntervalMs;
      let nextReapMs = Date.now() + reapIntervalMs;
      let nextReminderSweepMs = Date.now() + reminderSweepIntervalMs;
      let nextMaintenanceMs = Date.now() + maintenanceIntervalMs;
      let nextSchedulerTickMs = Date.now() + schedulerTickIntervalMs;
      // Adaptive idle poll (Phase 12, F-12-04): the sleep after an empty
      // claim starts at pollIntervalMs and doubles up to maxIdleSleepMs;
      // any claimed job resets it to pollIntervalMs.
      let idleSleepMs = pollIntervalMs;

      // ── deep-sleep (WP-W) state ──────────────────────────────────────────
      // A fresh worker starts ACTIVE and runs every pass at once: overdue work
      // left by a restart, a crash or a long suspend is drained before any sleep.
      let activeUntil = Date.now() + activeWindowMs;
      let lastPastDue: number | null = null;
      const firstBackoffMs = Math.min(DEEP_SLEEP_ERROR_BACKOFF_MS, maxSleepMs);
      let stuckBackoffMs = firstBackoffMs;
      let errorBackoffMs = firstBackoffMs;
      const becomeActive = () => {
        const t = Date.now();
        activeUntil = t + activeWindowMs;
        idleSleepMs = pollIntervalMs;
        // Every timer the worker honours is looked at immediately on a wake.
        nextRetrySweepMs = t;
        nextReapMs = t;
        nextReminderSweepMs = t;
        nextSchedulerTickMs = t;
        config.onActive?.(t);
      };
      if (deepSleep) {
        becomeActive();
        // Maintenance is gated by its own interval; on start, run it now.
        nextMaintenanceMs = Date.now();
      }

      while (!state.shuttingDown) {
        if (deepSleep && config.schedulerTick && Date.now() >= nextSchedulerTickMs) {
          nextSchedulerTickMs = Date.now() + schedulerTickIntervalMs;
          await config.schedulerTick().catch(() => undefined);
        }
        if (retrySweepIntervalMs > 0 && Date.now() >= nextRetrySweepMs) {
          // Automatic retry: re-drive retryable 'failed' jobs whose backoff
          // elapsed back to 'pending'. A DB blip must never kill the worker.
          nextRetrySweepMs = Date.now() + retrySweepIntervalMs;
          await sweepRetryableJobs().catch(() => undefined);
        }
        if (reapIntervalMs > 0 && Date.now() >= nextReapMs) {
          // Crash recovery: reset claims whose heartbeat went stale back to
          // 'pending' (the abandoned attempt counts). Same failure posture
          // as the retry sweep — a DB blip must never kill the worker.
          nextReapMs = Date.now() + reapIntervalMs;
          await reapStaleJobs().catch(() => undefined);
        }
        if (reminderSweepIntervalMs > 0 && Date.now() >= nextReminderSweepMs) {
          // Task reminders (P1b, AUD-04): claim due reminders and deliver
          // them as TASK_DUE notifications (0064 claim definer). Same
          // failure posture as the sweeps above — a DB blip must never
          // kill the worker; per-reminder errors are isolated inside the
          // sweep itself.
          nextReminderSweepMs = Date.now() + reminderSweepIntervalMs;
          await sweepDueTaskReminders().catch(() => undefined);
        }
        if (maintenanceIntervalMs > 0 && Date.now() >= nextMaintenanceMs) {
          // Audit partitions + data retention (WP-2, 0065). runDbMaintenance
          // never throws and logs its own failures; the catch is belt and
          // braces — a maintenance problem must never kill the worker.
          nextMaintenanceMs = Date.now() + maintenanceIntervalMs;
          await runDbMaintenance().catch(() => undefined);
        }
        let job: Job | null = null;
        let claimFailed = false;
        try {
          job = await claimJob(workerId, types);
        } catch {
          // A claim failure (DB blip, privilege path hiccup) must never kill
          // the worker — back off and keep polling. Queue state is unknown
          // after an error, so the idle backoff restarts from the base
          // interval rather than staying at the deep-idle ceiling. In
          // deep-sleep mode a failure past the active window falls through to
          // the deep-sleep back-off below instead of polling a database that
          // is not answering.
          claimFailed = true;
          idleSleepMs = pollIntervalMs;
        }
        if (job === null) {
          if (!deepSleep || Date.now() < activeUntil) {
            const outcome = await latch.sleep(claimFailed ? pollIntervalMs : idleSleepMs);
            if (outcome === 'woken' && deepSleep && !state.shuttingDown) becomeActive();
            else if (!claimFailed) idleSleepMs = Math.min(idleSleepMs * 2, maxIdleSleepMs);
            continue;
          }

          // ── Deep sleep: nothing to do and the active window has passed. ──
          let sleepMs: number;
          let lookup: { ok: true; dueAt: Date | null } | { ok: false };
          try {
            lookup = { ok: true, dueAt: await config.nextDueAt!() };
            errorBackoffMs = firstBackoffMs;
          } catch (error) {
            // Database unavailable (suspended, quota, network). Never crash and never
            // spin: back off, doubling up to maxSleepMs. Queued work stays in Postgres.
            console.warn('[worker] next-due lookup failed; retrying after back-off', {
              backoffMs: errorBackoffMs,
              sqlstate: sqlstateOf(error),
            });
            lookup = { ok: false };
          }
          if (!lookup.ok) {
            sleepMs = errorBackoffMs;
            errorBackoffMs = Math.min(errorBackoffMs * 2, maxSleepMs);
          } else {
            const { dueAt } = lookup;
            const now = Date.now();
            if (dueAt === null) {
              sleepMs = maxSleepMs;
              lastPastDue = null;
            } else if (dueAt.getTime() <= now) {
              // Overdue. The wake passes just ran, so a due item that is still due
              // will not clear by itself (a type no handler takes, a pass that keeps
              // failing). Staying active for it would keep the database awake for
              // ever; back off instead, loudly, doubling up to maxSleepMs.
              if (lastPastDue !== dueAt.getTime()) {
                lastPastDue = dueAt.getTime();
                stuckBackoffMs = firstBackoffMs;
                becomeActive();
                continue;
              }
              console.warn('[worker] overdue work did not clear after a full pass', {
                dueAt: dueAt.toISOString(),
                backoffMs: stuckBackoffMs,
              });
              sleepMs = stuckBackoffMs;
              stuckBackoffMs = Math.min(stuckBackoffMs * 2, maxSleepMs);
            } else {
              lastPastDue = null;
              sleepMs = Math.min(dueAt.getTime() - now, maxSleepMs);
            }
          }
          config.onDeepSleep?.(Date.now(), sleepMs);
          await latch.sleep(sleepMs);
          if (!state.shuttingDown) becomeActive();
          continue;
        }
        idleSleepMs = pollIntervalMs;
        activeUntil = Date.now() + activeWindowMs;
        await executeJob(workerId, heartbeatIntervalMs, job, state);
      }
    } finally {
      process.removeListener('SIGTERM', onShutdown);
      process.removeListener('SIGINT', onShutdown);
      if (state.shutdownTimer !== null) clearTimeout(state.shutdownTimer);
    }
    settle();
  };

  process.once('SIGTERM', onShutdown);
  process.once('SIGINT', onShutdown);

  // Detached: the returned promise settles on shutdown even while the loop is
  // still awaiting an uncooperative handler.
  void loop().then(
    () => undefined,
    () => settle(), // defensive: executeJob never throws, but never hang the caller
  );
  return done;
}

// ── Crash recovery: reaper ───────────────────────────────────────────────────

/**
 * Validate the reaper threshold before touching the DB — fail fast on a
 * wiring bug. The 0049 function re-validates server-side; this client check
 * avoids opening a connection for a doomed call.
 */
function validateStaleThreshold(thresholdMs: number): number {
  if (!Number.isFinite(thresholdMs) || thresholdMs < 0) {
    throw new Error('INVALID_REQUEST: thresholdMs must be a non-negative number');
  }
  return thresholdMs;
}

/**
 * Crash recovery: reset jobs whose heartbeat went stale to 'pending' with
 * attempts+1 (the abandoned attempt counts), clearing the claim so another
 * worker can retry them. Runs through public.jobs_reap_stale()
 * (SECURITY DEFINER, migration 0049) — the worker plane carries no
 * per-request identity, so a raw UPDATE would match zero rows under the
 * FORCED RLS on public.jobs. Returns the number of jobs reaped.
 *
 * Wired (Phase 12, F-12-02): runner.ts calls this once at startup, before
 * the first claim, and runWorker() calls it on the reapIntervalMs cadence.
 * Lease expiry therefore no longer depends on the per-org cleanup job —
 * that job remains only as the retention tool (terminal-row deletion).
 */
export async function reapStaleJobs(thresholdMs = 60000): Promise<number> {
  const safeThreshold = validateStaleThreshold(thresholdMs);
  const reaped = await withWorkerDb(async (tx) => {
    const rows = await tx.execute<{ reaped: string }>(
      sql`select public.jobs_reap_stale(${safeThreshold})::text as reaped`,
    );
    return Number(rows.rows[0]?.reaped ?? 0);
  });
  return reaped;
}

// ── Low-cost mode: when is anything next due? (WP-W) ─────────────────────────

/**
 * The earliest instant any pending job, retryable failed job, stale-claim reap, unsent
 * task reminder or active schedule falls due — public.worker_next_due_at() (SECURITY
 * DEFINER, migration 0066; the worker plane has no identity, so a plain read would match
 * nothing under FORCED RLS). null when nothing is pending anywhere. Throws on database
 * errors; the deep-sleep loop backs off on a throw.
 */
export async function workerNextDueAt(): Promise<Date | null> {
  const rows = await withWorkerDb((tx) =>
    tx.execute<{ due_at: string | null }>(sql`select public.worker_next_due_at()::text as due_at`),
  );
  const value = rows.rows[0]?.due_at ?? null;
  if (value === null) return null;
  const due = new Date(value);
  if (!Number.isFinite(due.getTime())) throw new Error('INTERNAL: unparseable next-due instant');
  return due;
}
