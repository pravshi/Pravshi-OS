'use client';

import { Badge } from '@/components/ui/badge';
import { TASK_STATUS_LABELS, type TaskStatus, type WorkTask } from '../_types';
import { TaskCard } from './TaskCard';

/** One kanban column: status header + droppable task list. Native HTML5 DnD. */
export function StatusColumn({
  status,
  tasks,
  canMove,
  isDragOver,
  onDragStart,
  onDragEnd,
  onDragOverColumn,
  onDragLeaveColumn,
  onDropOnColumn,
  onKeyboardMove,
}: {
  status: TaskStatus;
  tasks: WorkTask[];
  canMove: boolean;
  isDragOver: boolean;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  onDragOverColumn: (status: TaskStatus) => void;
  onDragLeaveColumn: () => void;
  onDropOnColumn: (status: TaskStatus) => void;
  onKeyboardMove: (taskId: string, direction: -1 | 1) => void;
}) {
  return (
    <section
      aria-label={`Status column: ${TASK_STATUS_LABELS[status]}`}
      onDragOver={(e) => {
        if (!canMove) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDragOverColumn(status);
      }}
      onDragLeave={onDragLeaveColumn}
      onDrop={(e) => {
        if (!canMove) return;
        e.preventDefault();
        onDropOnColumn(status);
      }}
      className={`flex w-72 shrink-0 flex-col rounded-lg border bg-surface transition-colors ${
        isDragOver ? 'border-neutral-900 dark:border-neutral-100' : 'border-line'
      }`}
    >
      <header className="flex items-center gap-2 border-b border-line p-3">
        <h3 className="text-sm font-semibold">{TASK_STATUS_LABELS[status]}</h3>
        <Badge variant="secondary" className="shrink-0">
          {tasks.length}
        </Badge>
      </header>
      <div
        role="listbox"
        aria-label={`${TASK_STATUS_LABELS[status]} tasks`}
        className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2"
      >
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            draggable={canMove}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onKeyboardMove={onKeyboardMove}
          />
        ))}
        {tasks.length === 0 && (
          <p className="rounded border border-dashed border-line px-3 py-6 text-center text-xs text-ink-muted">
            {canMove ? 'Drop tasks here' : 'No tasks'}
          </p>
        )}
      </div>
    </section>
  );
}
