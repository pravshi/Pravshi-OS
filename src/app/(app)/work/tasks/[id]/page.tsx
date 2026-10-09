import Link from 'next/link';
import { requirePagePermission } from '@/lib/authz/page';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorMessage } from '@/components/crm/error-message';
import { EditableSection } from '@/components/crm/editable-section';
import { DeleteDialog } from '@/components/crm/delete-dialog';
import { SubtaskList } from '@/components/work/subtask-list';
import { TaskReminders } from '@/components/work/task-reminders';
import { DetailField, DetailLink } from '@/components/crm/detail-fields';
import { formatDate, formatDateTime } from '@/components/crm/format';
import { deleteTaskAction, getTaskAction, updateTaskAction } from '../../_actions';
import { listSubtasksAction } from '../../subtasks/actions';
import { WORK_PERMISSIONS, getWorkPermissions } from '../../_permissions';
import {
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  assigneeDisplayName,
  isErrorEnvelope,
  toRows,
  type PersonOption,
} from '../../_types';
import { PRIORITY_BADGE_CLASSES } from '../../_components/TaskCard';
// The task editor (TaskForm tree, with its pickers) only renders after the
// user opens "Edit task"; the Lazy wrapper code-splits it out of First Load
// (Phase 12, F-12-09).
import { EditTaskFormLazy as EditTaskForm } from '../../_components/EditTaskFormLazy';
import { AiSummaryPanel } from '@/components/ai/AiSummaryPanel';
import { canUseAi } from '@/components/ai/can-use-ai';

const STATUS_BADGE: Record<string, string> = {
  todo: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  in_progress: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
};

/** /work/tasks/[id] — view and edit a single task. */
export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission(WORK_PERMISSIONS.tasks.view);
  const { id } = await params;

  const [taskRes, held, aiAllowed] = await Promise.all([
    getTaskAction(id),
    getWorkPermissions(),
    canUseAi(),
  ]);

  if (isErrorEnvelope(taskRes)) {
    return (
      <div className="space-y-6">
        <Link href="/work" className="text-sm text-ink-muted hover:text-foreground">
          ← All projects
        </Link>
        <ErrorMessage error={taskRes} title="Could not load task" />
      </div>
    );
  }

  const task = taskRes;
  const canEdit = held.has(WORK_PERMISSIONS.tasks.edit);
  const canDelete = held.has(WORK_PERMISSIONS.tasks.delete);
  const canAssign = held.has(WORK_PERMISSIONS.tasks.assign);
  const canCreateSubtasks = held.has(WORK_PERMISSIONS.tasks.create);

  // Subtasks load after the task itself; a permission failure here degrades to
  // an empty list (SubtaskList gates its create/toggle forms from props).
  const subtasksRes = await listSubtasksAction(task.id, {});
  const initialSubtasks = isErrorEnvelope(subtasksRes) ? [] : toRows(subtasksRes);

  // Keep the current assignee selectable even when they appear on no other
  // visible task.
  const assignees: PersonOption[] =
    task.assigneePersonId && task.assigneeName
      ? [{ id: task.assigneePersonId, displayName: task.assigneeName }]
      : [];

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href={`/work/projects/${task.projectId}`}
            className="text-sm text-ink-muted hover:text-foreground"
          >
            ← Back to project
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{task.title}</h1>
            <Badge variant="secondary" className={STATUS_BADGE[task.status] ?? ''}>
              {TASK_STATUS_LABELS[task.status]}
            </Badge>
            <Badge variant="secondary" className={PRIORITY_BADGE_CLASSES[task.priority]}>
              {TASK_PRIORITY_LABELS[task.priority]}
            </Badge>
          </div>
        </div>
        {canDelete && (
          <DeleteDialog
            resourceName="task"
            recordName={task.title}
            onDelete={deleteTaskAction.bind(null, task.id)}
            redirectTo={`/work/projects/${task.projectId}`}
          />
        )}
      </div>

      <AiSummaryPanel
        capability="task_summary"
        entityType="task"
        entityId={task.id}
        canUseAi={aiAllowed}
      />

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y divide-line">
            <DetailField label="Title">{task.title}</DetailField>
            <DetailField label="Description">
              {task.description ? (
                <span className="whitespace-pre-wrap">{task.description}</span>
              ) : (
                '—'
              )}
            </DetailField>
            <DetailField label="Status">{TASK_STATUS_LABELS[task.status]}</DetailField>
            <DetailField label="Priority">{TASK_PRIORITY_LABELS[task.priority]}</DetailField>
            <DetailField label="Due date">{formatDate(task.dueDate)}</DetailField>
            <DetailField label="Assignee">{assigneeDisplayName(task)}</DetailField>
            <DetailField label="Project">
              {task.projectName ? (
                <DetailLink href={`/work/projects/${task.projectId}`}>
                  {task.projectName}
                </DetailLink>
              ) : (
                <DetailLink href={`/work/projects/${task.projectId}`}>View project</DetailLink>
              )}
            </DetailField>
            <DetailField label="Created">{formatDateTime(task.createdAt)}</DetailField>
            <DetailField label="Updated">{formatDateTime(task.updatedAt)}</DetailField>
          </dl>
        </CardContent>
      </Card>

      <SubtaskList
        parentTaskId={task.id}
        initialSubtasks={initialSubtasks}
        canCreate={canCreateSubtasks}
        canToggle={canEdit}
      />

      <TaskReminders taskId={task.id} canSet={canEdit} />

      {canEdit && (
        <EditableSection buttonLabel="Edit task">
          <EditTaskForm
            task={task}
            assignees={assignees}
            canAssign={canAssign}
            onSave={updateTaskAction.bind(null, task.id)}
          />
        </EditableSection>
      )}
    </div>
  );
}
