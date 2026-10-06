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
 * public.jobs and match zero rows forever.
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
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? 15000;
  const shutdownTimeoutMs = config.shutdownTimeoutMs ?? 30000;
  const retrySweepIntervalMs = config.retrySweepIntervalMs ?? 30000;

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
      while (!state.shuttingDown) {
        if (retrySweepIntervalMs > 0 && Date.now() >= nextRetrySweepMs) {
          // Automatic retry: re-drive retryable 'failed' jobs whose backoff
          // elapsed back to 'pending'. A DB blip must never kill the worker.
          nextRetrySweepMs = Date.now() + retrySweepIntervalMs;
          await sweepRetryableJobs().catch(() => undefined);
        }
        let job: Job | null;
        try {
          job = await claimJob(workerId, types);
        } catch {
          // A claim failure (DB blip, privilege path hiccup) must never kill
          // the worker — back off and keep polling.
          await sleep(pollIntervalMs);
          continue;
        }
        if (job === null) {
          await sleep(pollIntervalMs);
          continue;
        }
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
 * Run at worker startup and/or on a periodic cleanup job.
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
