/**
 * Phase 5 Workflow Engine — Action Engine (A7, Wave 2)
 *
 * [AGENT]            A7 Action Engine
 * [CONTEXT]          The 6 Phase-5 action executors + the action registry.
 * [DECISION]         Executors call the EXISTING domain services with the
 *                    trigger actor's own Authorization (D2): createTask /
 *                    createProject / updateDeal / updateTask / assignTask /
 *                    linkProjectToDeal. No service is bypassed, none is
 *                    reimplemented. A workflow can never do what its trigger
 *                    actor cannot do.
 * [CONTRACT]         executeAction(auth, event, action: ActionConfig,
 *                    context: TemplateContext) => Promise<ActionResult> (§12).
 * [DEPENDENCIES]     A2 schema.ts (ActionConfig, per-action param schemas,
 *                    IMPLEMENTED/DEFERRED_ACTION_TYPES — imported, not
 *                    redefined); A4 events.ts (WorkflowEvent).
 * [FILE OWNERSHIP]   OWN src/lib/workflows/actions.ts. MUST NOT touch services.
 * [RISKS]            (a) Service-signature drift is the main risk — the audit's
 *                    assumed shapes were re-verified against the tree before
 *                    coding; deviations are documented below.
 *                    (b) Templates in params resolve against a fixed context;
 *                    unresolvable references are hard failures (INVALID_REQUEST).
 *
 * ── SERVICE-SIGNATURE DEVIATIONS (verified 2026-10-04 vs audit §12) ──────────
 *
 * 1. updateDeal(auth, dealId, input) CANNOT set the deal owner. Its input
 *    schema (src/lib/crm/schema.ts UpdateDealSchema = CreateDealSchema.partial()
 *    + currency + stage) has no ownerPersonId field, and no other exported deal
 *    service mutates owner_person_id (it is set at create time). The audit's
 *    §12 update_deal param contract lists ownerPersonId?, which the engine
 *    therefore CANNOT honor via the existing services. Adaptation: an
 *    update_deal carrying ownerPersonId fails the step with INVALID_REQUEST
 *    ("deal owner cannot be changed via 'update_deal' in Phase 5") instead of
 *    silently dropping the field. Only { probability, expectedCloseDate } are
 *    forwarded to updateDeal.
 *
 * 2. createProject(auth, input) input schema is strict { name, description }
 *    (src/lib/work/schema.ts) — it does NOT accept dealId. The audit's §12
 *    create_project param contract lists dealId?: '{{event.entityId}}', which
 *    must mean "link the new project to that deal". Adaptation: the executor
 *    creates the project with { name, description } and, when dealId is present,
 *    chains linkProjectToDeal(auth, projectId, { dealId }) so the param is
 *    honored rather than dropped. Both calls run under the actor's auth.
 *
 * Verified as matching the audit: assignTask(auth, id, personId: string | null)
 * (src/lib/work/tasks.ts:494 — used directly, no updateTask fallback needed);
 * linkProjectToDeal(auth, projectId, input: unknown) with { dealId } input
 * (src/lib/work/projects.ts:430); createTask/updateTask/updateDeal all take
 * (auth, id?, input: unknown) and re-validate input themselves.
 *
 * ── TEMPLATE SUBSTITUTION (§12) ──────────────────────────────────────────────
 *
 * Params may contain `{{path}}` references resolved against the fixed context
 * { event, deal, task, project } (snapshots built by the engine from the
 * trigger event and the source records). Substitution is string-path lookup
 * only — no expressions, no eval, no Function. A full-string template
 * ("{{event.entityId}}") substitutes the raw value (type preserved); a
 * template embedded in a larger string interpolates primitives only. An
 * unresolvable reference throws Error('INVALID_REQUEST: unresolvable template
 * reference {{path}}') → the engine records a FAILED step. Path segments are
 * own-property lookups only: `__proto__` / `constructor` / `prototype` are
 * rejected, so template resolution can never reach Object.prototype.
 */
import { z } from 'zod';
import type { Authorization } from '../authz/require-permission';
import { AuthorizationError } from '../authz/errors';
import { assignTask, createTask, updateTask } from '../work/tasks';
import { createProject, linkProjectToDeal } from '../work/projects';
import { updateDeal } from '../crm/deals';
import { enqueueJob } from '../jobs/queue';
import { NOTIFICATION_EVENT_TYPES } from '../notifications/types';
import {
  AssignTaskParamsSchema,
  CreateProjectParamsSchema,
  CreateTaskParamsSchema,
  IMPLEMENTED_ACTION_TYPES,
  LinkDealProjectParamsSchema,
  UpdateDealParamsSchema,
  UpdateTaskParamsSchema,
  type ActionConfig,
  type AssignTaskParams,
  type CreateProjectParams,
  type CreateTaskParams,
  type DeferredActionType,
  type ImplementedActionType,
  type LinkDealProjectParams,
  type UpdateDealParams,
  type UpdateTaskParams,
  templateOr,
} from './schema';
import type { WorkflowEvent } from './events';

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * The deferred action types carried by the Phase-5 registry: exactly the
 * §12 four. (Nit-3: 'scheduled' used to leak into the action-type union via
 * DEFERRED_ACTION_TYPES — it is a trigger type and no longer does.)
 *
 * Phase 8 (Workstream C): send_notification and send_email are IMPLEMENTED
 * (see the executors below) and no longer deferred — only webhook and
 * run_ai_action remain registry-documented stubs.
 */
export const REGISTRY_DEFERRED_ACTION_TYPES = [
  'webhook',
  'run_ai_action',
] as const satisfies readonly DeferredActionType[];
export type RegistryDeferredActionType = (typeof REGISTRY_DEFERRED_ACTION_TYPES)[number];

/**
 * Phase 8 (Workstream C) implemented send_notification and send_email at
 * runtime; Workstream F then enabled them at save time in schema.ts's
 * ActionConfigSchema (they remain outside schema.ts's IMPLEMENTED_ACTION_TYPES
 * for UI-label compatibility). Builder-UI enablement is the remaining
 * follow-up.
 */
export const NEWLY_IMPLEMENTED_ACTION_TYPES = ['send_notification', 'send_email'] as const;
export type NewlyImplementedActionType = (typeof NEWLY_IMPLEMENTED_ACTION_TYPES)[number];

/** The action types the registry documents: 6 Phase-5 + 2 Phase-8 implemented + 2 deferred. */
export type RegistryActionType =
  ImplementedActionType | NewlyImplementedActionType | RegistryDeferredActionType;

/** Compile-time pin: every deferred action type is documented in the registry. */
type _MissingRegistryEntry = Exclude<DeferredActionType, RegistryDeferredActionType>;
const _registryCoversDeferred: _MissingRegistryEntry = null as never;
void _registryCoversDeferred;

export interface ActionRegistryEntry {
  readonly implemented: boolean;
  readonly description: string;
}

export const ACTION_REGISTRY: Record<RegistryActionType, ActionRegistryEntry> = {
  create_task: {
    implemented: true,
    description: 'Create a work task (title, project, description, priority, assignee, due date).',
  },
  create_project: {
    implemented: true,
    description:
      'Create a work project (name, description); optionally links it to a CRM deal via dealId.',
  },
  update_deal: {
    implemented: true,
    description:
      'Update deal probability and/or expected close date. Stage changes are not allowed here.',
  },
  update_task: {
    implemented: true,
    description: 'Update task status, priority, and/or due date.',
  },
  assign_task: {
    implemented: true,
    description: 'Assign a task to a person in the organization.',
  },
  link_deal_project: {
    implemented: true,
    description: 'Link an existing project to a CRM deal (one live project per deal).',
  },
  send_notification: {
    implemented: true,
    description:
      'Phase 8: enqueue an in-app notification job (recipientPersonId, title, body; ' +
      'optional eventType/entityType/entityId/link). Runs under the trigger actor\u2019s ' +
      'authority — the actor needs jobs.create.',
  },
  send_email: {
    implemented: true,
    description:
      'Phase 8: enqueue an outbound email job (to, subject, body, optional bodyHtml). ' +
      'Runs under the trigger actor\u2019s authority — the actor needs jobs.create. ' +
      'Delivery requires a wired email provider; otherwise the job dead-letters.',
  },
  webhook: {
    implemented: false,
    description:
      'Phase 6+: outbound HTTP webhook. Registry contract only — not implemented in Phase 5.',
  },
  run_ai_action: {
    implemented: false,
    description:
      'Phase 6+: AI-powered action. Registry contract only — not implemented in Phase 5.',
  },
};

// ── Phase 8: send_notification / send_email param contracts ───────────────────
// Defined here (before PARAM_SCHEMAS in the Execution section below).
// The executors live with the other executors further down.
export const SendNotificationParamsSchema = z.strictObject({
  recipientPersonId: templateOr(z.string().uuid()),
  title: z.string().trim().min(1, 'title is required').max(200),
  body: z.string().trim().min(1, 'body is required').max(2000),
  /** Defaults to SYSTEM_ALERT: workflow-authored content has no domain type of its own. */
  eventType: z.enum(NOTIFICATION_EVENT_TYPES).optional(),
  entityType: z.string().trim().min(1).max(128).optional(),
  entityId: z.string().trim().min(1).max(256).optional(),
  link: z.string().trim().min(1).max(2048).optional(),
});
export type SendNotificationParams = z.infer<typeof SendNotificationParamsSchema>;

export const SendEmailParamsSchema = z.strictObject({
  to: z.union([
    templateOr(z.string().email()),
    z.array(templateOr(z.string().email())).min(1).max(50),
  ]),
  subject: z.string().trim().min(1, 'subject is required').max(300),
  body: z.string().trim().min(1, 'body is required').max(200_000),
  bodyHtml: z.string().trim().min(1).max(500_000).optional(),
});
export type SendEmailParams = z.infer<typeof SendEmailParamsSchema>;

// ── Template resolution ───────────────────────────────────────────────────────

export interface TemplateContext {
  readonly event: WorkflowEvent;
  readonly deal?: Record<string, unknown>;
  readonly task?: Record<string, unknown>;
  readonly project?: Record<string, unknown>;
}

export interface ActionResult {
  readonly ok: boolean;
  readonly output?: Readonly<Record<string, unknown>>;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

const FULL_TEMPLATE_PATTERN = /^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/;
const EMBEDDED_TEMPLATE_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/**
 * Safe dotted lookup against the template context. Own-properties only;
 * `__proto__` / `constructor` / `prototype` segments are rejected; anything
 * unresolvable (missing key, wrong type, undefined leaf) throws
 * Error('INVALID_REQUEST: unresolvable template reference {{path}}').
 */
function lookupTemplatePath(context: TemplateContext, path: string): unknown {
  const segments = path.split('.');
  for (const segment of segments) {
    if (segment === '' || FORBIDDEN_PATH_SEGMENTS.has(segment)) {
      throw new Error(`INVALID_REQUEST: unsafe template reference {{${path}}}`);
    }
  }
  let current: unknown = context;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) {
      throw new Error(`INVALID_REQUEST: unresolvable template reference {{${path}}}`);
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      throw new Error(`INVALID_REQUEST: unresolvable template reference {{${path}}}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) {
    throw new Error(`INVALID_REQUEST: unresolvable template reference {{${path}}}`);
  }
  return current;
}

function isInterpolatable(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    value === null
  );
}

function resolveTemplateValue(value: unknown, context: TemplateContext): unknown {
  if (typeof value === 'string') {
    const full = FULL_TEMPLATE_PATTERN.exec(value);
    if (full) {
      // Whole-string template: substitute the raw value (type preserved).
      const path = full[1];
      if (path === undefined) throw new Error('INVALID_REQUEST: malformed template reference');
      return lookupTemplatePath(context, path);
    }
    if (value.includes('{{')) {
      // Template embedded in a larger string: interpolate primitives only.
      EMBEDDED_TEMPLATE_PATTERN.lastIndex = 0;
      return value.replace(EMBEDDED_TEMPLATE_PATTERN, (_match, path: string) => {
        const resolved = lookupTemplatePath(context, path);
        if (!isInterpolatable(resolved)) {
          throw new Error(`INVALID_REQUEST: unresolvable template reference {{${path}}}`);
        }
        return String(resolved);
      });
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateValue(item, context));
  }
  if (typeof value === 'object' && value !== null) {
    const resolved: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      resolved[key] = resolveTemplateValue(entry, context);
    }
    return resolved;
  }
  return value;
}

/**
 * Replaces `{{path}}` strings in action params via safe dotted lookup against
 * the template context (§12). Throws
 * Error('INVALID_REQUEST: unresolvable template reference {{path}}') on the
 * first unresolvable reference — the engine records this as a FAILED step.
 */
export function resolveTemplates(
  params: Record<string, unknown>,
  context: TemplateContext,
): Record<string, unknown> {
  const resolved = resolveTemplateValue(params, context);
  if (typeof resolved !== 'object' || resolved === null || Array.isArray(resolved)) {
    throw new Error('INVALID_REQUEST: action params must be an object');
  }
  return resolved as Record<string, unknown>;
}

// ── Execution ─────────────────────────────────────────────────────────────────

const IMPLEMENTED_TYPE_SET = new Set<string>(IMPLEMENTED_ACTION_TYPES);
const REGISTRY_DEFERRED_TYPE_SET = new Set<string>(REGISTRY_DEFERRED_ACTION_TYPES);

const PARAM_SCHEMAS: Record<string, z.ZodTypeAny> = {
  create_task: CreateTaskParamsSchema,
  create_project: CreateProjectParamsSchema,
  update_deal: UpdateDealParamsSchema,
  update_task: UpdateTaskParamsSchema,
  assign_task: AssignTaskParamsSchema,
  link_deal_project: LinkDealProjectParamsSchema,
  // Phase 8: executable at runtime (see NEWLY_IMPLEMENTED_ACTION_TYPES);
  // schema.ts's save-time contract is unchanged (owned elsewhere).
  send_notification: SendNotificationParamsSchema,
  send_email: SendEmailParamsSchema,
};

/**
 * Maps a thrown service error to a sanitized ActionResult. AuthorizationError
 * codes: NOT_FOUND → NOT_FOUND, FORBIDDEN → FORBIDDEN, everything else →
 * INTERNAL (its static messages are safe). Error('INVALID_REQUEST: …') →
 * INVALID_REQUEST with the (config-authored, safe) message. Anything else →
 * INTERNAL with a generic message — raw DB errors, stack traces, and SQL never
 * reach errorMessage.
 */
function toActionResult(error: unknown, actionType: string): ActionResult {
  if (error instanceof AuthorizationError) {
    if (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN') {
      return { ok: false, errorCode: error.code, errorMessage: error.message };
    }
    return {
      ok: false,
      errorCode: 'INTERNAL',
      errorMessage: `internal error while executing action '${actionType}'`,
    };
  }
  if (error instanceof Error && error.message.startsWith('INVALID_REQUEST:')) {
    return {
      ok: false,
      errorCode: 'INVALID_REQUEST',
      errorMessage: error.message.slice('INVALID_REQUEST:'.length).trim(),
    };
  }
  return {
    ok: false,
    errorCode: 'INTERNAL',
    errorMessage: `internal error while executing action '${actionType}'`,
  };
}

async function executeCreateTask(
  auth: Authorization,
  params: CreateTaskParams,
): Promise<ActionResult> {
  const task = await createTask(auth, {
    title: params.title,
    projectId: params.projectId,
    description: params.description ?? undefined,
    priority: params.priority,
    assigneePersonId: params.assigneePersonId ?? undefined,
    dueDate: params.dueDate,
  });
  return { ok: true, output: { taskId: task.id } };
}

async function executeCreateProject(
  auth: Authorization,
  params: CreateProjectParams,
): Promise<ActionResult> {
  // createProject's input schema is strict { name, description } — dealId is
  // linked in a follow-up service call, never dropped (see header note 2).
  const project = await createProject(auth, {
    name: params.name,
    description: params.description ?? undefined,
  });
  if (params.dealId !== undefined) {
    await linkProjectToDeal(auth, project.id, { dealId: params.dealId });
  }
  return { ok: true, output: { projectId: project.id } };
}

async function executeUpdateDeal(
  auth: Authorization,
  params: UpdateDealParams,
): Promise<ActionResult> {
  // No deal service mutates owner_person_id (set at create time); passing it
  // through would be a silent no-op. Fail loudly instead (see header note 1).
  if (params.ownerPersonId !== undefined) {
    return {
      ok: false,
      errorCode: 'INVALID_REQUEST',
      errorMessage: "deal owner cannot be changed via 'update_deal' in Phase 5",
    };
  }
  const deal = await updateDeal(auth, params.dealId, {
    ...(params.probability !== undefined ? { probability: params.probability } : {}),
    ...(params.expectedCloseDate !== undefined
      ? { expectedCloseDate: params.expectedCloseDate }
      : {}),
  });
  return { ok: true, output: { dealId: deal.id } };
}

async function executeUpdateTask(
  auth: Authorization,
  params: UpdateTaskParams,
): Promise<ActionResult> {
  const task = await updateTask(auth, params.taskId, {
    ...(params.status !== undefined ? { status: params.status } : {}),
    ...(params.priority !== undefined ? { priority: params.priority } : {}),
    ...(params.dueDate !== undefined ? { dueDate: params.dueDate } : {}),
  });
  return { ok: true, output: { taskId: task.id } };
}

async function executeAssignTask(
  auth: Authorization,
  params: AssignTaskParams,
): Promise<ActionResult> {
  const task = await assignTask(auth, params.taskId, params.assigneePersonId);
  return { ok: true, output: { taskId: task.id } };
}

async function executeLinkDealProject(
  auth: Authorization,
  params: LinkDealProjectParams,
): Promise<ActionResult> {
  await linkProjectToDeal(auth, params.projectId, { dealId: params.dealId });
  return { ok: true, output: { projectId: params.projectId, dealId: params.dealId } };
}

// ── Phase 8: send_notification / send_email executors ─────────────────────────

/**
 * Phase 8 (Workstream C) implements the two notification actions. Both
 * enqueue Phase 6 jobs under the TRIGGER ACTOR's authority (D2 — no
 * synthetic actor): enqueueJob requires `jobs.create`, so an actor without
 * it gets a FORBIDDEN step — consistent with "a workflow can never do what
 * its trigger actor cannot do".
 *
 * NOTE: these types are executable here but are NOT in schema.ts's
 * IMPLEMENTED_ACTION_TYPES — the save-time ActionConfigSchema still rejects
 * them in workflow definitions (schema.ts is owned outside this workstream).
 * Enabling them at save time + in the builder UI is follow-up work.
 *
 * NOTE (V1, intentional — see types.ts INTENTIONAL V1 BEHAVIOR): WORKFLOW_FAILED
 * and the other workflow/automation event types are NOT auto-emitted by the
 * engine. They are delivered only via an explicit send_notification action.
 */

/** The still-deferred registry entries plus the Phase-8 runtime set, for the guard. */
const NEWLY_IMPLEMENTED_TYPE_SET = new Set<string>(NEWLY_IMPLEMENTED_ACTION_TYPES);

/**
 * Stable, content-addressed dedup key for workflow-emitted jobs: the same
 * workflow event re-executing the same action with the same content maps to
 * the same key, so step retries don't double-send (the queue's dedup
 * returns the existing job).
 */
function workflowJobDedupKey(
  event: WorkflowEvent,
  actionType: string,
  fingerprint: string,
): string {
  return `wf:${event.id}:${actionType}:${fingerprint}`;
}

/** FNV-1a hex fingerprint over a canonical JSON encoding. */
function fingerprintParams(value: Record<string, unknown>): string {
  const json = JSON.stringify(value, Object.keys(value).sort());
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function executeSendNotification(
  auth: Authorization,
  event: WorkflowEvent,
  params: SendNotificationParams,
): Promise<ActionResult> {
  const eventType = params.eventType ?? 'SYSTEM_ALERT';
  const dedupKey = workflowJobDedupKey(
    event,
    'send_notification',
    fingerprintParams({
      to: params.recipientPersonId,
      title: params.title,
      body: params.body,
    }),
  );
  const data: Record<string, unknown> = {
    type: eventType,
    eventId: dedupKey,
    source: 'workflow',
    workflowEventId: event.id,
  };
  if (params.entityType !== undefined) data['entityType'] = params.entityType;
  if (params.entityId !== undefined) data['entityId'] = params.entityId;
  if (params.link !== undefined) data['link'] = params.link;
  const job = await enqueueJob(auth, {
    type: 'notification',
    payload: {
      personId: params.recipientPersonId,
      title: params.title,
      message: params.body,
      data,
    },
    dedupKey,
  });
  return { ok: true, output: { jobId: job.id, eventId: dedupKey } };
}

async function executeSendEmail(
  auth: Authorization,
  event: WorkflowEvent,
  params: SendEmailParams,
): Promise<ActionResult> {
  const to = Array.isArray(params.to) ? params.to : [params.to];
  const dedupKey = workflowJobDedupKey(
    event,
    'send_email',
    fingerprintParams({ to, subject: params.subject, body: params.body }),
  );
  const job = await enqueueJob(auth, {
    type: 'email',
    payload: {
      to,
      subject: params.subject,
      text: params.body,
      ...(params.bodyHtml !== undefined ? { html: params.bodyHtml } : {}),
    },
    dedupKey,
  });
  // NOTE: delivery itself needs a wired email provider (EMAIL_PROVIDER /
  // EMAIL_PROVIDER_API_KEY); until then the job dead-letters loudly with
  // EMAIL_PROVIDER_UNCONFIGURED (Phase 6 fail-closed) instead of silently
  // dropping. The enqueue — this step — still succeeds.
  return { ok: true, output: { jobId: job.id } };
}

/**
 * Executes one workflow action under the trigger actor's Authorization (D2).
 * Never throws: every failure mode returns an ActionResult the engine records
 * on the step (FAILED → execution FAILED, remaining actions stopped).
 */
export async function executeAction(
  auth: Authorization,
  event: WorkflowEvent,
  action: ActionConfig,
  context: TemplateContext,
): Promise<ActionResult> {
  const guard = guardActionType(action.type, action.params);
  if (guard) return guard;

  let resolved: Record<string, unknown>;
  try {
    resolved = resolveTemplates(action.params as Record<string, unknown>, context);
  } catch (error) {
    return toActionResult(error, action.type);
  }
  return runResolvedAction(auth, event, action.type, resolved);
}

/**
 * Executes one action whose params were ALREADY template-resolved by the
 * caller (P2-2). The engine resolves once for step recording and calls this —
 * resolving a second time here would fail on literal `{{…}}` sequences inside
 * user data (e.g. a task titled "Fix {{bug}} template" resolved from
 * `{{deal.title}}`). The type guards still run (defense in depth); template
 * resolution does not.
 */
export async function executeActionResolved(
  auth: Authorization,
  event: WorkflowEvent,
  action: ActionConfig,
  resolvedParams: Record<string, unknown>,
): Promise<ActionResult> {
  const guard = guardActionType(action.type, action.params);
  if (guard) return guard;
  return runResolvedAction(auth, event, action.type, resolvedParams);
}

/** Registry + stage guards shared by executeAction/executeActionResolved. */
function guardActionType(type: string, rawParams: unknown): ActionResult | null {
  // Deferred registry entries (Phase 6+) are rejected, never executed.
  // (Phase 8: send_notification/send_email left this set — they execute now.)
  if (REGISTRY_DEFERRED_TYPE_SET.has(type)) {
    return {
      ok: false,
      errorCode: 'INVALID_REQUEST',
      errorMessage: `action '${type}' is not implemented in Phase 5`,
    };
  }
  if (!IMPLEMENTED_TYPE_SET.has(type) && !NEWLY_IMPLEMENTED_TYPE_SET.has(type)) {
    return {
      ok: false,
      errorCode: 'INTERNAL',
      errorMessage: `internal error while executing action '${type}'`,
    };
  }

  // Stage changes are never allowed through update_deal — they go through the
  // explicit stage-change path, never a generic field update (§12).
  // Template keys are never substituted (only values), so checking the raw
  // params' keys here is equivalent to checking the resolved keys.
  const raw = rawParams as Record<string, unknown> | null | undefined;
  if (
    type === 'update_deal' &&
    raw !== null &&
    typeof raw === 'object' &&
    ('stage' in raw || 'stageId' in raw)
  ) {
    return {
      ok: false,
      errorCode: 'INVALID_REQUEST',
      errorMessage: "stage changes are not allowed via 'update_deal'",
    };
  }
  return null;
}

async function runResolvedAction(
  auth: Authorization,
  event: WorkflowEvent,
  type: string,
  resolved: Record<string, unknown>,
): Promise<ActionResult> {
  const schema = PARAM_SCHEMAS[type];
  if (schema === undefined) {
    // Unreachable: guardActionType pins `type` to a known schema above.
    return {
      ok: false,
      errorCode: 'INTERNAL',
      errorMessage: `internal error while executing action '${type}'`,
    };
  }
  const parsed = schema.safeParse(resolved);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      errorCode: 'INVALID_REQUEST',
      errorMessage: first
        ? `${first.path.join('.') || 'params'}: ${first.message}`
        : 'invalid action params',
    };
  }

  try {
    switch (type) {
      case 'create_task':
        return await executeCreateTask(auth, parsed.data as CreateTaskParams);
      case 'create_project':
        return await executeCreateProject(auth, parsed.data as CreateProjectParams);
      case 'update_deal':
        return await executeUpdateDeal(auth, parsed.data as UpdateDealParams);
      case 'update_task':
        return await executeUpdateTask(auth, parsed.data as UpdateTaskParams);
      case 'assign_task':
        return await executeAssignTask(auth, parsed.data as AssignTaskParams);
      case 'link_deal_project':
        return await executeLinkDealProject(auth, parsed.data as LinkDealProjectParams);
      case 'send_notification':
        return await executeSendNotification(auth, event, parsed.data as SendNotificationParams);
      case 'send_email':
        return await executeSendEmail(auth, event, parsed.data as SendEmailParams);
      default:
        // Unreachable: the implemented/deferred checks above pin `type`.
        return {
          ok: false,
          errorCode: 'INTERNAL',
          errorMessage: `internal error while executing action '${type}'`,
        };
    }
  } catch (error) {
    return toActionResult(error, type);
  }
}
