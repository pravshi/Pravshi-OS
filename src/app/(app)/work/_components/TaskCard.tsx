'use client';

import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/components/crm/format';
import {
  TASK_PRIORITY_LABELS,
  assigneeDisplayName,
  type TaskPriority,
  type WorkTask,
} from '../_types';

/**
 * Semantic-only priority colors: neutral → blue → amber → red.
 * Everything else stays black-on-white per the Apple-minimal language.
 */
export const PRIORITY_BADGE_CLASSES: Record<TaskPriority, string> = {
  low: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  medium: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  high: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  urgent: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

function isOverdue(dueDate: string | null, status: WorkTask['status']): boolean {
  if (!dueDate || status === 'done') return false;
  const d = new Date(dueDate);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d < today;
}

/**
 * A draggable task card on the kanban board.
 *
 * Keyboard: the card is focusable; Left/Right arrows move it between status
 * columns (same optimistic path as drag-and-drop), Enter follows the title
 * link to the task detail page.
 */
export function TaskCard({
  task,
  draggable,
  onDragStart,
  onDragEnd,
  onKeyboardMove,
}: {
  task: WorkTask;
  draggable: boolean;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  onKeyboardMove: (taskId: string, direction: -1 | 1) => void;
}) {
  const overdue = isOverdue(task.dueDate, task.status);

  return (
    <Card
      tabIndex={0}
      role="option"
      aria-selected="false"
      aria-label={`${task.title}. ${TASK_PRIORITY_LABELS[task.priority]} priority. ${
        task.dueDate ? `Due ${formatDate(task.dueDate)}. ` : ''
      }Assigned to ${assigneeDisplayName(task)}.`}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(task.id);
      }}
      onDragEnd={onDragEnd}
      onKeyDown={(e) => {
        if (!draggable) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          onKeyboardMove(task.id, e.key === 'ArrowRight' ? 1 : -1);
        }
      }}
      className={
        draggable
          ? 'cursor-grab focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 active:cursor-grabbing'
          : 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
      }
    >
      <CardContent className="space-y-1.5 p-3">
        <Link
          href={`/work/tasks/${task.id}`}
          className="block text-sm font-medium leading-snug hover:underline"
          draggable={false}
          onClick={(e) => e.stopPropagation()}
        >
          {task.title}
        </Link>
        <div className="flex items-center gap-1.5">
          <Badge className={PRIORITY_BADGE_CLASSES[task.priority]}>
            {TASK_PRIORITY_LABELS[task.priority]}
          </Badge>
          {task.dueDate && (
            <span
              className={`text-xs ${overdue ? 'font-medium text-red-700 dark:text-red-300' : 'text-ink-muted'}`}
              title={overdue ? 'Overdue' : 'Due date'}
            >
              {formatDate(task.dueDate)}
            </span>
          )}
        </div>
        <p className="truncate text-xs text-ink-muted">{assigneeDisplayName(task)}</p>
        <span className="sr-only">
          Press the left or right arrow key to move this task between columns.
        </span>
      </CardContent>
    </Card>
  );
}
