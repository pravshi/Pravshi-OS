/**
 * Phase 5 Workflow Engine — Event System (A4, Wave 1; reworked 2026-10-04)
 *
 * WHEN should services call `dispatchWorkflowEvent`?
 *
 *   Only AFTER the originating mutation has committed. `withAuthorizedDb(ctx, tx => …)`
 *   commits when the awaited promise resolves, so the call site is ALWAYS:
 *   "after `await withAuthorizedDb(…)` resolves" — never inside the transaction.
 *   Emitting post-commit guarantees the event snapshot reflects committed state and
 *   that the dispatcher can never break the caller's mutation (it never throws).
 *
 * Usage example for the integration agents (A10–A12), 10 lines:
 * ```
 * import { dispatchWorkflowEvent, buildDedupKey } from '@/lib/workflows/events';
 *
 * await withAuthorizedDb(auth.ctx, (tx) => moveDealToStageTx(tx, dealId, stageId));
 *
 * // Post-commit: hand the engine the domain event. Awaited, never throws.
 * await dispatchWorkflowEvent(auth, {
 *   type: 'deal.stage_changed',
 *   entityType: 'deal',
 *   entityId: dealId,
 *   dedupKey: buildDedupKey('deal_stage_history', historyId),
 *   payload: { fromStageId, toStageId, isWon, isLost, dealId, dealTitle, dealValue },
 * });
 * ```
 *
 * Execution authority: workflow actions run under the trigger actor's own
 * `Authorization` (D2) — a workflow can never do what its actor cannot.
 * Recursion is bounded at depth 5 per request (D4) by the AsyncLocalStorage
 * depth guard below.
 *
 * Transport: inline by default, queue opt-in (Phase 6 wiring).
 *
 *   Inline (default): the engine runs awaited inside the requesting HTTP
 *   call (D1). Rationale: on the serverless target the function may freeze
 *   once the response is sent, so a fire-and-forget kickoff is not
 *   guaranteed to run — and inline needs zero new infrastructure. This is
 *   the safe default; the queue flag changes nothing unless it is set.
 *
 *   Queue (opt-in): set WORKFLOWS_USE_QUEUE=true (src/env.ts) ONLY when a
 *   dedicated Phase 6 worker is running to claim and execute `workflow_run`
 *   jobs. Top-level dispatches (depth 0) are then enqueued instead of
 *   running inline, so the HTTP request returns immediately. Chained
 *   re-dispatches (depth > 0) ALWAYS stay inline — D4's per-request depth
 *   bound is preserved, and the queue never becomes a recursion mechanism.
 *
 *   Fallbacks (D3 — the event is never dropped, the caller never breaks):
 *   if enqueueing throws for any reason — the queue module fails to load,
 *   the caller lacks `jobs.create`, payload validation fails, or the DB
 *   errors — the dispatcher logs a warning and runs the engine inline.
 *
 *   Known follow-up (RESOLVED 2026-10-06): the worker's handleWorkflowRun
 *   (jobs/workflow-jobs.ts) now bypasses this dispatcher and calls
 *   runWorkflowsForEvent directly with a fully-stamped event, so the queue
 *   branch can never re-enter from the worker path. The flag is safe to
 *   enable wherever a Phase 6 worker is running.
 */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as Sentry from '@sentry/nextjs';
import { env } from '@/env';
import type { Authorization } from '../authz/require-permission';
// Implemented by A8 (Execution Orchestrator): the real pipeline
// (match → evaluate → execute) per §13 of the architecture audit.
import { runWorkflowsForEvent } from './engine';
import { WORKFLOW_TRIGGER_TYPES, type WorkflowTriggerType } from './schema';

/**
 * Phase-5 trigger types — the canonical definition lives in `./schema` (the
 * cycle-free module); re-exported here so existing import sites
 * (`@/lib/workflows/events`) keep working.
 */
export { WORKFLOW_TRIGGER_TYPES, type WorkflowTriggerType };

/** The event contract per §9 of the architecture audit. orgId/actorPersonId are
 *  derived from the caller's Authorization — never from input. */
export interface WorkflowEvent {
  readonly id: string; // uuid, one per emission
  readonly orgId: string; // from auth.ctx — never from input
  readonly type: WorkflowTriggerType;
  readonly entityType: 'deal' | 'task' | 'project' | 'company' | 'contact' | null;
  readonly entityId: string | null;
  readonly actorPersonId: string; // auth.ctx.personId
  readonly occurredAt: string; // ISO-8601
  readonly dedupKey: string; // stable per source occurrence
  readonly payload: Readonly<Record<string, unknown>>; // trigger-specific snapshot
}

/** Input accepted by `dispatchWorkflowEvent`: the caller supplies the domain
 *  facts; identity fields are stamped from the Authorization. */
export type WorkflowEventInput = Omit<
  WorkflowEvent,
  'id' | 'orgId' | 'actorPersonId' | 'occurredAt'
>;

/**
 * Joins the non-empty parts with `:`, e.g.
 * `buildDedupKey('deal_stage_history', historyId)` →
 * `'deal_stage_history:<uuid>'`. Used by integration agents for stable
 * dedup keys (D4: the engine makes re-delivery a no-op on dedup key).
 */
export function buildDedupKey(...parts: string[]): string {
  return parts.filter((p) => p !== '').join(':');
}

/** Maximum chained-dispatch depth per originating request (D4). */
const MAX_DISPATCH_DEPTH = 5;

/**
 * Chained-dispatch depth, carried across the async engine pipeline.
 *
 * The previous design used a module-global counter incremented around a
 * fire-and-forget engine kickoff — the counter was decremented before the
 * first DB await resolved, so every chained dispatch observed depth 0 and the
 * D4 bound never tripped in production (P0-1, 2026-10-04). The engine now
 * runs awaited inline in the request (D1), and chained dispatches execute
 * inside the incremented ALS context, so the guard observes the true depth.
 * A module-global would also leak across concurrent requests; ALS is
 * per-async-context by construction.
 */
const dispatchDepthStorage = new AsyncLocalStorage<number>();

/**
 * Fallback depth tracker for environments where AsyncLocalStorage context
 * is lost (e.g., Neon serverless driver's fetch-based Pool in CI).
 * Keyed by Authorization object (same object flows through the entire
 * dispatch → engine → action → dispatch chain). WeakMap ensures no leaks.
 */
const fallbackDepthByAuth = new WeakMap<object, number>();

function getDispatchDepth(auth: Authorization): number {
  // Primary: AsyncLocalStorage (works with pg driver, local dev)
  const alsDepth = dispatchDepthStorage.getStore();
  if (alsDepth !== undefined) return alsDepth;
  // Fallback: WeakMap by auth object (robust against ALS context loss)
  return fallbackDepthByAuth.get(auth) ?? 0;
}

function setFallbackDepth(auth: Authorization, depth: number): void {
  fallbackDepthByAuth.set(auth, depth);
}

/**
 * Phase 6 queue transport for `dispatchWorkflowEvent` (opt-in via
 * WORKFLOWS_USE_QUEUE=true). Enqueues a `workflow_run` job carrying the raw
 * event input; the worker's handleWorkflowRun re-dispatches it, and the
 * Phase 5 engine re-selects the matching workflows at execution time.
 *
 * Returns true when the job was accepted, false on ANY failure — the caller
 * then falls back to inline execution (D3: the originating mutation must
 * never break because the queue is unavailable, and a caller without
 * `jobs.create` must not silently drop the event).
 *
 * Dynamic import, not static: this module is imported BY jobs/workflow-jobs.ts
 * (the handler calls dispatchWorkflowEvent), so a static import of the queue
 * would risk an import cycle and would pull the drizzle queue module into
 * every request path. The queue module loads lazily, only when the flag is on.
 */
async function tryEnqueueWorkflowEvent(
  auth: Authorization,
  event: WorkflowEventInput,
): Promise<boolean> {
  try {
    const { enqueueJob } = await import('@/lib/jobs/queue');
    await enqueueJob(auth, {
      type: 'workflow_run',
      payload: {
        // WorkflowRunPayloadSchema requires workflowId, but at dispatch time
        // the engine has not selected any workflow yet — matching happens at
        // execution. The placeholder satisfies the schema; handleWorkflowRun
        // ignores it on the eventInput path (it is only read for manualInput).
        workflowId: randomUUID(),
        eventInput: event,
        depth: 0,
      },
      // Idempotent enqueue: a redelivered source event reuses its dedup key,
      // so the queue returns the existing job instead of duplicating it.
      dedupKey: event.dedupKey,
    });
    return true;
  } catch (error) {
    console.warn('[workflows] queue enqueue failed — falling back to inline execution', {
      type: event.type,
      dedupKey: event.dedupKey,
      error,
    });
    return false;
  }
}

/**
 * Dispatches a workflow event to the Phase 5 engine and awaits the pipeline
 * inline in the request (D1: in-request execution; no queue in Phase 5).
 *
 * NEVER THROWS (and never rejects) to the caller: engine failures are caught,
 * logged to console.error, and reported to Sentry, so a workflow fault can
 * never break the originating mutation (D3).
 *
 * Depth guard (D4): chained workflow actions that re-dispatch are bounded at
 * 5 deliveries per originating request; the 6th and deeper dispatches are
 * dropped with a Sentry breadcrumb.
 */
export async function dispatchWorkflowEvent(
  auth: Authorization,
  event: WorkflowEventInput,
): Promise<void> {
  try {
    const depth = getDispatchDepth(auth);
    if (depth >= MAX_DISPATCH_DEPTH) {
      console.error('[workflows] dispatch depth guard tripped — event dropped', {
        type: event.type,
        depth,
      });
      Sentry.addBreadcrumb({
        category: 'workflows',
        level: 'warning',
        message: 'dispatch depth guard tripped — event dropped',
        data: { type: event.type, depth },
      });
      return;
    }

    // Phase 6 opt-in queue transport: a TOP-LEVEL dispatch (depth 0) is
    // enqueued as a `workflow_run` job instead of running inline, so the HTTP
    // request returns without executing workflows. Chained re-dispatches
    // (depth > 0) always stay inline — the D4 depth guard is per originating
    // request, and the queue is a transport, never a recursion mechanism.
    // Enqueue failure (missing jobs.create, validation/DB error) falls back
    // to inline — D3, the event is never dropped.
    if (depth === 0 && env.WORKFLOWS_USE_QUEUE === 'true') {
      if (await tryEnqueueWorkflowEvent(auth, event)) {
        return;
      }
    }

    const fullEvent: WorkflowEvent = {
      ...event,
      id: randomUUID(),
      orgId: auth.ctx.orgId,
      actorPersonId: auth.ctx.personId,
      occurredAt: new Date().toISOString(),
    };

    // Awaited inline (D1): on the serverless target the function may freeze
    // once the response is sent, so a fire-and-forget kickoff is not
    // guaranteed to run. The incremented ALS context is what makes the D4
    // depth guard hold across the async pipeline.
    // Fallback: also set WeakMap depth so the guard holds even if ALS
    // context is lost (e.g., Neon serverless driver in CI).
    const nextDepth = depth + 1;
    setFallbackDepth(auth, nextDepth);
    try {
      await dispatchDepthStorage.run(nextDepth, () => runWorkflowsForEvent(auth, fullEvent));
    } finally {
      // Restore previous fallback depth (or delete if was 0)
      if (depth === 0) {
        fallbackDepthByAuth.delete(auth);
      } else {
        setFallbackDepth(auth, depth);
      }
    }
  } catch (error) {
    // The originating mutation must not fail because of the engine.
    console.error('[workflows] event dispatch failed — event dropped', {
      type: event.type,
      error,
    });
    Sentry.captureMessage('workflow event dispatch failed', {
      level: 'error',
      tags: { type: event.type },
      extra: {
        entityType: event.entityType,
        entityId: event.entityId,
        dedupKey: event.dedupKey,
      },
    });
  }
}
