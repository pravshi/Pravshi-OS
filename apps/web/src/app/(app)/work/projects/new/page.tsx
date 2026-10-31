import Link from 'next/link';
import { requirePagePermission } from '@/lib/authz/page';
import { createProjectAction } from '../../_actions';
import { WORK_PERMISSIONS } from '../../_permissions';
import { CreateProjectForm } from '../../_components/CreateProjectForm';

/** /work/projects/new — create a project, then land on its board. */
export default async function NewProjectPage() {
  await requirePagePermission(WORK_PERMISSIONS.projects.create);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link href="/work" className="text-sm text-ink-muted hover:text-foreground">
          ← All projects
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New project</h1>
        <p className="mt-1 text-sm text-ink-muted">
          A project groups related tasks on a kanban board.
        </p>
      </div>
      <CreateProjectForm onSave={createProjectAction} />
    </div>
  );
}
