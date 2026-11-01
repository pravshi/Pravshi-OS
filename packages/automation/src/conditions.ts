/**
 * Phase 5 Workflow Engine — Condition Engine (A6, Wave 2)
 *
 * Evaluates structured JSON condition trees against a sanitized snapshot plus
 * the triggering event. Pure data walking: no `eval`, no `new Function`, no
 * dynamic code of any kind.
 *
 * ── CONTRACT WITH A8 (Execution Orchestrator) ─────────────────────────────
 *
 * `evaluateConditions(conditions, snapshot, event)` is called with:
 *   - `conditions`: the workflow's parsed `ConditionNode[]` (validated at save
 *     by the zod schema in `./schema`; this evaluator ALSO fails closed on
 *     anything it cannot evaluate, so it is safe to call with untrusted trees).
 *   - `snapshot`: built by A8 from the source record. Each present section
 *     MUST expose the exact keys named in `CONDITION_FIELD_TYPES` (`./schema`,
 *     audit §11.1) — e.g. `snapshot.deal.is_won`, `snapshot.task.due_date`.
 *     Sections irrelevant to the event may be omitted (absent section ⇒ all
 *     its fields resolve to `undefined`).
 *   - `event`: the `WorkflowEvent` (`./events`). `event.*` condition fields
 *     resolve against a fixed view: `event.actor_person_id` → the event's
 *     `actorPersonId`, `event.type` → the event's `type`.
 *
 * ── FAIL-CLOSED SEMANTICS ────────────────────────────────────────────────
 *
 * The evaluator NEVER throws and NEVER fires on uncertainty:
 *   - empty conditions array → `true` (no constraints);
 *   - unknown field (not in `CONDITION_FIELD_TYPES`) → leaf `false`;
 *   - `__proto__` / `constructor` / `prototype` path segments → leaf `false`;
 *   - any operator type mismatch → `false` for the positive operator;
 *   - `not_*` operators are strict negations of their positive counterpart,
 *     except `in`/`not_in` whose list is corrupt (not a non-empty array):
 *     both fail closed to `false`.
 *
 * ── OPERATOR SEMANTICS ───────────────────────────────────────────────────
 *
 *   equals / not_equals        numeric-aware: numeric strings compare as
 *                              numbers when BOTH sides are numeric-like;
 *                              otherwise strict `===`. `null`/`undefined`
 *                              equal only each other.
 *   contains / not_contains    text only, case-insensitive substring;
 *                              non-text on either side → `false`.
 *   greater_than / greater_than_or_equal / less_than / less_than_or_equal
 *                              numeric comparison (numeric strings coerced);
 *                              ISO date-shaped strings compare
 *                              lexicographically ONLY when BOTH sides match
 *                              the date shape — otherwise `false`.
 *   exists / not_exists        value is neither `null` nor `undefined`
 *                              (empty string counts as existing); never carry
 *                              a `value` (save-time rule).
 *   in / not_in                condition `value` must be a non-empty array
 *                              (schema-guaranteed; runtime fail-closed);
 *                              element comparison is numeric-aware.
 *
 * Owner: A6. Other agents MUST NOT modify this file.
 */
import type { ConditionGroup, ConditionLeaf, ConditionNode } from './schema';
import { CONDITION_FIELD_TYPES } from './schema';
import type { WorkflowEvent } from './events';

/**
 * Sanitized source-record snapshot. Built by A8 (Execution Orchestrator) from
 * the source record loaded under the trigger actor's RLS. The evaluator only
 * reads it — never mutates, never re-fetches.
 */
export interface ConditionSnapshot {
  readonly deal?: Record<string, unknown>;
  readonly task?: Record<string, unknown>;
  readonly project?: Record<string, unknown>;
}

/** Fixed event view exposed to `event.*` condition fields. Kept minimal on
 *  purpose: `CONDITION_FIELD_TYPES` (§11.1) only names `actor_person_id` and
 *  `type`, so those are the only event fields addressable. */
interface EventConditionView {
  readonly actor_person_id: string;
  readonly type: string;
}

/** The combined resolution root: snapshot sections + the fixed event view. */
interface ConditionRoot {
  readonly deal?: Record<string, unknown>;
  readonly task?: Record<string, unknown>;
  readonly project?: Record<string, unknown>;
  readonly event: EventConditionView;
}

// ── Safe field resolution ─────────────────────────────────────────────────

/** Path segments that must never be traversed (prototype-pollution guard). */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

interface ResolvedField {
  /** True when a forbidden segment was encountered: the leaf must be `false`. */
  readonly rejected: boolean;
  /** The resolved value (`undefined` when the path does not exist). */
  readonly value: unknown;
}

/**
 * Resolves a dotted condition field (e.g. `deal.is_won`) against the root by
 * walking own-properties only. Never throws: forbidden segments are rejected,
 * missing paths and non-object intermediates yield `undefined`.
 */
function resolveField(root: ConditionRoot, field: string): ResolvedField {
  let current: unknown = root;
  for (const segment of field.split('.')) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return { rejected: true, value: undefined };
    if (current === null || typeof current !== 'object') {
      return { rejected: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { rejected: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { rejected: false, value: current };
}

// ── Type helpers ──────────────────────────────────────────────────────────

/** Mirrors the numeric-string shape accepted by the save-time schema. */
const NUMERIC_STRING_PATTERN = /^-?\d+(\.\d+)?$/;

/** Mirrors the ISO date shape accepted by the save-time schema. */
const DATE_SHAPE_PATTERN =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** A finite number, or a string of pure numeric shape (e.g. `deal.value`
 *  arriving as `"150000"`). Booleans, null, and non-numeric strings are NOT
 *  numeric-like. */
function isNumericLike(value: unknown): value is number | string {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') {
    // P2-14: trim before the numeric test, like the trigger matcher
    // (triggers.ts) — " 100 " is numeric in both.
    return NUMERIC_STRING_PATTERN.test(value.trim()) && Number.isFinite(Number(value));
  }
  return false;
}

/** Both sides must match the ISO date shape (and be real calendar dates) for
 *  lexicographic date comparison. */
function isDateShapedString(value: unknown): value is string {
  return (
    typeof value === 'string' && DATE_SHAPE_PATTERN.test(value) && !Number.isNaN(Date.parse(value))
  );
}

/**
 * Numeric-aware equality: `null`/`undefined` equal only each other; both
 * numeric-like → compared as numbers; otherwise strict `===`.
 */
function numericAwareEquals(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined);
  }
  if (isNumericLike(a) && isNumericLike(b)) return Number(a) === Number(b);
  return a === b;
}

/**
 * Ordered comparison: `-1 | 0 | 1`, or `null` when the operands are not
 * mutually comparable (numeric pair → numeric; ISO-date-shaped string pair →
 * lexicographic; anything else → incomparable).
 */
function compareOrdered(a: unknown, b: unknown): -1 | 0 | 1 | null {
  if (isNumericLike(a) && isNumericLike(b)) {
    const x = Number(a);
    const y = Number(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (isDateShapedString(a) && isDateShapedString(b)) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return null;
}

/** Text-only, case-insensitive substring. Non-text on either side → `false`. */
function evaluateContains(fieldValue: unknown, conditionValue: unknown): boolean {
  if (typeof fieldValue !== 'string' || typeof conditionValue !== 'string') return false;
  return fieldValue.toLowerCase().includes(conditionValue.toLowerCase());
}

/** Membership with numeric-aware element comparison. A corrupt list (not a
 *  non-empty array — the schema should have prevented this) is unevaluable. */
function evaluateIn(fieldValue: unknown, conditionValue: unknown): boolean {
  if (!Array.isArray(conditionValue) || conditionValue.length === 0) return false;
  return conditionValue.some((element) => numericAwareEquals(fieldValue, element));
}

// ── Leaf / node evaluation ────────────────────────────────────────────────

function evaluateLeaf(leaf: ConditionLeaf, root: ConditionRoot): boolean {
  // Closed field allowlist (§11.1, D5): anything else fails closed at
  // execution, even if it somehow bypassed save-time validation.
  if (CONDITION_FIELD_TYPES[leaf.field] === undefined) return false;

  const resolved = resolveField(root, leaf.field);
  if (resolved.rejected) return false; // forbidden segment — never true, never throws
  const fieldValue = resolved.value;
  const conditionValue = leaf.value;

  switch (leaf.operator) {
    case 'equals':
      return numericAwareEquals(fieldValue, conditionValue);
    case 'not_equals':
      return !numericAwareEquals(fieldValue, conditionValue);
    case 'contains':
      return evaluateContains(fieldValue, conditionValue);
    case 'not_contains':
      return !evaluateContains(fieldValue, conditionValue);
    case 'greater_than':
      return compareOrdered(fieldValue, conditionValue) === 1;
    case 'greater_than_or_equal': {
      const order = compareOrdered(fieldValue, conditionValue);
      return order === 1 || order === 0;
    }
    case 'less_than':
      return compareOrdered(fieldValue, conditionValue) === -1;
    case 'less_than_or_equal': {
      const order = compareOrdered(fieldValue, conditionValue);
      return order === -1 || order === 0;
    }
    case 'exists':
      return fieldValue !== null && fieldValue !== undefined;
    case 'not_exists':
      return fieldValue === null || fieldValue === undefined;
    case 'in':
      return evaluateIn(fieldValue, conditionValue);
    case 'not_in':
      // Corrupt list → unevaluable → fail closed (do NOT negate a `false`
      // that came from corruption).
      if (!Array.isArray(conditionValue) || conditionValue.length === 0) return false;
      return !evaluateIn(fieldValue, conditionValue);
    default:
      // Unknown operator: fail closed (unreachable via the save-time schema).
      return false;
  }
}

function evaluateNode(node: ConditionNode, root: ConditionRoot): boolean {
  if (node.operator === 'AND' || node.operator === 'OR') {
    const group = node as ConditionGroup;
    if (!Array.isArray(group.conditions)) return false;
    // `every` / `some` short-circuit: later siblings are never evaluated once
    // the outcome is decided.
    return group.operator === 'AND'
      ? group.conditions.every((child) => evaluateNode(child, root))
      : group.conditions.some((child) => evaluateNode(child, root));
  }
  return evaluateLeaf(node as ConditionLeaf, root);
}

/**
 * Evaluates a workflow's condition tree against the source-record snapshot and
 * the triggering event.
 *
 * - Empty `conditions` → `true` (no constraints).
 * - `AND` groups require every child to be true; `OR` groups require at least
 *   one (both short-circuit).
 * - Never throws: unresolvable fields, unknown fields/operators, and type
 *   mismatches all evaluate to `false` (fail-closed).
 */
export function evaluateConditions(
  conditions: readonly ConditionNode[],
  snapshot: ConditionSnapshot,
  event: WorkflowEvent,
): boolean {
  if (conditions.length === 0) return true;
  const root: ConditionRoot = {
    deal: snapshot.deal,
    task: snapshot.task,
    project: snapshot.project,
    event: { actor_person_id: event.actorPersonId, type: event.type },
  };
  return conditions.every((node) => evaluateNode(node, root));
}
