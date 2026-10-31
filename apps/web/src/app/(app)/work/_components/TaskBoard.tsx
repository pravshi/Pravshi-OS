'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/crm/empty-state';
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  isErrorEnvelope,
  type PersonOption,
  type TaskStatus,
  type WorkResult,
  type WorkTask,
} from '../_types';
import { StatusColumn } from './StatusColumn';
import type { TaskFormInput } from './TaskForm';

/**
 * The create-task form (with its assignee picker) only renders inside the
 * "New task" dialog, so it is code-split out of the board's First Load and
 * fetched when the dialog first opens (Phase 12, F-12-09). `ssr: false` is
 * the load-bearing half: with server rendering on, next/dynamic still
 * preloads the chunk into First Load.
 */
const TaskForm = dynamic(() => import('./TaskForm').then((m) => m.TaskForm), {
  ssr: false,
  loading: () => <TaskFormSkeleton />,
});

function TaskFormSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <span className="sr-only">Loading task form…</span>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

type ColumnsState = Record<TaskStatus, WorkTask[]>;

function groupTasks(tasks: WorkTask[]): ColumnsState {
  const columns: ColumnsState = { todo: [], in_progress: [], done: [] };
  for (const task of tasks) {
    if (TASK_STATUSES.includes(task.status)) columns[task.status].push(task);
    else columns.todo.push(task);
  }
  return columns;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The project task board. Native HTML5 drag-and-drop (no DnD library):
 *
 *  - drop → optimistic move → POST /api/work/tasks/:id/move { status }
 *  - 400 (unknown status) → toast "Cannot move there" + rollback
 *  - 403/404 (access lost mid-session) → toast + refetch from the server
 *  - network failure → toast + rollback
 *
 * Keyboard: Left/Right arrows on a focused card move it between columns
 * through the same optimistic path; moves are announced via an aria-live
 * region.
 */
export function TaskBoard({
  projectId,
  initialTasks,
  assignees,
  canMove,
  canCreate,
  canAssign,
  onCreateTask,
}: {
  projectId: string;
  initialTasks: WorkTask[];
  assignees: PersonOption[];
  canMove: boolean;
  canCreate: boolean;
  canAssign: boolean;
  onCreateTask: (input: TaskFormInput) => Promise<WorkResult<WorkTask>>;
}) {
  const router = useRouter();

  const initial = useMemo(() => groupTasks(initialTasks), [initialTasks]);
  const [columns, setColumns] = useState<ColumnsState>(initial);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<TaskStatus | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const snapshot = useRef<ColumnsState | null>(null);

  const totalTasks = TASK_STATUSES.reduce((n, s) => n + (columns[s]?.length ?? 0), 0);

  /** The status column holding the task, undefined when unknown. */
  function findSource(taskId: string): TaskStatus | undefined {
    for (const status of TASK_STATUSES) {
      if ((columns[status] ?? []).some((t) => t.id === taskId)) return status;
    }
    return undefined;
  }

  async function moveTask(taskId: string, toStatus: TaskStatus) {
    if (!canMove || !UUID_RE.test(taskId)) return;
    const source = findSource(taskId);
    if (source === undefined || source === toStatus) return;

    const task = columns[source]?.find((t) => t.id === taskId);
    if (!task) return;

    snapshot.current = columns;
    const moved: WorkTask = { ...task, status: toStatus };
    setColumns((prev) => ({
      ...prev,
      [source]: (prev[source] ?? []).filter((t) => t.id !== taskId),
      [toStatus]: [...(prev[toStatus] ?? []), moved],
    }));
    setOverStatus(null);
    setDraggingId(null);

    try {
      const res = await fetch(`/api/work/tasks/${taskId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: toStatus }),
      });
      if (res.ok) {
        const data: { status?: unknown; task?: { status?: unknown } } = await res
          .json()
          .catch(() => ({}));
        // Reconcile against the authoritative answer, not our guess.
        const authoritative = (data.status ?? data.task?.status) as TaskStatus | undefined;
        if (
          authoritative &&
          authoritative !== toStatus &&
          (TASK_STATUSES as readonly string[]).includes(authoritative)
        ) {
          setColumns((prev) => ({
            ...prev,
            [toStatus]: (prev[toStatus] ?? []).filter((t) => t.id !== taskId),
            [authoritative]: [...(prev[authoritative] ?? []), { ...moved, status: authoritative }],
          }));
        }
        setAnnouncement(`Moved “${task.title}” to ${TASK_STATUS_LABELS[toStatus]}.`);
        return;
      }
      const snap = snapshot.current;
      if (res.status === 400) {
        if (snap) setColumns(snap);
        toast.error('Cannot move there', {
          description: 'That is not a valid task status.',
        });
      } else if (res.status === 403 || res.status === 404) {
        toast.error('Move failed', {
          description: 'Your access changed — reloading the board.',
        });
        router.refresh();
      } else {
        if (snap) setColumns(snap);
        toast.error('Move failed', { description: 'Please try again.' });
      }
    } catch {
      const snap = snapshot.current;
      if (snap) setColumns(snap);
      toast.error('Move failed', { description: 'Check your connection and try again.' });
    }
  }

  function keyboardMove(taskId: string, direction: -1 | 1) {
    const source = findSource(taskId);
    if (source === undefined) return;
    const next = TASK_STATUSES[TASK_STATUSES.indexOf(source) + direction];
    if (next) void moveTask(taskId, next);
  }

  async function handleCreateTask(input: TaskFormInput): Promise<WorkResult<WorkTask>> {
    const result = await onCreateTask(input);
    if (!isErrorEnvelope(result)) {
      const status: TaskStatus = TASK_STATUSES.includes(result.status) ? result.status : 'todo';
      setColumns((prev) => ({
        ...prev,
        [status]: [...(prev[status] ?? []), { ...result, status }],
      }));
      setNewTaskOpen(false);
      setAnnouncement(`Created task “${result.title}” in ${TASK_STATUS_LABELS[status]}.`);
    }
    return result;
  }

  return (
    <>
      <Toaster />
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-ink-muted">
          {canMove
            ? 'Drag a card onto another column — or focus it and use the arrow keys — to move the task.'
            : 'You can view this board but not move tasks.'}
        </p>
        {canCreate && (
          <Button size="sm" onClick={() => setNewTaskOpen(true)}>
            New task
          </Button>
        )}
      </div>

      {totalTasks === 0 ? (
        <EmptyState
          title="No tasks yet"
          description="Tasks track the work inside this project. Create the first one to get the board going."
          action={
            canCreate ? (
              <Button size="sm" onClick={() => setNewTaskOpen(true)}>
                Create task
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div
          className="flex gap-4 overflow-x-auto pb-4"
          role="list"
          aria-label="Task status columns"
        >
          {TASK_STATUSES.map((status) => (
            <div key={status} role="listitem" className="shrink-0">
              <StatusColumn
                status={status}
                tasks={columns[status] ?? []}
                canMove={canMove}
                isDragOver={overStatus === status}
                onDragStart={setDraggingId}
                onDragEnd={() => {
                  setDraggingId(null);
                  setOverStatus(null);
                }}
                onDragOverColumn={setOverStatus}
                onDragLeaveColumn={() => setOverStatus(null)}
                onDropOnColumn={(s) => {
                  const id = draggingId;
                  if (id) void moveTask(id, s);
                }}
                onKeyboardMove={keyboardMove}
              />
            </div>
          ))}
        </div>
      )}

      <Dialog open={newTaskOpen} onOpenChange={setNewTaskOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
          </DialogHeader>
          <TaskForm
            fixedProjectId={projectId}
            assignees={assignees}
            canAssign={canAssign}
            onSave={handleCreateTask}
            submitLabel="Create task"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
