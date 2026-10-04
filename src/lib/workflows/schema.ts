import { z } from 'zod';
import { TaskPrioritySchema, TaskStatusSchema } from '../work/schema';

/**
 * Workflow definition input validation (Phase 5). Every untrusted value — REST
 * bodies for workflow CRUD — is validated here, at the boundary, before a
 * service function touches the database. zod + inferred types only: no DB
 * access, no drizzle, no service calls.
 *
 * ── COLUMN CONTRACT WITH MIGRATION 0044 ─────────────────────────────────────────
 *
 * The services in this module address the tables with raw SQL, so a column-name
 * drift between this file and 0044 is a runtime error, not a type error. The
 * columns per table:
 *
 *   workflows:  id, org_id, name, description, status, trigger (jsonb),
 *               trigger_type (STORED generated column: trigger ->> 'type'),
 *               conditions (jsonb), actions (jsonb), version,
 *               created_by (nullable, NO FK — no synthetic actor),
 *               updated_by, created_at, updated_at, deleted_at
 *               (per the architecture audit §8.1; the 0044 migration owns the
 *               exact DDL — this module only validates the JSONB columns it
 *               fills: trigger → TriggerConfig, conditions → ConditionNode[],
 *               actions → ActionConfig[])
 *   workflow_executions / workflow_execution_steps: written ONLY via the
 *               SECURITY DEFINER functions workflow_record_execution() /
 *               workflow_record_step() (audit §8.3). This module does NOT
 *               address them — no input schema exists for them here.
 *
 * Wire contract: the API speaks camelCase; SQL aliases translate
 * (created_by AS "createdBy"). If 0044 names a column differently, update the
 * SQL in service.ts only — the schemas below are column-name agnostic.
 *
 * Permission keys (audit §16): workflows.view / create / edit / delete /
 * activate / run. requirePermission() fails closed on an unknown key.
 *
 * Trigger-type authority: the 11-type enum is canonical HERE
 * (src/lib/workflows/schema.ts — this module has no runtime imports from the
 * workflow engine graph, so it can never participate in an import cycle).
 * src/lib/workflows/events.ts re-exports it for compatibility. IMPLEMENTED_ /
 * DEFERRED_TRIGGER_TYPES below are schema-level groupings over that same
 * enum: the schema accepts all 11 (a deferred trigger can be saved as DRAFT);
 * blocking activation is API/engine logic per §10, NOT a schema rejection.
 */

// ── Shared primitives ─────────────────────────────────────────────────────────

const uuid = z.string().uuid();

/** `{{path.to.value}}` template reference, resolved at execution against the
 *  fixed context { event, deal, task, project } (§12). Substitution is
 *  string-path lookup only — no expressions. */
export const TEMPLATE_STRING_PATTERN = /^\{\{[a-zA-Z0-9_.]+\}\}$/;
export const TemplateStringSchema = z
  .string()
  .regex(TEMPLATE_STRING_PATTERN, 'must be a {{path}} template reference');

/**
 * Accepts either a concrete value matching `schema` or a `{{path}}` template
 * string resolved at execution time. Used for every id / entity-reference
 * field in action params (§12).
 */
export function templateOr<T extends z.ZodTypeAny>(schema: T) {
  return z.union([schema, TemplateStringSchema]);
}

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'must be a real calendar date');

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s.length === 0 ? null : s))
    .nullable()
    .optional();

// ── Trigger types (§9) ─────────────────────────────────────────────────────

/**
 * Phase-5 trigger types (plus Phase 6+ contracts with no runtime: `scheduled`,
 * `webhook`, `task.overdue` — a workflow using one can be saved as DRAFT but
 * can never be ACTIVATEd).
 *
 * Canonical home (cycle-free): defined here, re-exported by events.ts.
 * Previously this lived in events.ts, which created the
 * schema → events → engine → actions → schema import cycle (P0, 2026-10-04).
 */
export const WORKFLOW_TRIGGER_TYPES = [
  'deal.created',
  'deal.updated',
  'deal.stage_changed',
  'task.created',
  'task.status_changed',
  'task.assigned',
  'project.created',
  'manual',
  // Phase 6+ contracts (no runtime in Phase 5):
  'scheduled',
  'webhook',
  'task.overdue',
] as const;

export type WorkflowTriggerType = (typeof WORKFLOW_TRIGGER_TYPES)[number];

/** The 8 trigger types with Phase-5 runtime (the engine matches them). */
export const IMPLEMENTED_TRIGGER_TYPES = [
  'deal.created',
  'deal.updated',
  'deal.stage_changed',
  'task.created',
  'task.status_changed',
  'task.assigned',
  'project.created',
  'manual',
] as const;
export type ImplementedTriggerType = (typeof IMPLEMENTED_TRIGGER_TYPES)[number];

/** Phase 6+ contracts: schema-accepted, registry-documented, no Phase-5 runtime. */
export const DEFERRED_TRIGGER_TYPES = ['scheduled', 'webhook', 'task.overdue'] as const;
export type DeferredTriggerType = (typeof DEFERRED_TRIGGER_TYPES)[number];

/** All 9 trigger types. Accepts every type in the canonical enum (§10):
 *  activation blocking for deferred types is engine/API logic, not schema. */
export const TriggerTypeSchema = z.enum(WORKFLOW_TRIGGER_TYPES);

/** Stored in workflows.trigger (jsonb). trigger_type is a STORED generated
 *  column (trigger ->> 'type'), so `type` must always be present. */
export const TriggerConfigSchema = z.strictObject({
  type: TriggerTypeSchema,
  entityType: z.enum(['deal', 'task', 'project']).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
});
export type TriggerConfig = z.infer<typeof TriggerConfigSchema>;

// ── Conditions (§11) ───────────────────────────────────────────────────────────

export const CONDITION_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'greater_than',
  'greater_than_or_equal',
  'less_than',
  'less_than_or_equal',
  'exists',
  'not_exists',
  'in',
  'not_in',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];
export const ConditionOperatorSchema = z.enum(CONDITION_OPERATORS);

export type ConditionFieldKind = 'text' | 'numeric' | 'boolean' | 'uuid' | 'date' | 'enum';

/**
 * Closed field allowlist (§11.1). Anything else → save-time INVALID_REQUEST.
 * The engine resolves dotted paths against a sanitized snapshot with a safe
 * getter — `__proto__` / `constructor` / `prototype` segments can never appear
 * here, so the allowlist itself is the prototype-pollution guard.
 */
export const CONDITION_FIELD_TYPES: Record<string, ConditionFieldKind> = {
  'deal.value': 'numeric',
  'deal.stage': 'enum',
  'deal.is_won': 'boolean',
  'deal.is_lost': 'boolean',
  'deal.probability': 'numeric',
  'deal.owner_person_id': 'uuid',
  'deal.pipeline_id': 'uuid',
  'deal.title': 'text',
  'task.status': 'enum',
  'task.priority': 'enum',
  'task.assignee_person_id': 'uuid',
  'task.project_id': 'uuid',
  'task.due_date': 'date',
  'project.name': 'text',
  'project.is_archived': 'boolean',
  'event.actor_person_id': 'uuid',
  'event.type': 'text',
};

export interface ConditionLeaf {
  field: string;
  operator: ConditionOperator;
  value?: unknown;
}
export interface ConditionGroup {
  operator: 'AND' | 'OR';
  conditions: ConditionNode[];
}
export type ConditionNode = ConditionLeaf | ConditionGroup;

/** DoS bounds (§11.2). */
export const MAX_CONDITION_DEPTH = 5;
export const MAX_CONDITION_LEAVES = 50;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_STRING_PATTERN = /^-?\d+(\.\d+)?$/;
const DATE_STRING_PATTERN =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function scalarMatchesKind(value: unknown, kind: ConditionFieldKind): boolean {
  switch (kind) {
    case 'text':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'uuid':
      return typeof value === 'string' && UUID_PATTERN.test(value);
    case 'numeric':
      return (
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && NUMERIC_STRING_PATTERN.test(value))
      );
    case 'date':
      return (
        typeof value === 'string' &&
        DATE_STRING_PATTERN.test(value) &&
        !Number.isNaN(Date.parse(value))
      );
    case 'enum':
      return typeof value === 'string' && value.length > 0;
  }
}

export const ConditionLeafSchema: z.ZodType<ConditionLeaf> = z
  .strictObject({
    field: z.string(),
    operator: ConditionOperatorSchema,
    value: z.unknown().optional(),
  })
  .superRefine((leaf, ctx) => {
    const kind = CONDITION_FIELD_TYPES[leaf.field];
    if (kind === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `unknown condition field '${leaf.field}' — must be an allowlisted field (§11.1)`,
        path: ['field'],
      });
      return;
    }
    const isExistence = leaf.operator === 'exists' || leaf.operator === 'not_exists';
    if (isExistence) {
      if (leaf.value !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `'${leaf.operator}' must not carry a value`,
          path: ['value'],
        });
      }
      return;
    }
    if (leaf.value === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `operator '${leaf.operator}' requires a value`,
        path: ['value'],
      });
      return;
    }
    const isList = leaf.operator === 'in' || leaf.operator === 'not_in';
    if (isList && !Array.isArray(leaf.value)) {
      ctx.addIssue({
        code: 'custom',
        message: `'${leaf.operator}' requires an array value`,
        path: ['value'],
      });
      return;
    }
    const values = (isList ? leaf.value : [leaf.value]) as unknown[];
    if (isList && values.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: `'${leaf.operator}' requires a non-empty array`,
        path: ['value'],
      });
      return;
    }
    values.forEach((v, i) => {
      if (!scalarMatchesKind(v, kind)) {
        ctx.addIssue({
          code: 'custom',
          message: `value${isList ? ` [${i}]` : ''} does not match field type '${kind}' for '${leaf.field}'`,
          path: ['value'],
        });
      }
    });
  });

export const ConditionNodeSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([ConditionLeafSchema, ConditionGroupSchema]),
);

export const ConditionGroupSchema: z.ZodType<ConditionGroup> = z.strictObject({
  operator: z.enum(['AND', 'OR']),
  conditions: z.array(ConditionNodeSchema).min(1, 'condition group must not be empty'),
});

/** Total leaf count across a condition tree (DoS bound helper, §11.2). */
export function countConditionLeaves(nodes: readonly ConditionNode[]): number {
  let count = 0;
  const visit = (node: ConditionNode): void => {
    if ('conditions' in node) node.conditions.forEach(visit);
    else count += 1;
  };
  nodes.forEach(visit);
  return count;
}

/** Nesting depth of a condition tree: a lone leaf is depth 1, each wrapping
 *  group adds 1 (DoS bound helper, §11.2). */
export function maxConditionDepth(nodes: readonly ConditionNode[]): number {
  const depthOf = (node: ConditionNode): number =>
    'conditions' in node ? 1 + Math.max(0, ...node.conditions.map(depthOf)) : 1;
  return nodes.length === 0 ? 0 : Math.max(...nodes.map(depthOf));
}

/** The conditions array with the §11.2 tree bounds enforced via refinements. */
const conditionTreeSchema = () =>
  z
    .array(ConditionNodeSchema)
    .refine((nodes) => countConditionLeaves(nodes) <= MAX_CONDITION_LEAVES, {
      message: `conditions exceed the ${MAX_CONDITION_LEAVES}-leaf bound (§11.2)`,
    })
    .refine((nodes) => maxConditionDepth(nodes) <= MAX_CONDITION_DEPTH, {
      message: `conditions exceed max nesting depth of ${MAX_CONDITION_DEPTH} (§11.2)`,
    });

// ── Actions (§12) ─────────────────────────────────────────────────────────────

export const IMPLEMENTED_ACTION_TYPES = [
  'create_task',
  'create_project',
  'update_deal',
  'update_task',
  'assign_task',
  'link_deal_project',
] as const;
export type ImplementedActionType = (typeof IMPLEMENTED_ACTION_TYPES)[number];

/**
 * Phase 6+ action contracts (audit §12 registry). They exist as registry
 * entries with implemented:false — the engine rejects them with a clear
 * error if forced, and this schema rejects them at save time.
 *
 * Nit-3: 'scheduled' used to sit in this list, but it is a *trigger* type
 * (DEFERRED_TRIGGER_TYPES), not an action — it never belonged here and is
 * no longer smuggled into the action-type union.
 */
export const DEFERRED_ACTION_TYPES = [
  'send_notification',
  'send_email',
  'webhook',
  'run_ai_action',
] as const;
export type DeferredActionType = (typeof DEFERRED_ACTION_TYPES)[number];

export const WORKFLOW_ACTION_TYPES = [
  ...IMPLEMENTED_ACTION_TYPES,
  ...DEFERRED_ACTION_TYPES,
] as const;
export type WorkflowActionType = (typeof WORKFLOW_ACTION_TYPES)[number];
export const ActionTypeSchema = z.enum(WORKFLOW_ACTION_TYPES);

/**
 * P2-1, reserved: accepted on every action for forward compatibility, but NOT
 * consumed by the Phase-5 engine (no step-level idempotency is implemented)
 * and NOT exposed in the builder UI. Carried through unchanged.
 */
const actionKey = z.string().trim().min(1).max(128).optional();

export const CreateTaskParamsSchema = z.strictObject({
  title: z.string().trim().min(1, 'title is required').max(200),
  // P1-6: optional/nullable, matching the createTask service
  // (src/lib/work/schema.ts: projectId: uuid.nullable().optional()). A blank
  // builder field drops out of params; an explicit null (or a template
  // resolving to null) creates a project-less task.
  projectId: templateOr(uuid).nullable().optional(),
  description: optionalText(4000),
  priority: TaskPrioritySchema.optional(),
  assigneePersonId: templateOr(uuid).optional(),
  dueDate: dateString.optional(),
});
export type CreateTaskParams = z.infer<typeof CreateTaskParamsSchema>;

export const CreateProjectParamsSchema = z.strictObject({
  name: z.string().trim().min(1, 'name is required').max(200),
  description: optionalText(4000),
  dealId: templateOr(uuid).optional(),
});
export type CreateProjectParams = z.infer<typeof CreateProjectParamsSchema>;

export const UpdateDealParamsSchema = z.strictObject({
  dealId: templateOr(uuid),
  probability: z.number().int().min(0).max(100).optional(),
  expectedCloseDate: dateString.optional(),
  ownerPersonId: templateOr(uuid).optional(),
});
export type UpdateDealParams = z.infer<typeof UpdateDealParamsSchema>;

export const UpdateTaskParamsSchema = z.strictObject({
  taskId: templateOr(uuid),
  status: TaskStatusSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  dueDate: dateString.nullable().optional(),
});
export type UpdateTaskParams = z.infer<typeof UpdateTaskParamsSchema>;

export const AssignTaskParamsSchema = z.strictObject({
  taskId: templateOr(uuid),
  assigneePersonId: templateOr(uuid),
});
export type AssignTaskParams = z.infer<typeof AssignTaskParamsSchema>;

export const LinkDealProjectParamsSchema = z.strictObject({
  projectId: templateOr(uuid),
  dealId: templateOr(uuid),
});
export type LinkDealProjectParams = z.infer<typeof LinkDealProjectParamsSchema>;

const CreateTaskActionSchema = z.strictObject({
  type: z.literal('create_task'),
  params: CreateTaskParamsSchema,
  key: actionKey,
});
const CreateProjectActionSchema = z.strictObject({
  type: z.literal('create_project'),
  params: CreateProjectParamsSchema,
  key: actionKey,
});
const UpdateDealActionSchema = z.strictObject({
  type: z.literal('update_deal'),
  params: UpdateDealParamsSchema,
  key: actionKey,
});
const UpdateTaskActionSchema = z.strictObject({
  type: z.literal('update_task'),
  params: UpdateTaskParamsSchema,
  key: actionKey,
});
const AssignTaskActionSchema = z.strictObject({
  type: z.literal('assign_task'),
  params: AssignTaskParamsSchema,
  key: actionKey,
});
const LinkDealProjectActionSchema = z.strictObject({
  type: z.literal('link_deal_project'),
  params: LinkDealProjectParamsSchema,
  key: actionKey,
});

/** Deferred action types match their registry shape but are rejected with a
 *  clear message — they are contracts for Phase 6+, not validatable for
 *  Phase-5 execution (D6). */
const deferredActionSchemas = DEFERRED_ACTION_TYPES.map((deferredType) =>
  z
    .strictObject({
      type: z.literal(deferredType),
      params: z.record(z.string(), z.unknown()).optional(),
      key: actionKey,
    })
    .refine(() => false, {
      message: `action type '${deferredType}' is registry-documented only (deferred to Phase 6+); it cannot be used in a Phase 5 workflow`,
    }),
);

/**
 * Discriminated union on `type` → the correct per-action params schema.
 * Deferred types are rejected with a clear message; unknown types fail the
 * union. Note: template strings inside params are validated for syntax here;
 * resolvability against the execution context is an engine concern (§12) and
 * surfaces as a FAILED step with INVALID_REQUEST, not a save-time error.
 */
export const ActionConfigSchema = z.union([
  z.discriminatedUnion('type', [
    CreateTaskActionSchema,
    CreateProjectActionSchema,
    UpdateDealActionSchema,
    UpdateTaskActionSchema,
    AssignTaskActionSchema,
    LinkDealProjectActionSchema,
  ]),
  ...deferredActionSchemas,
]);
export type ActionConfig = z.infer<typeof ActionConfigSchema>;

// ── Workflow status ───────────────────────────────────────────────────────────

/** Mirrors the workflows.status CHECK in migration 0044. */
export const WORKFLOW_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export const WorkflowStatusSchema = z.enum(WORKFLOW_STATUSES);

// ── Workflow CRUD inputs ──────────────────────────────────────────────────────

export const CreateWorkflowSchema = z.strictObject({
  name: z.string().trim().min(1, 'name is required').max(200),
  description: optionalText(4000),
  trigger: TriggerConfigSchema,
  conditions: conditionTreeSchema().default([]),
  actions: z.array(ActionConfigSchema).min(1, 'at least one action is required').max(20),
});
export type CreateWorkflowInput = z.infer<typeof CreateWorkflowSchema>;

/** All optional. Status changes go through dedicated endpoints (not here),
 *  per the API contract (§14). */
export const UpdateWorkflowSchema = z.strictObject({
  name: z.string().trim().min(1, 'name is required').max(200).optional(),
  description: optionalText(4000),
  trigger: TriggerConfigSchema.optional(),
  conditions: conditionTreeSchema().optional(),
  actions: z.array(ActionConfigSchema).min(1, 'at least one action is required').max(20).optional(),
});
export type UpdateWorkflowInput = z.infer<typeof UpdateWorkflowSchema>;
