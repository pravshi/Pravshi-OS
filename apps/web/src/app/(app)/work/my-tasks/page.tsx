import Link from 'next/link';
import { requirePagePermission } from '@/lib/authz/page';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/crm/empty-state';
import { ErrorMessage } from '@/components/crm/error-message';
import { formatDate } from '@/components/crm/format';
import { listMyTasksAction } from '../_actions';
import { WORK_PERMISSIONS } from '../_permissions';
import {
  TASK_PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  isErrorEnvelope,
  toRows,
  type TaskPriority,
  type WorkTask,
} from '../_types';
import { PRIORITY_BADGE_CLASSES } from '../_components/TaskCard';
import { MyTasksSearchForm } from './_components/MyTasksSearchForm';

function MyTaskRow({ task }: { task: WorkTask }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
      <Link
        href={`/work/tasks/${task.id}`}
        className="min-w-0 flex-1 basis-48 truncate text-sm font-medium hover:underline"
      >
        {task.title}
      </Link>
      {task.projectName && (
        <Link
          href={`/work/projects/${task.projectId}`}
          className="truncate text-xs text-ink-muted hover:text-foreground"
        >
          {task.projectName}
        </Link>
      )}
      <Badge
        variant="secondary"
        className={PRIORITY_BADGE_CLASSES[task.priority as TaskPriority] ?? ''}
      >
        {TASK_PRIORITY_LABELS[task.priority as TaskPriority] ?? task.priority}
      </Badge>
      <span className="w-24 shrink-0 text-right text-xs text-ink-muted">
        {task.dueDate ? formatDate(task.dueDate) : 'No due date'}
      </span>
    </li>
  );
}

/** /work/my-tasks — tasks assigned to the current user, grouped by status. */
export default async function MyTasksPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requirePagePermission(WORK_PERMISSIONS.tasks.view);

  const params = await searchParams;
  const q = params.q?.trim() ?? '';

  const tasksRes = await listMyTasksAction({
    search: q === '' ? undefined : q,
    limit: 200,
    offset: 0,
  });

  if (isErrorEnvelope(tasksRes)) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">My tasks</h1>
        <ErrorMessage error={tasksRes} title="Could not load your tasks" />
      </div>
    );
  }

  const tasks = toRows(tasksRes);
  const byStatus = new Map<(typeof TASK_STATUSES)[number], WorkTask[]>();
  for (const s of TASK_STATUSES) byStatus.set(s, []);
  for (const task of tasks) {
    const bucket = byStatus.get(task.status) ?? byStatus.get('todo');
    bucket?.push(task);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My tasks</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Everything assigned to you, grouped by status.
        </p>
      </div>

      <MyTasksSearchForm initialQuery={q} />

      {tasks.length === 0 ? (
        <EmptyState
          title={q ? 'No tasks match your search' : 'Nothing assigned to you'}
          description={
            q ? 'Try a different search term.' : 'Tasks assigned to you will show up here.'
          }
        />
      ) : (
        <div className="space-y-6">
          {TASK_STATUSES.map((status) => {
            const group = byStatus.get(status) ?? [];
            if (group.length === 0) return null;
            return (
              <section key={status} aria-label={`${TASK_STATUS_LABELS[status]} — my tasks`}>
                <h2 className="mb-2 text-sm font-semibold">
                  {TASK_STATUS_LABELS[status]}{' '}
                  <span className="font-normal text-ink-muted">({group.length})</span>
                </h2>
                <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
                  {group.map((task) => (
                    <MyTaskRow key={task.id} task={task} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
