import { requirePagePermission } from '@/lib/authz/page';
import { EmptyState } from '@/components/crm/empty-state';
import { ErrorMessage } from '@/components/crm/error-message';
import { LinkButton } from '@/components/crm/link-button';
import { listProjectsAction } from './_actions';
import { WORK_PERMISSIONS, getWorkPermissions } from './_permissions';
import { isErrorEnvelope, toRows } from './_types';
import { ProjectCard } from './_components/ProjectCard';
import { ProjectSearchForm } from './_components/ProjectSearchForm';

/** /work — project list/grid with search and a "New project" action. */
export default async function WorkHomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requirePagePermission(WORK_PERMISSIONS.projects.view);

  const params = await searchParams;
  const q = params.q?.trim() ?? '';

  const [projectsRes, held] = await Promise.all([
    listProjectsAction({ search: q === '' ? undefined : q, limit: 100, offset: 0 }),
    getWorkPermissions(),
  ]);

  if (isErrorEnvelope(projectsRes)) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Work</h1>
        <ErrorMessage error={projectsRes} title="Could not load projects" />
      </div>
    );
  }

  const projects = toRows(projectsRes);
  const canCreate = held.has(WORK_PERMISSIONS.projects.create);
  const canViewTasks = held.has(WORK_PERMISSIONS.tasks.view);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Work</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Projects and the tasks inside them. Pick a project to open its board.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canViewTasks && (
            <LinkButton href="/work/my-tasks" variant="outline" size="sm">
              My tasks
            </LinkButton>
          )}
          {canCreate && (
            <LinkButton href="/work/projects/new" size="sm">
              New project
            </LinkButton>
          )}
        </div>
      </div>

      <ProjectSearchForm initialQuery={q} />

      {projects.length === 0 ? (
        <EmptyState
          title={q ? 'No projects match your search' : 'No projects yet'}
          description={
            q
              ? 'Try a different search term.'
              : 'Projects group related tasks on a kanban board. Create the first one to get started.'
          }
          action={
            canCreate && !q ? (
              <LinkButton href="/work/projects/new" size="sm">
                Create project
              </LinkButton>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}
