/**
 * Phase 5 Workflow Engine — Trigger Matcher (A5, Wave 2)
 *
 * Answers "which ACTIVE workflows in this org should fire for this event?"
 * per §10 (trigger contract) and §13 step 3 (execution contract) of the
 * architecture audit.
 *
 * Two stages:
 *   1. SQL narrowing — one indexed query over `workflows_match_idx`
 *      (org_id, status, trigger_type): exact `trigger_type` equality. The
 *      org comes from `auth.ctx.orgId` (the caller's Authorization) — never
 *      from the event (D2: execution authority = the trigger actor).
 *   2. In-memory narrowing — `doesTriggerMatch` (pure) applies the
 *      `entityType` narrowing and `filters` EQUALS checks against the event
 *      payload.
 *
 * Fail-closed throughout: a malformed workflow row is skipped with a Sentry
 * warning (it must never break the originating request); an unknown filter
 * key, a prototype-unsafe key, or any lookup failure means NO match, never a
 * throw.
 *
 * Types come from `./schema` (A2: TriggerConfig, ConditionNode, ActionConfig)
 * and `./events` (A4: WorkflowEvent) — never redefined here.
 */
import * as Sentry from '@sentry/nextjs';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { withAuthorizedDb } from '../db/authorized';
import type { Authorization } from '../authz/require-permission';
import { ActionConfigSchema, ConditionNodeSchema, TriggerConfigSchema } from './schema';
import type { ActionConfig, ConditionNode, TriggerConfig } from './schema';
import type { WorkflowEvent } from './events';

// ── Filter EQUALS semantics (Phase 5) ─────────────────────────────────────────

/** Numeric strings like "100" or "-3.5" — compared numerically, not lexically. */
const NUMERIC_STRING_PATTERN = /^-?\d+(\.\d+)?$/;

function isNumericLike(value: unknown): boolean {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && NUMERIC_STRING_PATTERN.test(value.trim()))
  );
}

/** Payload/filter keys that must never resolve through the prototype chain. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Own-property lookup against the event payload. Fail-closed on unsafe keys. */
function payloadLookup(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): { found: boolean; value?: unknown } {
  if (UNSAFE_KEYS.has(key)) return { found: false };
  if (Object.prototype.hasOwnProperty.call(payload, key)) {
    return { found: true, value: payload[key] };
  }
  return { found: false };
}

/**
 * EQUALS comparison for one trigger filter entry vs one payload value:
 *  - numbers vs numeric strings → compare numerically ("100" == 100)
 *  - booleans → strict (true !== "true")
 *  - strings → case-sensitive exact ("WON" !== "won")
 *  - everything else → strict identity (null === null; null !== undefined)
 * Never throws.
 */
function filtersEqual(filterValue: unknown, payloadValue: unknown): boolean {
  if (isNumericLike(filterValue) && isNumericLike(payloadValue)) {
    return Number(filterValue) === Number(payloadValue);
  }
  return filterValue === payloadValue;
}

/**
 * Pure: does this workflow's trigger config match this event?
 *
 *   1. `trigger.type === event.type` (exact — mirrors the generated-column
 *      query; the SQL already narrows on it, this re-checks defensively).
 *   2. If `trigger.entityType` is set → must equal `event.entityType`.
 *   3. If `trigger.filters` is set → EVERY entry must EQUALS-match against
 *      `event.payload`. An unknown filter key (absent from the payload),
 *      a prototype-unsafe key, or any mismatch → NO match. Never throws.
 */
export function doesTriggerMatch(trigger: TriggerConfig, event: WorkflowEvent): boolean {
  if (trigger.type !== event.type) return false;
  if (trigger.entityType !== undefined && trigger.entityType !== event.entityType) {
    return false;
  }
  const filters = trigger.filters;
  if (filters === undefined) return true;
  for (const [key, filterValue] of Object.entries(filters)) {
    const { found, value } = payloadLookup(event.payload, key);
    if (!found) return false; // unknown filter key → fail closed
    if (!filtersEqual(filterValue, value)) return false;
  }
  return true;
}

// ── Workflow matching (SQL narrowing + in-memory narrowing) ───────────────────

/**
 * One ACTIVE workflow that matched an event. `conditions` / `actions` are the
 * A2-typed JSONB columns from `public.workflows` (arrays per the audit §8.1
 * column contract: `conditions` → `ConditionNode[]`, `actions` →
 * `ActionConfig[]`).
 */
export interface MatchedWorkflow {
  readonly id: string;
  readonly version: number;
  readonly conditions: ConditionNode[];
  readonly actions: ActionConfig[];
}

/** Validates a raw `workflows` row: id/version shape plus the A2 JSONB
 *  schemas. A failed parse means the stored row is corrupt — the caller skips
 *  it (Sentry warning), never throws. */
const WorkflowMatchRowSchema = z.strictObject({
  id: z.string().uuid(),
  version: z.number().int(),
  trigger: TriggerConfigSchema,
  conditions: z.array(ConditionNodeSchema),
  actions: z.array(ActionConfigSchema),
});

interface MatchedRow {
  readonly id: string;
  readonly version: number;
  readonly trigger: TriggerConfig;
  readonly conditions: ConditionNode[];
  readonly actions: ActionConfig[];
}

function parseWorkflowRow(row: unknown, rowIndex: number): MatchedRow | null {
  const parsed = WorkflowMatchRowSchema.safeParse(row);
  if (parsed.success) return parsed.data;
  // Corrupt workflow must not break the request: skip with a Sentry warning.
  // Keep the report sanitized — no raw payloads, only the failure summary.
  const summary = parsed.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
  console.error('[workflows] skipping malformed workflow row in trigger matching', {
    rowIndex,
    issues: summary,
  });
  Sentry.captureMessage('workflow trigger matching skipped a malformed workflow row', {
    level: 'warning',
    tags: { source: 'workflow-trigger-match' },
    extra: { rowIndex, issueCount: summary.length },
  });
  return null;
}

/**
 * Finds the ACTIVE, non-deleted workflows in the caller's org whose trigger
 * type equals `event.type`, then narrows in memory with `doesTriggerMatch`
 * (entityType + filters).
 *
 * Called by A8's engine per §13 step 3. Runs inside `withAuthorizedDb`
 * (the only path to Postgres) via the SECURITY DEFINER
 * `workflow_find_matching()` (F10): matching intentionally bypasses the
 * workflows_select RLS policy's `workflows.view` requirement, so automations
 * fire on any trigger actor's actions — tenant scoping is enforced inside
 * the definer via the caller's org (asserted against auth.ctx.orgId), and
 * actions still execute under the actor's own Authorization (D2). The org
 * comes from `auth.ctx.orgId` — never from the event.
 *
 * Malformed rows are SKIPPED with a Sentry warning, never thrown.
 */
export async function findMatchingWorkflows(
  auth: Authorization,
  event: WorkflowEvent,
): Promise<MatchedWorkflow[]> {
  // `trigger_type` is the STORED generated column (trigger ->> 'type'); the
  // composite index workflows_match_idx covers (org_id, status, trigger_type).
  const result = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{
      id: string;
      version: number;
      trigger: unknown;
      conditions: unknown;
      actions: unknown;
    }>(sql`
      select id, version, trigger, conditions, actions
      from public.workflow_find_matching(${event.type}, ${auth.ctx.orgId}::uuid)
    `),
  );

  const matched: MatchedWorkflow[] = [];
  result.rows.forEach((row, index) => {
    const parsed = parseWorkflowRow(row, index);
    if (!parsed) return; // corrupt row: skipped, already reported
    if (doesTriggerMatch(parsed.trigger, event)) {
      matched.push({
        id: parsed.id,
        version: parsed.version,
        conditions: parsed.conditions,
        actions: parsed.actions,
      });
    }
  });
  return matched;
}
