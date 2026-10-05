import { sql } from 'drizzle-orm';
import { z, ZodError, type ZodType } from 'zod';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { assertTargetAffected, type Authorization } from '@/lib/authz/require-permission';
import { AuthorizationError } from '@/lib/authz/errors';
import { writeAuditEntry } from '@/lib/audit/log';
import { executeWorkflowManual } from './engine';
import {
  ActionConfigSchema,
  ConditionNodeSchema,
  CreateWorkflowSchema,
  IMPLEMENTED_TRIGGER_TYPES,
  TriggerConfigSchema,
  UpdateWorkflowSchema,
  WorkflowStatusSchema,
  type ActionConfig,
  type ConditionNode,
  type CreateWorkflowInput,
  type TriggerConfig,
  type WorkflowStatus,
} from './schema';

/**
 * Workflow definition service (Phase 5). Trust boundaries:
 *
 *  - org_id always comes from auth.ctx.orgId, never from the caller; every
 *    query re-states the org predicate explicitly (defense in depth over RLS)
 *  - created_by / updated_by are stamped from auth.ctx.personId on write,
 *    never from the body
 *  - zod runs at the service boundary (parseRequest), so route handlers stay
 *    thin and invalid input becomes Error('INVALID_REQUEST: …') → 400 via
 *    src/lib/workflows/http.ts
 *  - an UPDATE/DELETE that touches zero rows is NOT_FOUND through
 *    assertTargetAffected — the same concealment as an invisible target
 *    (deleted vs invisible vs foreign is never distinguished)
 *  - status transitions are validated here: only DRAFT/PAUSED → ACTIVE and
 *    ACTIVE → PAUSED; activating a workflow whose trigger.type has no Phase-5
 *    runtime (scheduled / webhook / task.overdue) is rejected INVALID_REQUEST
 *  - manual execution delegates to the engine's executeWorkflowManual(); the
 *    caller is the trigger actor (D2), the engine enforces ACTIVE-only
 *
 * Wire shapes (§14): camelCase; the workflow row carries
 *   { id, name, description, status, trigger, conditions, actions, version,
 *     createdBy, createdAt, updatedAt, lastExecutionAt?, lastExecutionStatus? }.
 */

// ── Local boundary validation (mirrors the work/crm parseRequest; not
//    imported cross-domain so the workflows module stays self-contained) ────

function parseRequest<T>(schema: ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      const first = error.issues[0];
      const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
      throw new Error(`INVALID_REQUEST: ${where}${first?.message ?? 'invalid input'}`);
    }
    throw error;
  }
}

function isPgCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/** A 23505 from the (org_id, name) unique index becomes the 400 it deserves. */
function invalidWorkflowConflict(error: unknown): never {
  if (isPgCode(error, '23505')) {
    throw new Error('INVALID_REQUEST: a workflow with this name already exists');
  }
  throw error;
}

/**
 * Check that the caller holds a workflow permission, before validating input.
 * This ensures unauthorized callers get FORBIDDEN (not INVALID_REQUEST) when
 * they lack the permission, matching the auth-gate test expectations.
 */
async function requireWorkflowPermission(auth: Authorization, permission: string): Promise<void> {
  const check = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{ ok: boolean }>(sql`select authz.has(${permission}) as ok`),
  );
  if (check.rows[0]?.ok !== true) {
    throw new AuthorizationError('FORBIDDEN', {
      requestId: auth.requestId,
      reason: 'PERMISSION_DENIED',
    });
  }
}

// ── Query schemas ─────────────────────────────────────────────────────────────

const ListWorkflowsQuerySchema = z.strictObject({
  search: z.string().trim().max(128).optional(),
  status: WorkflowStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const ListExecutionsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

/** POST /api/workflows/[id]/execute body: { input? } — input is opaque and
 *  passed through to the manual event payload. */
const ExecuteWorkflowBodySchema = z.strictObject({
  input: z.unknown().optional(),
});

// ── Row types ─────────────────────────────────────────────────────────────────

export type Workflow = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: WorkflowStatus;
  readonly trigger: TriggerConfig;
  readonly conditions: ConditionNode[];
  readonly actions: ActionConfig[];
  readonly version: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastExecutionAt: string | null;
  readonly lastExecutionStatus: string | null;
};

export type WorkflowPage = {
  readonly rows: Workflow[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
};

export type WorkflowExecution = {
  readonly id: string;
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly status: string;
  readonly triggerType: string;
  readonly sourceEntityType: string | null;
  readonly sourceEntityId: string | null;
  readonly triggeredBy: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly resultSummary: Record<string, unknown>;
  readonly createdAt: string;
};

export type WorkflowExecutionStep = {
  readonly id: string;
  readonly executionId: string;
  readonly stepIndex: number;
  readonly actionType: string;
  readonly actionParams: Record<string, unknown>;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly result: Record<string, unknown> | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
};

export type WorkflowExecutionDetail = WorkflowExecution & {
  readonly steps: readonly WorkflowExecutionStep[];
};

export type ExecutionPage = {
  readonly rows: WorkflowExecution[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
};

export type ExecuteWorkflowResult = {
  readonly executionId: string;
  readonly status: string;
};

// ── SQL fragments ─────────────────────────────────────────────────────────────

const WORKFLOW_COLUMNS = sql`
  w.id,
  w.name,
  w.description,
  w.status,
  w.trigger,
  w.conditions,
  w.actions,
  w.version,
  w.created_by as "createdBy",
  w.created_at as "createdAt",
  w.updated_at as "updatedAt"
`;

/** Most recent run per workflow, for the list/detail last-run summary. */
const LAST_EXECUTION_SELECT = sql`
  le.started_at as "lastExecutionAt",
  le.status as "lastExecutionStatus"
`;
const LAST_EXECUTION_JOIN = sql`
  left join lateral (
    select e.started_at, e.status
    from public.workflow_executions e
    where e.workflow_id = w.id
      and e.org_id = w.org_id
    order by e.started_at desc, e.id desc
    limit 1
  ) le on true
`;

const WORKFLOW_WHERE = (auth: Authorization) => sql`
  w.org_id = ${auth.ctx.orgId}::uuid
  and w.deleted_at is null
`;

const EXECUTION_COLUMNS = sql`
  e.id,
  e.workflow_id as "workflowId",
  e.workflow_version as "workflowVersion",
  e.status,
  e.trigger_type as "triggerType",
  e.source_entity_type as "sourceEntityType",
  e.source_entity_id as "sourceEntityId",
  e.triggered_by as "triggeredBy",
  e.started_at as "startedAt",
  e.finished_at as "finishedAt",
  e.duration_ms as "durationMs",
  e.error_code as "errorCode",
  e.error_message as "errorMessage",
  e.result_summary as "resultSummary",
  e.created_at as "createdAt"
`;

const STEP_COLUMNS = sql`
  s.id,
  s.execution_id as "executionId",
  s.step_index as "stepIndex",
  s.action_type as "actionType",
  s.action_params as "actionParams",
  s.status,
  s.started_at as "startedAt",
  s.finished_at as "finishedAt",
  s.duration_ms as "durationMs",
  s.result,
  s.error_code as "errorCode",
  s.error_message as "errorMessage",
  s.created_at as "createdAt"
`;

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * P2-3: a workflow row whose stored JSONB fails schema validation (hand-edited
 * corrupt row) maps to null — callers skip it (list) or treat it as missing
 * (detail), instead of 500ing on an unchecked cast.
 */
type WorkflowRow = Omit<Workflow, 'trigger' | 'conditions' | 'actions'> & {
  readonly trigger: unknown;
  readonly conditions: unknown;
  readonly actions: unknown;
};

function toWorkflow(row: WorkflowRow): Workflow | null {
  const trigger = TriggerConfigSchema.safeParse(row.trigger);
  const conditions = z.array(ConditionNodeSchema).safeParse(row.conditions);
  const actions = z.array(ActionConfigSchema).safeParse(row.actions);
  if (!trigger.success || !conditions.success || !actions.success) {
    console.error('[workflows] skipping corrupt workflow row', { id: row.id });
    return null;
  }
  return {
    ...row,
    trigger: trigger.data,
    conditions: conditions.data,
    actions: actions.data,
  };
}

export async function listWorkflows(auth: Authorization, input: unknown): Promise<WorkflowPage> {
  const query = parseRequest(ListWorkflowsQuerySchema, input ?? {});
  const searchWhere = query.search ? sql` and w.name ilike ${query.search} || '%'` : sql``;
  const statusWhere = query.status ? sql` and w.status = ${query.status}` : sql``;
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const [rows, counts] = await Promise.all([
      tx.execute<WorkflowRow>(sql`
        select ${WORKFLOW_COLUMNS}, ${LAST_EXECUTION_SELECT}
        from public.workflows w
        ${LAST_EXECUTION_JOIN}
        where ${WORKFLOW_WHERE(auth)} ${searchWhere} ${statusWhere}
        order by w.updated_at desc, w.id asc
        limit ${query.limit} offset ${query.offset}
      `),
      tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.workflows w
        where ${WORKFLOW_WHERE(auth)} ${searchWhere} ${statusWhere}
      `),
    ]);
    // Corrupt rows are skipped with a warning (P2-3); the total stays the
    // DB count.
    const valid: Workflow[] = [];
    for (const row of rows.rows) {
      const workflow = toWorkflow(row);
      if (workflow !== null) valid.push(workflow);
    }
    return {
      rows: valid,
      total: counts.rows[0]?.total ?? 0,
      limit: query.limit,
      offset: query.offset,
    };
  });
}

export async function getWorkflow(auth: Authorization, id: string): Promise<Workflow> {
  const row = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<WorkflowRow>(sql`
      select ${WORKFLOW_COLUMNS}, ${LAST_EXECUTION_SELECT}
      from public.workflows w
      ${LAST_EXECUTION_JOIN}
      where ${WORKFLOW_WHERE(auth)}
        and w.id = ${id}::uuid
    `);
    return res.rows[0] ?? null;
  });
  // A corrupt row is concealed as missing (NOT_FOUND), like invisible vs
  // foreign — the detail page never 500s on it (P2-3).
  const workflow = row === null ? null : toWorkflow(row);
  await assertTargetAffected(auth, workflow === null ? 0 : 1);
  return workflow as Workflow;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function createWorkflow(auth: Authorization, input: unknown): Promise<Workflow> {
  await requireWorkflowPermission(auth, 'workflows.create');
  const data: CreateWorkflowInput = parseRequest(CreateWorkflowSchema, input);
  let id: string;
  try {
    id = await withAuthorizedDb(auth.ctx, async (tx) => {
      const res = await tx.execute<{ id: string }>(sql`
        insert into public.workflows (
          org_id, name, description, trigger, conditions, actions, created_by
        )
        values (
          ${auth.ctx.orgId}::uuid,
          ${data.name},
          ${data.description ?? null},
          ${JSON.stringify(data.trigger)}::jsonb,
          ${JSON.stringify(data.conditions)}::jsonb,
          ${JSON.stringify(data.actions)}::jsonb,
          ${auth.ctx.personId}::uuid
        )
        returning id
      `);
      const row = res.rows[0];
      if (!row) throw new Error('Workflow creation failed.');
      return row.id;
    });
  } catch (error) {
    invalidWorkflowConflict(error);
  }
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'workflow.created',
      entityType: 'workflow',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { name: data.name, triggerType: data.trigger.type },
    },
    auth.meta,
  );
  return getWorkflow(auth, id);
}

/**
 * Edits a workflow definition and bumps version. Any non-deleted workflow is
 * editable, including ACTIVE ones (their in-flight runs keep the old version —
 * executions record workflow_version at claim time). Trigger/type changes on an
 * ACTIVE workflow re-validate the whole merged config through the create
 * schema, so the definition can never be saved in a state that could not have
 * been created.
 */
export async function updateWorkflow(
  auth: Authorization,
  id: string,
  input: unknown,
): Promise<Workflow> {
  await requireWorkflowPermission(auth, 'workflows.edit');
  const data = parseRequest(UpdateWorkflowSchema, input);
  const existing = await getWorkflow(auth, id);

  // P2-12: archived workflows are immutable through the edit API (the UI
  // hides the edit button; the API enforces it too).
  if (existing.status === 'ARCHIVED') {
    throw new Error('INVALID_REQUEST: archived workflows cannot be edited');
  }

  // Merge: explicit keys win, absent keys keep the stored config. undefined
  // values are dropped so an explicit null (e.g. clearing description) is
  // honored rather than silently replaced by the old value.
  const overrides = Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
  const merged: CreateWorkflowInput = parseRequest(CreateWorkflowSchema, {
    name: existing.name,
    description: existing.description,
    trigger: existing.trigger,
    conditions: existing.conditions,
    actions: existing.actions,
    ...overrides,
  });

  // P1-3: an ACTIVE workflow can never sit on a deferred (Phase 6+) trigger
  // type — the edit path re-validates the merged trigger, not just the
  // activation path.
  if (
    existing.status === 'ACTIVE' &&
    !(IMPLEMENTED_TRIGGER_TYPES as readonly string[]).includes(merged.trigger.type)
  ) {
    throw new Error('INVALID_REQUEST: trigger type not yet supported for ACTIVE workflows');
  }

  try {
    const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
      const res = await tx.execute(sql`
        update public.workflows w
        set name = ${merged.name},
            description = ${merged.description ?? null},
            trigger = ${JSON.stringify(merged.trigger)}::jsonb,
            conditions = ${JSON.stringify(merged.conditions)}::jsonb,
            actions = ${JSON.stringify(merged.actions)}::jsonb,
            version = w.version + 1,
            updated_by = ${auth.ctx.personId}::uuid
        where w.id = ${id}::uuid
          and ${WORKFLOW_WHERE(auth)}
        returning w.id
      `);
      return res.rowCount ?? 0;
    });
    await assertTargetAffected(auth, affected);
  } catch (error) {
    invalidWorkflowConflict(error);
  }

  await writeAuditEntry(
    auth.ctx,
    {
      action: 'workflow.updated',
      entityType: 'workflow',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { version: existing.version + 1, previousStatus: existing.status },
    },
    auth.meta,
  );
  return getWorkflow(auth, id);
}

/**
 * Soft delete only: a no-op UPDATE runs as app_user under the table's real
 * UPDATE policy (taking a row lock), then the SECURITY DEFINER
 * crm_soft_delete('workflow', …) sets deleted_at — the same two-step as
 * src/lib/work/tasks.ts deleteTask (the 0044 migration extends the allowlist
 * with 'workflow' → public.workflows).
 */
export async function deleteWorkflow(auth: Authorization, id: string): Promise<void> {
  await requireWorkflowPermission(auth, 'workflows.delete');
  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    const probe = await tx.execute<{ id: string }>(sql`
      update public.workflows w
      set updated_at = updated_at
      where w.id = ${id}::uuid
        and ${WORKFLOW_WHERE(auth)}
      returning w.id
    `);
    const rowId = probe.rows[0]?.id;
    if (rowId) {
      await tx.execute(sql`select public.crm_soft_delete('workflow', ${rowId}::uuid)`);
    }
    return probe.rowCount ?? 0;
  });
  await assertTargetAffected(auth, affected);
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'workflow.deleted',
      entityType: 'workflow',
      entityId: id,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      metadata: {},
    },
    auth.meta,
  );
}

// ── Status transitions ────────────────────────────────────────────────────────

async function setWorkflowStatus(
  auth: Authorization,
  id: string,
  toStatus: 'ACTIVE' | 'PAUSED',
  auditAction: 'workflow.activated' | 'workflow.paused',
): Promise<Workflow> {
  const current = await getWorkflow(auth, id);
  const affected = await withAuthorizedDb(auth.ctx, async (tx) => {
    // P2-4: the from-status predicate makes the transition atomic — a
    // concurrent archive between the getWorkflow check above and this write
    // can no longer produce an illegal ARCHIVED → ACTIVE transition.
    const res = await tx.execute(sql`
      update public.workflows w
      set status = ${toStatus},
          updated_by = ${auth.ctx.personId}::uuid
      where w.id = ${id}::uuid
        and ${WORKFLOW_WHERE(auth)}
        and w.status = ${current.status}
      returning w.id
    `);
    return res.rowCount ?? 0;
  });
  await assertTargetAffected(auth, affected);
  await writeAuditEntry(
    auth.ctx,
    {
      action: auditAction,
      entityType: 'workflow',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { fromStatus: current.status, toStatus },
    },
    auth.meta,
  );
  return getWorkflow(auth, id);
}

export async function activateWorkflow(auth: Authorization, id: string): Promise<Workflow> {
  await requireWorkflowPermission(auth, 'workflows.activate');
  const workflow = await getWorkflow(auth, id);
  if (workflow.status !== 'DRAFT' && workflow.status !== 'PAUSED') {
    throw new Error(
      `INVALID_REQUEST: only DRAFT or PAUSED workflows can be activated (current status: ${workflow.status})`,
    );
  }
  if (!(IMPLEMENTED_TRIGGER_TYPES as readonly string[]).includes(workflow.trigger.type)) {
    throw new Error('INVALID_REQUEST: trigger type not yet supported');
  }
  return setWorkflowStatus(auth, id, 'ACTIVE', 'workflow.activated');
}

export async function pauseWorkflow(auth: Authorization, id: string): Promise<Workflow> {
  await requireWorkflowPermission(auth, 'workflows.activate');
  const workflow = await getWorkflow(auth, id);
  if (workflow.status !== 'ACTIVE') {
    throw new Error(
      `INVALID_REQUEST: only ACTIVE workflows can be paused (current status: ${workflow.status})`,
    );
  }
  return setWorkflowStatus(auth, id, 'PAUSED', 'workflow.paused');
}

// ── Manual execution ──────────────────────────────────────────────────────────

export async function executeWorkflow(
  auth: Authorization,
  id: string,
  input: unknown,
): Promise<ExecuteWorkflowResult> {
  const body = parseRequest(ExecuteWorkflowBodySchema, input ?? {});
  const { executionId } = await executeWorkflowManual(auth, id, body.input);
  await writeAuditEntry(
    auth.ctx,
    {
      action: 'workflow.executed',
      entityType: 'workflow',
      entityId: id,
      result: 'SUCCESS',
      severity: 'LOW',
      metadata: { executionId },
    },
    auth.meta,
  );
  // The engine runs the full pipeline inline (awaited), so the row is already in
  // its terminal status by the time it returns.
  const status = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<{ status: string }>(sql`
      select e.status
      from public.workflow_executions e
      where e.id = ${executionId}::uuid
        and e.org_id = ${auth.ctx.orgId}::uuid
    `);
    return res.rows[0]?.status ?? 'UNKNOWN';
  });
  return { executionId, status };
}

// ── Execution history ─────────────────────────────────────────────────────────

export async function listExecutions(
  auth: Authorization,
  workflowId: string,
  input: unknown,
): Promise<ExecutionPage> {
  // Conceals an invisible/missing/foreign workflow as NOT_FOUND, same as get.
  await getWorkflow(auth, workflowId);
  const query = parseRequest(ListExecutionsQuerySchema, input ?? {});
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const [rows, counts] = await Promise.all([
      tx.execute<WorkflowExecution>(sql`
        select ${EXECUTION_COLUMNS}
        from public.workflow_executions e
        where e.workflow_id = ${workflowId}::uuid
          and e.org_id = ${auth.ctx.orgId}::uuid
        order by e.started_at desc, e.id desc
        limit ${query.limit} offset ${query.offset}
      `),
      tx.execute<{ total: number }>(sql`
        select count(*)::int as total
        from public.workflow_executions e
        where e.workflow_id = ${workflowId}::uuid
          and e.org_id = ${auth.ctx.orgId}::uuid
      `),
    ]);
    return {
      rows: rows.rows,
      total: counts.rows[0]?.total ?? 0,
      limit: query.limit,
      offset: query.offset,
    };
  });
}

/**
 * One execution with its steps in step_index order. Visibility is probed
 * through RLS (the SELECT policies on executions/steps require
 * workflows.view in the caller's org); a missing or foreign execution is
 * NOT_FOUND via assertTargetAffected — never distinguished.
 */
export async function getExecution(
  auth: Authorization,
  executionId: string,
): Promise<WorkflowExecutionDetail> {
  const execution = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<WorkflowExecution>(sql`
      select ${EXECUTION_COLUMNS}
      from public.workflow_executions e
      where e.id = ${executionId}::uuid
        and e.org_id = ${auth.ctx.orgId}::uuid
    `);
    return res.rows[0] ?? null;
  });
  await assertTargetAffected(auth, execution ? 1 : 0);
  const steps = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<WorkflowExecutionStep>(sql`
      select ${STEP_COLUMNS}
      from public.workflow_execution_steps s
      where s.execution_id = ${executionId}::uuid
        and s.org_id = ${auth.ctx.orgId}::uuid
      order by s.step_index asc
    `),
  );
  return { ...(execution as WorkflowExecution), steps: steps.rows };
}
