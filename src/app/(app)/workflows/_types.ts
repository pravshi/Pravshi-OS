import type { ErrorEnvelope } from '@/lib/authz/errors';
import type { WORKFLOW_STATUSES } from '@/lib/workflows/schema';
import type { ExecuteWorkflowResult, Workflow, WorkflowPage } from '@/lib/workflows/service';
import type {
  ActionConfig,
  ConditionNode,
  CreateWorkflowInput,
  TriggerConfig,
  UpdateWorkflowInput,
} from '@/lib/workflows/schema';

/**
 * Workflows (Automations) shared types.
 *
 * The wire contract is camelCase, same convention as the work/CRM types.
 * Shapes mirror the /api/workflows/* endpoints (audit §14): the list page
 * tolerates a `{ rows, total, limit, offset }` page response (the contract
 * shape) and normalizes defensively via toRows().
 */

// ── Re-exports so client components never import @/lib/workflows directly ────
export type {
  ActionConfig,
  ConditionNode,
  CreateWorkflowInput,
  ErrorEnvelope,
  ExecuteWorkflowResult,
  TriggerConfig,
  UpdateWorkflowInput,
  Workflow,
  WorkflowPage,
};

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/** Server actions return failures as data: { error: { code, message, ... } }. */
export type WorkflowResult<T> = T | ErrorEnvelope;

export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  if (!('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return typeof error === 'object' && error !== null && 'message' in error;
}

/** Normalize a list response into rows regardless of envelope shape. */
export function toRows<T>(value: { rows: T[] } | T[] | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : (value.rows ?? []);
}

export const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  PAUSED: 'Paused',
  ARCHIVED: 'Archived',
};

export function workflowStatusBadgeClass(status: WorkflowStatus): string {
  switch (status) {
    case 'ACTIVE':
      return 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300';
    case 'PAUSED':
      return 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300';
    case 'ARCHIVED':
      return 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300';
    case 'DRAFT':
    default:
      return 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300';
  }
}

/**
 * One-line human summary of a trigger config for list rows.
 * P2-3: defensive — a hand-edited corrupt row (trigger null / not an object)
 * renders as "Unknown trigger" instead of 500ing the page.
 */
export function triggerSummary(trigger: unknown): string {
  if (typeof trigger !== 'object' || trigger === null) return 'Unknown trigger';
  const t = trigger as { type?: unknown; entityType?: unknown; filters?: unknown };
  const type = typeof t.type === 'string' ? t.type : null;
  const base = type === null ? 'Unknown trigger' : (TRIGGER_TYPE_SHORT_LABELS[type] ?? type);
  const narrowed = typeof t.entityType === 'string' && t.entityType ? ` · ${t.entityType}` : '';
  const filtered =
    typeof t.filters === 'object' && t.filters !== null && Object.keys(t.filters).length > 0
      ? ' · filtered'
      : '';
  return `${base}${narrowed}${filtered}`;
}

/** Compact labels for trigger types (full labels live in the builder). */
const TRIGGER_TYPE_SHORT_LABELS: Record<string, string> = {
  'deal.created': 'Deal created',
  'deal.updated': 'Deal updated',
  'deal.stage_changed': 'Deal stage changed',
  'task.created': 'Task created',
  'task.status_changed': 'Task status changed',
  'task.assigned': 'Task assigned',
  'project.created': 'Project created',
  manual: 'Manual run',
  scheduled: 'Scheduled',
  webhook: 'Webhook',
  'task.overdue': 'Task overdue',
};
