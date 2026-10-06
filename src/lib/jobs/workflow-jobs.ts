/**
 * Phase 6 — Workflow Integration (Workflow Integration Engineer owns this file)
 *
 * Bridges the Phase 5 workflow engine to Phase 6 background execution.
 * This module NEVER re-implements Phase 5 logic: it resolves the job's
 * execution Authorization and delegates to the Phase 5 engine entry points
 * (`dispatchWorkflowEvent`, `executeWorkflowManual`). engine.ts is read-only
 * here — any engine gap is documented, not patched.
 *
 * ── CONTRACTS ─────────────────────────────────────────────────────────────
 *   Architecture contracts §3.6 (workflow-jobs.ts), §3.4 (worker registration).
 *   Queue Engineer owns src/lib/jobs/types.ts — READ ONLY, never redefined.
 *   Worker Runtime Engineer owns src/lib/jobs/worker.ts — `registerHandler`
 *   is imported from there per contract §3.4.
 *
 * ── EXECUTION AUTHORITY (§3.6 + 0048) ──────────────────────────────────────
 *   The orgId ALWAYS comes from the job ROW (verified by the definer),
 *   never from the payload. The job itself is the authority (it was
 *   enqueued by an authorized user); the worker verifies org match, not
 *   user permissions.
 *
 *   The system actor (`system:job:<id>` / nil UUID) is NOT a row in
 *   public.people, so authz.person_id() → NULL, authz.org_id() → NULL,
 *   authz.has(_) → false, authz.is_active() → false for it: Phase 5's
 *   executeWorkflowManual gate (authz.has('workflows.execute')) raised
 *   FORBIDDEN, the manual workflow row was RLS-invisible, and even the 0044
 *   SECURITY DEFINER record functions raised for that identity. Driving the
 *   engine as the system actor could never work end-to-end (P0, 2026-10-06).
 *
 *   Instead, resolveJobExecutionAuth() calls the 0048 SECURITY DEFINER
 *   workflow_execute_as_job(p_job_id) on the worker plane (withQueueDb, no
 *   ambient identity — the definer verifies everything from the job row).
 *   The definer asserts type IN ('workflow_run','scheduled_trigger') and
 *   status = 'running' (reachable only through the claimed_by-checked
 *   jobs_start, so exactly one legitimate worker holds the job), then
 *   returns the verified (org_id, person_id) execution principal bound to
 *   that row: jobs.enqueued_by for 'workflow_run' (stamped at enqueue from
 *   the enqueueing user's identity), or the schedule owner for
 *   'scheduled_trigger'. The engine then runs under that REAL person's
 *   Authorization — every Phase 5 gate (authz.has, RLS policies,
 *   authz.is_active()) evaluates against them, live, at execution time, so
 *   suspension / permission revocation / org deactivation between enqueue
 *   and execution fails closed. D2 holds: actions inherit exactly the
 *   authorizing principal's permissions.
 *
 *   The worker gains NO ambient Phase 5 permissions: it can only obtain an
 *   execution identity by presenting a job it holds the claim for, and the
 *   identity comes from the job row — never chosen by the worker. The
 *   definer takes no org_id, workflow_id, or person_id parameter, so there
 *   is no cross-org path. (Option B — provisioning workflows.execute to a
 *   per-org system actor — was rejected: it would need an unbounded set of
 *   standing permissions and make the worker a per-org super-user.)
 *
 * ── STEP-LEVEL IDEMPOTENCY — ENGINE GAP (documented for the architect) ────
 *   ActionConfig already carries an optional `key` (P2-1, schema.ts), but the
 *   Phase 5 engine's recordStep() calls
 *     workflow_record_step(execution_id, step_index, action_type, action_params, org_id)
 *   with NO step_key parameter, and the 0044 SECURITY DEFINER function does not
 *   accept one either. The 0045 migration adds the step_key COLUMN + unique
 *   index, so the storage is ready — but the record path cannot write it
 *   without (a) an engine.ts change (recordStep signature — this agent MUST NOT
 *   modify engine.ts) and (b) a 0044 definer signature change (DB engineer
 *   territory). Until both land, step-level idempotency is enforced by the
 *   (workflow_id, dedup_key) execution dedup only.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '../db/authorized';
import type { Authorization } from '../authz/require-permission';
import type { AuthContext } from '../db/context';
import type { RequestMetadata } from '../audit/log';
import { type WorkflowEvent, type WorkflowEventInput } from '../workflows/events';
import { executeWorkflowManual, runWorkflowsForEvent } from '../workflows/engine';
import { WORKFLOW_TRIGGER_TYPES } from '../workflows/schema';
import { cronWindowStart } from './cron';
import { WorkflowRunPayloadSchema, type Job, type JobType } from './types';
import { registerHandler, type JobExecutionContext } from './worker';
import { withQueueDb } from './queue';

// ── D4 depth guard ────────────────────────────────────────────────────────────

/**
 * Maximum chained-dispatch depth per originating request (D4).
 *
 * GAP (for the architect): the canonical bound lives in Phase 5
 * src/lib/workflows/events.ts as module-private `MAX_DISPATCH_DEPTH` — it is
 * NOT exported, and this agent MUST NOT modify events.ts to export it. The
 * value (5) is mirrored here. Request: export MAX_DISPATCH_DEPTH from
 * events.ts and import it here instead of this mirror.
 *
 * The Phase 5 ALS-based guard resets per job (each job builds a fresh
 * Authorization object, so the per-request depth context starts at 0), which
 * is why the bound is enforced here against the payload-carried depth too.
 */
const MAX_DISPATCH_DEPTH = 5;

// ── Error helpers ─────────────────────────────────────────────────────────────

/**
 * Throws an error that the Phase 6 retry classifier (retry.ts classifyError)
 * marks NON-retryable: the `code` is drawn from NON_RETRYABLE_CODES, so the
 * job goes to failed/dead_letter instead of burning retries on a doomed run.
 */
function nonRetryable(code: string, message: string): never {
  const error = new Error(message);
  error.name = 'WorkflowJobError';
  (error as { code?: string }).code = code;
  throw error;
}

// ── Payload validation ────────────────────────────────────────────────────────

/**
 * Strict validation of the event input carried in a workflow_run payload.
 * The queue-level WorkflowRunPayloadSchema (Queue Engineer) keeps eventInput
 * loose (z.record); this handler tightens it to the real WorkflowEventInput
 * contract before handing it to the Phase 5 dispatcher. ZodError classifies
 * as non-retryable (retry.ts), so a malformed payload dead-letters.
 */
const WorkflowJobEventInputSchema = z.strictObject({
  type: z.enum(WORKFLOW_TRIGGER_TYPES),
  entityType: z.enum(['deal', 'task', 'project', 'company', 'contact']).nullable(),
  entityId: z.string().uuid().nullable(),
  dedupKey: z.string().min(1).max(256),
  payload: z.record(z.string(), z.unknown()),
});

/** Pass-through manual input (contract §3.6: { dedupKey?: string }). */
const WorkflowJobManualInputSchema = z
  .strictObject({
    dedupKey: z.string().min(1).max(256).optional(),
  })
  .catchall(z.unknown());

/**
 * scheduled_trigger payload (contract §3.6): { scheduleId, workflowId }.
 * windowStart is accepted when present (matches the queue-level
 * ScheduledTriggerPayloadSchema); otherwise it is derived from the schedule
 * row's last_run_at.
 */
const ScheduledTriggerJobPayloadSchema = z.strictObject({
  scheduleId: z.string().uuid(),
  workflowId: z.string().uuid(),
  windowStart: z.string().datetime({ offset: true }).optional(),
});

type ScheduleRow = {
  readonly id: string;
  readonly orgId: string;
  readonly workflowId: string;
  readonly cron: string;
  readonly timezone: string;
  readonly isActive: boolean;
  readonly lastRunAt: string | null;
};

// ── Job execution Authorization (§3.6 + 0048) ─────────────────────────────────

/**
 * The verified execution principal returned by the 0048 SECURITY DEFINER.
 * Both fields come from the JOB ROW (via the definer) — never from the
 * payload, never chosen by the worker.
 */
type ExecutionPrincipal = {
  readonly orgId: string;
  readonly personId: string;
};

/**
 * Resolves the job's execution Authorization through the 0048 SECURITY
 * DEFINER `workflow_execute_as_job(p_job_id)`, called on the worker plane
 * (withQueueDb — no ambient identity; the definer verifies everything from
 * the job row, so the caller identity is irrelevant).
 *
 * The definer asserts type IN ('workflow_run','scheduled_trigger') and
 * status = 'running' (reachable only through the claimed_by-checked
 * jobs_start, so exactly one legitimate worker holds the job), then returns
 * the (org_id, person_id) principal bound to that row. The returned org is
 * re-checked against the job row here (defense in depth, §3.6 actor
 * authority rule).
 *
 * Error mapping: the definer raises 22023 for job-row verification failures
 * (not found / wrong type / not running / dangling schedule ref) — retrying
 * can never succeed, so these become non-retryable VALIDATION_ERROR
 * (dead-letter, no retry burn). 42501 principal failures (no/inactive/
 * wrong-org principal, no live engagement) propagate untouched to the
 * normal retry classifier — a re-activated user can succeed on retry.
 *
 * NOTE on shape: the task contract names `permissions: ['workflows.execute']`,
 * but the Authorization interface (src/lib/authz/require-permission.ts) has a
 * singular `permission: string` field — this uses `permission:
 * 'workflows.execute'` to match the real interface. scope is GLOBAL: the
 * execution runs within the job's org only, and the org boundary (not a
 * department/team slice) is the correct breadth for background workflow
 * execution.
 */
async function resolveJobExecutionAuth(job: Job): Promise<Authorization> {
  let principal: ExecutionPrincipal;
  try {
    const result = await withQueueDb((tx) =>
      tx.execute<{ org_id: string; person_id: string }>(sql`
        select org_id, person_id
        from public.workflow_execute_as_job(${job.id}::uuid)
      `),
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('workflow_execute_as_job returned no row');
    }
    principal = { orgId: row.org_id, personId: row.person_id };
  } catch (error) {
    if ((error as { code?: unknown }).code === '22023') {
      nonRetryable(
        'VALIDATION_ERROR',
        `[jobs] workflow job ${job.id}: execution-identity verification failed ` +
          `(job not found, wrong type, or not running) — dropped as non-retryable`,
      );
    }
    throw error;
  }

  if (principal.orgId !== job.orgId) {
    nonRetryable(
      'FORBIDDEN',
      `[jobs] workflow job ${job.id}: execution org does not match the job row`,
    );
  }

  const ctx: AuthContext = {
    personId: principal.personId,
    orgId: principal.orgId,
    aal: 'aal1',
  };
  const requestId = randomUUID();
  const meta: RequestMetadata = { requestId, ip: null, userAgent: null };
  return {
    ctx,
    permission: 'workflows.execute',
    scope: 'GLOBAL',
    aal: 'aal1',
    requestId,
    meta,
  };
}

// ── 'workflow_run' handler ────────────────────────────────────────────────────

/**
 * Handler for 'workflow_run' jobs (contract §3.6):
 *
 * 1. Validates the payload (queue-level WorkflowRunPayloadSchema, then the
 *    strict WorkflowEventInput / manualInput schemas). A payload carrying
 *    neither input dead-letters here, before any DB round-trip.
 * 2. Enforces the D4 depth guard: depth is read from the payload (default 0);
 *    depth > MAX_DISPATCH_DEPTH throws non-retryable (dead-letter, no retry
 *    burn). Note dispatchWorkflowEvent itself never throws (D3), so this
 *    explicit guard is the depth enforcement on the job path.
 * 3. Resolves the execution Authorization through the 0048 definer: the job
 *    runs under the REAL principal that authorized it (jobs.enqueued_by),
 *    so Phase 5's authz.has('workflows.execute') gate, the RLS policies, and
 *    authz.is_active() all evaluate against that person, live.
 * 4. eventInput → build the full WorkflowEvent and call runWorkflowsForEvent
 *    directly (bypassing dispatchWorkflowEvent — the worker IS the background
 *    path; re-entering the dispatcher would re-enqueue when WORKFLOWS_USE_QUEUE
 *    is on). The Phase 5 engine enforces dedup via the (workflow_id, dedup_key)
 *    unique constraint — a re-delivered job is an idempotent no-op, never a
 *    duplicate run.
 * 5. manualInput → executeWorkflowManual(auth, workflowId, manualInput).
 *
 * If both eventInput and manualInput are present, eventInput wins (documented
 * choice; the queue schema permits both but they are meant to be exclusive).
 *
 * runWorkflowsForEvent never throws, so an event-path job "succeeds" even
 * when the engine records the execution FAILED — the failure is recorded on
 * the workflow execution row itself, which is the observable record.
 */
export async function handleWorkflowRun(ctx: JobExecutionContext): Promise<void> {
  const { job } = ctx;

  // Queue-level shape first (ZodError → non-retryable, no retry burn).
  const payload = WorkflowRunPayloadSchema.parse(job.payload);

  // D4 depth guard BEFORE any engine call. Non-retryable: a deeper retry
  // would trip the same guard forever.
  const depth = payload.depth ?? 0;
  if (depth > MAX_DISPATCH_DEPTH) {
    nonRetryable(
      'VALIDATION_ERROR',
      `[jobs] workflow_run job ${job.id}: depth ${depth} exceeds the D4 dispatch bound ` +
        `(${MAX_DISPATCH_DEPTH}) — dropped as non-retryable`,
    );
  }

  // Validate the engine input before resolving the execution identity: a
  // malformed payload dead-letters without spending a DB round-trip.
  let eventInput: WorkflowEventInput | undefined;
  let manualInput: unknown;
  if (payload.eventInput !== undefined) {
    eventInput = WorkflowJobEventInputSchema.parse(payload.eventInput);
  } else if (payload.manualInput !== undefined) {
    manualInput = WorkflowJobManualInputSchema.parse(payload.manualInput);
  } else {
    nonRetryable(
      'VALIDATION_ERROR',
      `[jobs] workflow_run job ${job.id}: payload carries neither eventInput nor manualInput`,
    );
  }

  // The job is the authority: run Phase 5 under the verified execution
  // principal (0048), not the system actor.
  const auth = await resolveJobExecutionAuth(job);

  if (eventInput !== undefined) {
    // Bypass the dispatcher: the worker IS the background execution path.
    // Calling dispatchWorkflowEvent here would re-enter the queue branch
    // (fresh Authorization → depth 0 → re-enqueue) when WORKFLOWS_USE_QUEUE
    // is on, and the shared dedup key would make it a silent no-op — the
    // event would never execute. Build the full event and run the engine
    // inline, exactly as the dispatcher's inline path does.
    const fullEvent: WorkflowEvent = {
      ...eventInput,
      id: randomUUID(),
      orgId: auth.ctx.orgId,
      actorPersonId: auth.ctx.personId,
      occurredAt: new Date().toISOString(),
    };
    await runWorkflowsForEvent(auth, fullEvent);
    return;
  }

  await executeWorkflowManual(auth, payload.workflowId, manualInput);
}

// ── 'scheduled_trigger' handler ───────────────────────────────────────────────

/**
 * Handler for 'scheduled_trigger' jobs (contract §3.6):
 *
 * 1. Resolves the execution Authorization through the 0048 definer: for a
 *    scheduled_trigger job the principal is the schedule OWNER
 *    (schedules.created_by) — cron runs as the crontab owner.
 * 2. Loads the schedule row under that principal's identity, re-stating
 *    org_id on the query. A missing or foreign-org schedule yields zero
 *    rows → NOT_FOUND, non-retryable.
 * 3. Verifies the schedule's workflow_id matches the payload's workflowId
 *    (defense in depth: the job must not run a workflow the schedule doesn't
 *    bind).
 * 4. Inactive schedule → no-op success (the tick deactivates instead of
 *    deleting; firing a dead schedule is a no-op, not a failure).
 * 5. Synthesizes a 'scheduled' eventInput with
 *    dedupKey = `sched:${scheduleId}:${window}` (window = minute-precision UTC
 *    of the fired window) and delegates to the workflow_run logic, so depth
 *    guarding and dispatch stay in one place.
 */
export async function handleScheduledTrigger(ctx: JobExecutionContext): Promise<void> {
  const { job } = ctx;
  const payload = ScheduledTriggerJobPayloadSchema.parse(job.payload);
  const auth = await resolveJobExecutionAuth(job);

  const rows = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<ScheduleRow>(sql`
      select id,
             org_id as "orgId",
             workflow_id as "workflowId",
             cron,
             timezone,
             is_active as "isActive",
             last_run_at as "lastRunAt"
      from public.schedules
      where id = ${payload.scheduleId}::uuid
        and org_id = ${auth.ctx.orgId}::uuid
    `),
  );
  const schedule = rows.rows[0];
  if (schedule === undefined) {
    nonRetryable(
      'NOT_FOUND',
      `[jobs] scheduled_trigger job ${job.id}: schedule ${payload.scheduleId} ` +
        `not found in org ${auth.ctx.orgId}`,
    );
  }
  if (schedule.workflowId !== payload.workflowId) {
    nonRetryable(
      'VALIDATION_ERROR',
      `[jobs] scheduled_trigger job ${job.id}: schedule ${payload.scheduleId} binds ` +
        `workflow ${schedule.workflowId}, not payload workflow ${payload.workflowId}`,
    );
  }
  if (!schedule.isActive) {
    console.log('[jobs] scheduled_trigger: schedule inactive, no-op', {
      jobId: job.id,
      scheduleId: schedule.id,
    });
    return;
  }

  const window =
    payload.windowStart ??
    (schedule.lastRunAt !== null
      ? cronWindowStart(new Date(schedule.lastRunAt))
      : cronWindowStart(new Date()));

  const eventInput: WorkflowEventInput = {
    type: 'scheduled',
    entityType: null,
    entityId: null,
    dedupKey: `sched:${schedule.id}:${window}`,
    payload: {
      scheduleId: schedule.id,
      workflowId: schedule.workflowId,
      cron: schedule.cron,
      timezone: schedule.timezone,
      windowStart: window,
    },
  };

  // Delegate to the workflow_run logic: one depth guard, one dispatch path.
  const scheduledCtx: JobExecutionContext = {
    ...ctx,
    job: {
      ...job,
      type: 'workflow_run' satisfies JobType,
      payload: { workflowId: schedule.workflowId, eventInput, depth: 0 },
    },
  };
  await handleWorkflowRun(scheduledCtx);
}

// ── Registration (contract §3.4) ──────────────────────────────────────────────

registerHandler('workflow_run', handleWorkflowRun);
registerHandler('scheduled_trigger', handleScheduledTrigger);
