import { Badge } from '@/components/ui/badge';
import { WORKFLOW_STATUS_LABELS, workflowStatusBadgeClass } from '../_types';
import type { WorkflowStatus } from '../_types';

/**
 * WorkflowStatusBadge — small status pill for workflow definitions.
 *
 * DRAFT/ACTIVE/PAUSED/ARCHIVED each get a distinct subtle color via the
 * shared workflowStatusBadgeClass() (owned by the builder track's _types).
 * ExecutionStatusBadge covers run states (PENDING/RUNNING/SUCCEEDED/FAILED/
 * CANCELLED) and step states (adds SKIPPED).
 */

export function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
  return (
    <Badge variant="secondary" className={workflowStatusBadgeClass(status)}>
      {WORKFLOW_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

const EXECUTION_BADGE_CLASSES: Record<string, string> = {
  PENDING: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  RUNNING: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  SUCCEEDED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  FAILED: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  CANCELLED: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
  SKIPPED: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
};

export const EXECUTION_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pending',
  RUNNING: 'Running',
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  SKIPPED: 'Skipped',
};

export function ExecutionStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="secondary" className={EXECUTION_BADGE_CLASSES[status] ?? ''}>
      {EXECUTION_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}
