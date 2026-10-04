import Link from 'next/link';
import { requirePagePermission } from '@/lib/authz/page';
import { Badge } from '@/components/ui/badge';
import { ErrorMessage } from '@/components/crm/error-message';
import { EditableSection } from '@/components/crm/editable-section';
import {
  createTaskAction,
  deleteProjectAction,
  getProjectAction,
  listProjectTasksAction,
  updateProjectAction,
} from '../../_actions';
import { WORK_PERMISSIONS, getWorkPermissions } from '../../_permissions';
import {
  isErrorEnvelope,
  projectStatusBadgeClass,
  projectStatusLabel,
  toRows,
  type PersonOption,
} from '../../_types';
import { TaskBoard } from '../../_components/TaskBoard';
import { EditProjectForm } from '../../_components/EditProjectForm';
import { ArchiveProjectDialog } from '../../_components/ArchiveProjectDialog';
import { UnarchiveProjectButton } from '../../_components/UnarchiveProjectButton';
import { ProjectMembers } from '../../_components/ProjectMembers';
import { LinkedDealSection } from '@/components/work/linked-deal-section';
import { unarchiveProjectAction } from '../../_components/unarchive-project.action';

/**
 * /work/projects/[id] — the task kanban board. projects.view to see; task
 * moves additionally require tasks.edit (enforced by the API on drop).
 */
export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission(WORK_PERMISSIONS.projects.view);
  const { id } = await params;

  const [projectRes, tasksRes, held] = await Promise.all([
    getProjectAction(id),
    listProjectTasksAction(id, { limit: 500, offset: 0 }),
    getWorkPermissions(),
  ]);

  if (isErrorEnvelope(projectRes)) {
    return (
      <div className="space-y-6">
        <Link href="/work" className="text-sm text-ink-muted hover:text-foreground">
          ← All projects
        </Link>
        <ErrorMessage error={projectRes} title="Could not load project" />
      </div>
    );
  }

  const project = projectRes;
  const tasksUnavailable = isErrorEnvelope(tasksRes);
  const tasks = tasksUnavailable ? [] : toRows(tasksRes);

  const canEditProject = held.has(WORK_PERMISSIONS.projects.edit);
  const canDeleteProject = held.has(WORK_PERMISSIONS.projects.delete);
  const canManageMembers = held.has(WORK_PERMISSIONS.projects.manageMembers);
  const canMoveTasks = held.has(WORK_PERMISSIONS.tasks.edit);
  const canCreateTasks = held.has(WORK_PERMISSIONS.tasks.create);
  const canAssignTasks = held.has(WORK_PERMISSIONS.tasks.assign);

  // Assignee options are the people visible on this project's tasks. The API
  // returns denormalized assignee names, so the UI never shows raw UUIDs.
  const assigneeMap = new Map<string, string>();
  for (const task of tasks) {
    if (task.assigneePersonId && task.assigneeName && !assigneeMap.has(task.assigneePersonId)) {
      assigneeMap.set(task.assigneePersonId, task.assigneeName);
    }
  }
  const assignees: PersonOption[] = [...assigneeMap].map(([pid, displayName]) => ({
    id: pid,
    displayName,
  }));

  const statusLabel = projectStatusLabel(project.isArchived);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/work" className="text-sm text-ink-muted hover:text-foreground">
            ← All projects
          </Link>
          <div className="mt-2 flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
            <Badge variant="secondary" className={projectStatusBadgeClass(project.isArchived)}>
              {statusLabel}
            </Badge>
          </div>
          {project.description && (
            <p className="mt-1 max-w-2xl text-sm text-ink-muted">{project.description}</p>
          )}
        </div>
        {canDeleteProject &&
          (project.isArchived ? (
            <UnarchiveProjectButton onUnarchive={unarchiveProjectAction.bind(null, project.id)} />
          ) : (
            <ArchiveProjectDialog
              recordName={project.name}
              onArchive={deleteProjectAction.bind(null, project.id)}
            />
          ))}
      </div>

      {canEditProject && (
        <EditableSection buttonLabel="Edit project">
          <div className="max-w-2xl">
            <EditProjectForm
              project={project}
              onSave={updateProjectAction.bind(null, project.id)}
            />
          </div>
        </EditableSection>
      )}

      <ProjectMembers
        projectId={project.id}
        candidatePeople={assignees}
        canManage={canManageMembers}
      />

      <LinkedDealSection projectId={project.id} canEdit={canEditProject} />

      {tasksUnavailable ? (
        <p className="rounded-lg border border-line bg-ground px-4 py-3 text-sm text-ink-muted">
          Task cards are hidden because you don&apos;t hold <code>tasks.view</code>.
        </p>
      ) : (
        <TaskBoard
          key={project.id}
          projectId={project.id}
          initialTasks={tasks}
          assignees={assignees}
          canMove={canMoveTasks}
          canCreate={canCreateTasks}
          canAssign={canAssignTasks}
          onCreateTask={createTaskAction}
        />
      )}
    </div>
  );
}
