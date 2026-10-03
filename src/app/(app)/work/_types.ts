import type { ErrorEnvelope } from '@/lib/authz/errors';

/**
 * Work Management shared types.
 *
 * The wire contract is camelCase (same convention as the CRM types). Shapes
 * below mirror the /api/work/* endpoints the API track is building:
 * projects and tasks carry denormalized display names (assigneeName,
 * projectName) so the UI never renders raw UUIDs.
 *
 * The UI tolerates both `Page<T>` ({ rows, total, limit, offset }) and bare
 * `T[]` list responses — whichever the API ships, the pages keep working.
 */

export const TASK_STATUSES = ['todo', 'in_progress', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
};

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

/**
 * Project archive state. The API/DB model is a simple isArchived boolean
 * (migration 0042) — not a multi-state status. Display helpers below.
 */
export function projectStatusLabel(isArchived: boolean): string {
  return isArchived ? 'Archived' : 'Active';
}

export function projectStatusBadgeClass(isArchived: boolean): string {
  return isArchived
    ? 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
    : 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300';
}

export interface PersonOption {
  id: string;
  displayName: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  /** Archive flag — the canonical project state per migration 0042. */
  isArchived: boolean;
  ownerPersonId?: string | null;
  ownerName?: string | null;
  /** Per-status task counts, when the API includes them. */
  taskCounts?: Partial<Record<TaskStatus, number>> | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkTask {
  id: string;
  projectId: string;
  projectName: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  /** ISO date (YYYY-MM-DD) or datetime; null when unscheduled. */
  dueDate: string | null;
  assigneePersonId: string | null;
  /** Display name — the UI must never show a raw assignee UUID. */
  assigneeName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkPage<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
}

/** The API's answer to POST /api/work/tasks/:id/move. */
export interface MoveTaskResult {
  status: TaskStatus;
}

export type WorkResult<T> = T | ErrorEnvelope;

/** Re-exported so client components never import @/lib/authz directly. */
export type { ErrorEnvelope };

/** Server actions return failures as data: { error: { code, message, ... } }. */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  if (!('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return typeof error === 'object' && error !== null && 'message' in error;
}

/** Normalize a list response into rows regardless of envelope shape. */
export function toRows<T>(value: WorkPage<T> | T[] | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : (value.rows ?? []);
}

/** Human display name for a task assignee; never a UUID. */
export function assigneeDisplayName(task: Pick<WorkTask, 'assigneeName'>): string {
  return task.assigneeName?.trim() ? task.assigneeName : 'Unassigned';
}
