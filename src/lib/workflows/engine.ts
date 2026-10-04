/**
 * Phase 5 Workflow Engine — Execution Orchestrator (A8, Wave 2)
 *
 * Implements the §13 execution contract: `runWorkflowsForEvent(auth, event)`
 * matches ACTIVE workflows, then for each one — sequentially (Phase 5; no
 * parallelism) — claims an execution row (idempotent on dedup key), loads the
 * source record under the trigger actor's RLS, evaluates conditions, and runs
 * actions, recording every step. Manual runs go through the same pipeline via
 * `executeWorkflowManual` (for A9's `/execute` route).
 *
 * ── CONTRACTS WITH A4–A7 (imported, never redefined) ─────────────────────
 *   A4 events.ts      WorkflowEvent (this module owns the runner entry)
 *   A5 triggers.ts    findMatchingWorkflows(auth, event) -> MatchedWorkflow[]
 *   A6 conditions.ts  evaluateConditions(conditions, snapshot, event)
 *   A7 actions.ts     executeAction(auth, event, action, context) (never throws);
 *                     executeActionResolved(auth, event, action, resolvedParams)
 *                     — single template resolution (P2-2), used by the engine;
 *                     resolveTemplates(params, context) (throws INVALID_REQUEST);
 *                     TemplateContext = { event, deal?, task?, project? }
 *   A2 schema.ts      ActionConfig / ConditionNode types
 *   A1 0044          SECURITY DEFINER record functions (exact signatures
 *                     verified 2026-10-04 against drizzle/0044_workflow_engine.sql):
 *                     workflow_record_execution(uuid,int,text,text,text,uuid,text,uuid) -> uuid (NULL on dedup conflict)
 *                     workflow_finish_execution(uuid,text,jsonb,text,text,uuid) -> void (terminal statuses only)
 *                     workflow_record_step(uuid,int,text,jsonb,uuid) -> uuid
 *                     workflow_finish_step(uuid,text,jsonb,text,text,uuid) -> void
 *                     (F9: trailing p_org_id asserted against the ctx org)
 *
 * ── DESIGN NOTES ─────────────────────────────────────────────────────────
 *   D2 execution authority: every DB call goes through withAuthorizedDb with
 *      the trigger actor's real Authorization — actions inherit exactly the
 *      actor's permissions (executeAction calls the existing services).
 *   D3 the engine never breaks the originating mutation: the async entry
 *      awaits the pipeline inline (D1) inside try/catch so it never throws
 *      and never rejects to the caller (the A4 dispatcher adds its own
 *      wrapper on top).
 *   D4 recursion is bounded in the A4 dispatcher (depth guard, 5/request);
 *      idempotency is enforced by the (workflow_id, dedup_key) unique
 *      constraint — a NULL return from workflow_record_execution is the
 *      "already ran" no-op.
 *   PENDING → RUNNING: workflow_finish_execution only accepts TERMINAL
 *      statuses, so the single record call claims the execution directly in
 *      'RUNNING' (the definer accepts PENDING/RUNNING/SUCCEEDED/FAILED/CANCELLED
 *      as the initial status).
 *   Snapshot mapping: deal.is_won/is_lost prefer the event payload's
 *      isWon/isLost when present (the deal.stage_changed emitter carries the
 *      authoritative pipeline-stage flags, audit §6); otherwise they fall back
 *      to derivation from the legacy `stage` enum (WON/LOST), which the §5
 *      dual-write keeps consistent.
 *
 * Owner: A8. Other agents MUST NOT modify this file.
 */
import { createHash, randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '../db/authorized';
import type { Authorization } from '../authz/require-permission';
import { AuthorizationError } from '../authz/errors';
import { getDeal } from '@/lib/crm/deals';
import type { Deal } from '@/lib/crm/schema';
import { getTask } from '@/lib/work/tasks';
import { getProject } from '@/lib/work/projects';
import type { Project, Task } from '@/lib/work/schema';
import type { WorkflowEvent } from './events';
import { findMatchingWorkflows, type MatchedWorkflow } from './triggers';
import { evaluateConditions, type ConditionSnapshot } from './conditions';
import {
  executeActionResolved,
  resolveTemplates,
  type ActionResult,
  type TemplateContext,
} from './actions';
import type { ActionConfig, ConditionNode } from './schema';

// ── Constants ─────────────────────────────────────────────────────────────────

/** DB-side caps: error_message is capped at 2000 chars by the definer; the
 *  engine truncates first so the definer never raises on a runaway message. */
const MAX_ERROR_MESSAGE_CHARS = 2000;

/** Definer-side cap (workflow_record_execution raises 22001 above this). */
const MAX_DEDUP_KEY_CHARS = 256;

/**
 * Bounds a (workflow, event) dedup key to the definer's cap. Short keys pass
 * through unchanged (stable, human-readable); overlong keys are hashed with
 * sha256 instead of sliced, so distinct long keys stay distinct (P2-5).
 */
function boundedDedupKey(workflowId: string, eventDedupKey: string): string {
  const full = `${workflowId}:${eventDedupKey}`;
  if (full.length <= MAX_DEDUP_KEY_CHARS) return full;
  const digest = createHash('sha256').update(full).digest('hex');
  return `${full.slice(0, MAX_DEDUP_KEY_CHARS - digest.length - 1)}:${digest}`;
}

// ── Failure reporting ─────────────────────────────────────────────────────────

function reportEngineFailure(error: unknown, extra: Record<string, unknown>): void {
  console.error('[workflows] engine failure', { ...extra, error });
  Sentry.captureException(error, {
    tags: { source: 'workflow-engine' },
    extra,
  });
}

/** Error messages recorded on executions/steps: sanitized (no raw DB errors,
 *  NUL-stripped, length-capped — the audit §17 contract). */
function sanitizeStoredMessage(message: string): string {
  return message.replace(/\0/g, '').slice(0, MAX_ERROR_MESSAGE_CHARS);
}

/** Normalizes a resolveTemplates throw into a recorded failure. */
function templateFailure(error: unknown): { code: string; message: string } {
  if (error instanceof Error && error.message.startsWith('INVALID_REQUEST:')) {
    return {
      code: 'INVALID_REQUEST',
      message: error.message.slice('INVALID_REQUEST:'.length).trim(),
    };
  }
  return { code: 'INTERNAL', message: 'failed to resolve action templates' };
}

// ── SECURITY DEFINER record helpers (D7) ──────────────────────────────────────

/**
 * Claims an execution row for (workflow, event). Returns the execution id,
 * or NULL when the (workflow_id, dedup_key) pair was already recorded — the
 * D4 idempotent no-op; the caller must skip the workflow in that case.
 *
 * Claimed directly in 'RUNNING': workflow_finish_execution only accepts
 * terminal statuses, and the record definer accepts RUNNING as an initial
 * status, so no second transition call is needed.
 */
async function recordExecutionStart(
  auth: Authorization,
  workflow: MatchedWorkflow,
  event: WorkflowEvent,
): Promise<string | null> {
  // workflow.id (36) + ':' + event.dedupKey, bounded by the definer's cap.
  // P2-5: on overflow the key is hashed (sha256), not sliced — two distinct
  // very-long keys can no longer collide into one dedup no-op.
  const dedupKey = boundedDedupKey(workflow.id, event.dedupKey);
  const result = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{ id: string | null }>(sql`
      select public.workflow_record_execution(
        ${workflow.id}::uuid,
        ${workflow.version}::int,
        ${dedupKey},
        ${event.type},
        ${event.entityType},
        ${event.entityId}::uuid,
        'RUNNING',
        ${auth.ctx.orgId}::uuid
      ) as id
    `),
  );
  return result.rows[0]?.id ?? null;
}

/** Closes an execution with a terminal status (the definer computes
 *  finished_at/duration_ms server-side). */
async function finishExecution(
  auth: Authorization,
  executionId: string,
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
  resultSummary: Record<string, unknown>,
  errorCode?: string,
  errorMessage?: string,
): Promise<void> {
  await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute(sql`
      select public.workflow_finish_execution(
        ${executionId}::uuid,
        ${status},
        ${JSON.stringify(resultSummary)}::jsonb,
        ${errorCode ?? null},
        ${errorMessage === undefined ? null : sanitizeStoredMessage(errorMessage)},
        ${auth.ctx.orgId}::uuid
      )
    `),
  );
}

/** Best-effort terminal record: used when a workflow dies mid-processing so
 *  its execution row is never left stuck in RUNNING. Never throws. */
async function finishExecutionSafely(
  auth: Authorization,
  executionId: string,
  resultSummary: Record<string, unknown>,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  try {
    await finishExecution(auth, executionId, 'FAILED', resultSummary, errorCode, errorMessage);
  } catch {
    // Already reporting the original failure; a stuck RUNNING row is the
    // lesser evil versus masking the root cause.
  }
}

async function recordStep(
  auth: Authorization,
  executionId: string,
  stepIndex: number,
  actionType: string,
  actionParams: Record<string, unknown>,
): Promise<string> {
  const result = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{ id: string }>(sql`
      select public.workflow_record_step(
        ${executionId}::uuid,
        ${stepIndex}::int,
        ${actionType},
        ${JSON.stringify(actionParams)}::jsonb,
        ${auth.ctx.orgId}::uuid
      ) as id
    `),
  );
  const stepId = result.rows[0]?.id;
  if (stepId === undefined) {
    // Unreachable against the 0044 definer (it always returns the new id);
    // defensive so the pipeline never proceeds with an unrecorded step.
    throw new Error('workflow_record_step returned no step id');
  }
  return stepId;
}

async function finishStep(
  auth: Authorization,
  stepId: string,
  result: ActionResult,
): Promise<void> {
  const status = result.ok ? 'SUCCEEDED' : 'FAILED';
  await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute(sql`
      select public.workflow_finish_step(
        ${stepId}::uuid,
        ${status},
        ${result.output === undefined ? null : JSON.stringify(result.output)}::jsonb,
        ${status === 'FAILED' ? (result.errorCode ?? 'INTERNAL') : null},
        ${
          status === 'FAILED' ? sanitizeStoredMessage(result.errorMessage ?? 'action failed') : null
        },
        ${auth.ctx.orgId}::uuid
      )
    `),
  );
}

// ── Source-record snapshot (§11.1) ────────────────────────────────────────────

/**
 * Raised when the source record cannot be loaded for snapshotting. NOT_FOUND
 * (invisible / deleted / foreign) is the expected case; anything else is an
 * infrastructure failure — both close the execution FAILED, never thrown to
 * the mutation caller.
 */
class SnapshotLoadError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INTERNAL',
    message: string,
  ) {
    super(message);
    this.name = 'SnapshotLoadError';
  }
}

/**
 * Maps the camelCase service rows to the exact snake_case snapshot keys the
 * condition evaluator's allowlist (CONDITION_FIELD_TYPES, schema.ts) requires.
 *
 * Deal flags (P1-5): when the triggering event's payload carries the
 * authoritative isWon/isLost (the deal.stage_changed emitter provides them
 * from the pipeline-stage flags), those win — the audit §6 rule is "MUST use
 * is_won/is_lost flags, never stage names". Otherwise the flags fall back to
 * the legacy `stage` enum derivation (WON/LOST), which the §5 dual-write
 * keeps consistent.
 */
function toDealSnapshot(deal: Deal, event?: WorkflowEvent): Record<string, unknown> {
  const payload = event?.payload as { isWon?: unknown; isLost?: unknown } | undefined;
  const payloadIsWon = typeof payload?.isWon === 'boolean' ? payload.isWon : undefined;
  const payloadIsLost = typeof payload?.isLost === 'boolean' ? payload.isLost : undefined;
  return {
    value: deal.value,
    stage: deal.stage,
    is_won: payloadIsWon ?? deal.stage === 'WON',
    is_lost: payloadIsLost ?? deal.stage === 'LOST',
    probability: deal.probability,
    owner_person_id: deal.ownerPersonId,
    pipeline_id: deal.pipelineId,
    title: deal.title,
  };
}

function toTaskSnapshot(task: Task): Record<string, unknown> {
  return {
    status: task.status,
    priority: task.priority,
    assignee_person_id: task.assigneePersonId,
    project_id: task.projectId,
    due_date: task.dueDate,
  };
}

function toProjectSnapshot(project: Project): Record<string, unknown> {
  return {
    name: project.name,
    is_archived: project.isArchived,
  };
}

/**
 * Loads the event's source record under the trigger actor's own Authorization
 * (D2) and maps it to the condition snapshot. `manual` events (and any event
 * without an entity) get an empty snapshot — conditions then evaluate against
 * the `event.*` fields only, which the evaluator always supplies.
 */
async function buildSnapshot(
  auth: Authorization,
  event: WorkflowEvent,
): Promise<ConditionSnapshot> {
  if (event.entityId === null) return {};
  try {
    switch (event.entityType) {
      case 'deal':
        return { deal: toDealSnapshot(await getDeal(auth, event.entityId), event) };
      case 'task':
        return { task: toTaskSnapshot(await getTask(auth, event.entityId)) };
      case 'project':
        return { project: toProjectSnapshot(await getProject(auth, event.entityId)) };
      default:
        // company/contact events: no snapshot sections exist in the Phase-5
        // condition allowlist, so nothing is loaded.
        return {};
    }
  } catch (error) {
    if (error instanceof AuthorizationError && error.code === 'NOT_FOUND') {
      throw new SnapshotLoadError('NOT_FOUND', 'source record not visible');
    }
    throw new SnapshotLoadError('INTERNAL', 'failed to load the source record');
  }
}

// ── The §13 pipeline ──────────────────────────────────────────────────────────

/**
 * Runs one matched workflow through the full pipeline. Returns the execution
 * id, or null when the (workflow, event) pair was already recorded (D4
 * idempotent no-op). Never throws: infra failures are recorded FAILED and
 * reported to Sentry; a failure here never affects other workflows.
 */
async function processWorkflow(
  auth: Authorization,
  event: WorkflowEvent,
  workflow: MatchedWorkflow,
): Promise<string | null> {
  // (a) Claim the execution row. NULL = already ran → skip.
  let executionId: string;
  try {
    const claimed = await recordExecutionStart(auth, workflow, event);
    if (claimed === null) return null;
    executionId = claimed;
  } catch (error) {
    reportEngineFailure(error, {
      workflowId: workflow.id,
      type: event.type,
      phase: 'record-execution',
    });
    return null;
  }

  // From here the execution row exists in RUNNING: every failure path below
  // must close it FAILED so no run is left stuck.
  let completedSteps = 0;
  try {
    // (b) Snapshot the source record.
    let snapshot: ConditionSnapshot;
    try {
      snapshot = await buildSnapshot(auth, event);
    } catch (error) {
      if (error instanceof SnapshotLoadError) {
        await finishExecution(
          auth,
          executionId,
          'FAILED',
          { steps: 0, decision: 'snapshot_failed' },
          error.code,
          error.message,
        );
        return executionId;
      }
      throw error;
    }

    // (c) Conditions gate.
    const context: TemplateContext = {
      event,
      deal: snapshot.deal,
      task: snapshot.task,
      project: snapshot.project,
    };
    if (!evaluateConditions(workflow.conditions, snapshot, event)) {
      await finishExecution(auth, executionId, 'SUCCEEDED', {
        decision: 'skipped_conditions',
      });
      return executionId;
    }

    // (d) Actions, sequentially.
    for (let i = 0; i < workflow.actions.length; i += 1) {
      const action = workflow.actions[i] as ActionConfig | undefined;
      if (action === undefined) continue; // unreachable; guards noUncheckedIndexedAccess

      // Resolve templates FIRST so the step row stores the params that ran.
      let resolvedParams: Record<string, unknown>;
      try {
        resolvedParams = resolveTemplates(action.params as Record<string, unknown>, context);
      } catch (error) {
        const failure = templateFailure(error);
        const stepId = await recordStep(
          auth,
          executionId,
          i,
          action.type,
          (action.params ?? {}) as Record<string, unknown>,
        );
        await finishStep(auth, stepId, { ok: false, ...failure });
        await finishExecution(
          auth,
          executionId,
          'FAILED',
          { steps: completedSteps, failedStep: i, decision: 'template_failed' },
          failure.code,
          failure.message,
        );
        return executionId;
      }

      const stepId = await recordStep(auth, executionId, i, action.type, resolvedParams);
      // P2-2: resolvedParams were already template-resolved above (for the
      // step record) — executeActionResolved must NOT resolve again, or a
      // literal {{…}} inside user data fails the second pass.
      const result = await executeActionResolved(auth, event, action, resolvedParams);
      await finishStep(auth, stepId, result);
      completedSteps += 1;

      if (!result.ok) {
        // Stop the remaining actions; the failure is recorded on the step
        // and on the execution.
        await finishExecution(
          auth,
          executionId,
          'FAILED',
          { steps: completedSteps, failedStep: i },
          result.errorCode ?? 'INTERNAL',
          result.errorMessage ?? 'action failed',
        );
        return executionId;
      }
    }

    // (e) All steps ok.
    await finishExecution(auth, executionId, 'SUCCEEDED', { steps: completedSteps });
    return executionId;
  } catch (error) {
    await finishExecutionSafely(
      auth,
      executionId,
      { steps: completedSteps, decision: 'processing_failed' },
      'INTERNAL',
      'workflow processing failed unexpectedly',
    );
    reportEngineFailure(error, {
      workflowId: workflow.id,
      executionId,
      type: event.type,
      phase: 'process-workflow',
    });
    return executionId;
  }
}

/**
 * The §13 async pipeline. Matching failure is contained here (Sentry + return)
 * so a DB outage in the matcher can never break the originating mutation (D3).
 */
async function runWorkflowsForEventAsync(auth: Authorization, event: WorkflowEvent): Promise<void> {
  let matched: MatchedWorkflow[];
  try {
    matched = await findMatchingWorkflows(auth, event);
  } catch (error) {
    reportEngineFailure(error, { type: event.type, phase: 'trigger-match' });
    return;
  }

  // Sequential per Phase 5 (no parallelism); one workflow's failure never
  // affects the others (each processWorkflow is self-contained).
  for (const workflow of matched) {
    await processWorkflow(auth, event, workflow);
  }
}

/**
 * Engine entry (A4's dispatcher calls this). NEVER throws and never rejects
 * to the caller: the async pipeline is awaited inline in the request (D1) and
 * its failures are logged + reported to Sentry (D3).
 */
export async function runWorkflowsForEvent(
  auth: Authorization,
  event: WorkflowEvent,
): Promise<void> {
  try {
    await runWorkflowsForEventAsync(auth, event);
  } catch (error) {
    reportEngineFailure(error, { type: event.type });
  }
}

// ── Manual execution (for A9's POST /api/workflows/[id]/execute) ──────────────

type ManualWorkflowRow = {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly conditions: unknown;
  readonly actions: unknown;
};

/**
 * Executes one workflow on demand (manual trigger). The executing user is the
 * trigger actor (D2): the permission gate below plus the actor's RLS on every
 * service call means the run can do no more than that user could do directly.
 *
 * Requires `workflows.execute` (defense in depth — A9's route also enforces it
 * via requirePermission) and an ACTIVE, non-deleted workflow. The manual event
 * carries a fresh-uuid dedupKey, so every manual run executes exactly once.
 * The RLS SELECT policy on workflows requires `workflows.view`, so in practice
 * manual execution also requires view access (the seeds grant execute-holders
 * view as well).
 *
 * Returns the execution id. Throws INVALID_REQUEST for non-ACTIVE workflows,
 * NOT_FOUND for missing/foreign workflows, FORBIDDEN without workflows.execute.
 */
export async function executeWorkflowManual(
  auth: Authorization,
  workflowId: string,
  input?: unknown,
): Promise<{ executionId: string }> {
  // Permission gate: manual runs must not escalate beyond the caller.
  const permissionCheck = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{ ok: boolean }>(sql`select authz.has('workflows.execute') as ok`),
  );
  if (permissionCheck.rows[0]?.ok !== true) {
    throw new AuthorizationError('FORBIDDEN', {
      requestId: auth.requestId,
      reason: 'PERMISSION_DENIED',
    });
  }

  const rows = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<ManualWorkflowRow>(sql`
      select id, version, status, conditions, actions
      from public.workflows
      where id = ${workflowId}::uuid
        and deleted_at is null
    `),
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new AuthorizationError('NOT_FOUND', {
      requestId: auth.requestId,
      reason: 'TARGET_NOT_VISIBLE',
    });
  }
  if (row.status !== 'ACTIVE') {
    throw new Error('INVALID_REQUEST: only ACTIVE workflows can be executed');
  }
  if (!Array.isArray(row.conditions) || !Array.isArray(row.actions)) {
    // Corrupt definition — must not execute blindly.
    throw new Error('INVALID_REQUEST: workflow has corrupt conditions/actions');
  }

  const workflow: MatchedWorkflow = {
    id: row.id,
    version: row.version,
    conditions: row.conditions as ConditionNode[],
    actions: row.actions as ActionConfig[],
  };

  const event: WorkflowEvent = {
    id: randomUUID(),
    orgId: auth.ctx.orgId,
    actorPersonId: auth.ctx.personId,
    occurredAt: new Date().toISOString(),
    type: 'manual',
    entityType: null,
    entityId: null,
    dedupKey: randomUUID(),
    payload: input === undefined ? { workflowId } : { workflowId, input },
  };

  const executionId = await processWorkflow(auth, event, workflow);
  if (executionId === null) {
    // Unreachable with a fresh-uuid dedupKey, but fail loudly rather than
    // returning a null id.
    throw new Error('INTERNAL: manual execution was deduplicated unexpectedly');
  }
  return { executionId };
}
