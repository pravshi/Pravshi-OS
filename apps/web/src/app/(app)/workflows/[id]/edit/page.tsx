import Link from 'next/link';
import { requirePagePermission } from '@/lib/authz/page';
import { ErrorMessage } from '@/components/crm/error-message';
import { getWorkflowAction } from '../../_detail-actions';
import { WORKFLOW_PERMISSIONS } from '../../_permissions';
import { isErrorEnvelope } from '../../_types';
// The editor canvas (WorkflowBuilder tree) is the heaviest rarely-first-open
// surface in the app; the Lazy wrapper code-splits it out of First Load
// (Phase 12, F-12-09).
import { EditWorkflowClientLazy as EditWorkflowClient } from '../../_components/EditWorkflowClientLazy';

/** /workflows/[id]/edit — edit a workflow definition in A13's WorkflowBuilder. */
export default async function WorkflowEditPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission(WORKFLOW_PERMISSIONS.workflows.edit);
  const { id } = await params;

  const workflowRes = await getWorkflowAction(id);

  if (isErrorEnvelope(workflowRes)) {
    return (
      <div className="space-y-6">
        <Link href="/workflows" className="text-sm text-ink-muted hover:text-foreground">
          ← All workflows
        </Link>
        <ErrorMessage error={workflowRes} title="Could not load workflow" />
      </div>
    );
  }

  const workflow = workflowRes;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <Link
          href={`/workflows/${workflow.id}`}
          className="text-sm text-ink-muted hover:text-foreground"
        >
          ← Back to {workflow.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Edit workflow</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Saving bumps the workflow to version {workflow.version + 1}. Active workflows pick up the
          new definition on their next run.
        </p>
      </div>
      <EditWorkflowClient initialWorkflow={workflow} />
    </div>
  );
}
