import type { Authorization } from '@/lib/authz/require-permission';
import { JOB_TYPE_SET, type Job, type JobType } from './types';

/**
 * The job-handler registry: the contract between the queue and whatever executes its jobs.
 *
 * A handler registers itself for one job type (registerHandler); the worker loop looks it up when
 * it claims a job (getRegisteredHandler). It lives in the queue core, below both sides, so that a
 * domain module that owns a job type (the Sales Sheet import) can register its handler without
 * importing the worker, and the worker (src/worker) imports it downward (ADR-010 rule 5). The
 * code below is unchanged from its former home in the worker loop; only getRegisteredHandler is
 * new, replacing the loop's direct read of the map.
 */

export type JobHandler = (ctx: JobExecutionContext) => Promise<void>;

export interface JobExecutionContext {
  job: Job;
  /** Org-scoped system-actor Authorization synthesized from the job row (§3.6). */
  auth: Authorization;
  /** Fires on SIGTERM/SIGINT so the handler can stop cooperatively. */
  signal: AbortSignal;
  /**
   * The id this worker claimed the job under. Worker-plane readers bound to the
   * held job (job_email_content_for_worker, 0069) check it against claimed_by.
   */
  workerId: string;
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

/** The handler registered for a job type, or undefined (the worker loop fails the job). */
export function getRegisteredHandler(type: JobType): JobHandler | undefined {
  return handlers.get(type);
}
