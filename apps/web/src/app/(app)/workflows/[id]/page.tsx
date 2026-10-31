import Link from 'next/link';
import { requirePagePermission } from '@/lib/authz/page';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorMessage } from '@/components/crm/error-message';
import { DetailField } from '@/components/crm/detail-fields';
import { formatDateTime } from '@/components/crm/format';
import { getWorkflowAction, listWorkflowExecutionsAction } from '../_detail-actions';
import { WORKFLOW_PERMISSIONS, getWorkflowPermissions } from '../_permissions';
import { isErrorEnvelope } from '../_types';
import { WorkflowStatusBadge } from '../_components/WorkflowStatusBadge';
import { WorkflowSummary } from '../_components/WorkflowSummary';
import { WorkflowStatusControls } from '../_components/WorkflowStatusControls';
import { RunNowButton } from '../_components/RunNowButton';
import { DeleteWorkflowButton } from '../_components/DeleteWorkflowButton';
import { ExecutionList } from '../_components/ExecutionList';

/** /workflows/[id] — workflow definition detail: WHEN/IF/THEN, status controls, run history. */
export default async function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission(WORKFLOW_PERMISSIONS.workflows.view);
  const { id } = await params;

  const [workflowRes, executionsRes, held] = await Promise.all([
    getWorkflowAction(id),
    listWorkflowExecutionsAction(id, { limit: 10, offset: 0 }),
    getWorkflowPermissions(),
  ]);

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
  const canActivate = held.has(WORKFLOW_PERMISSIONS.workflows.activate);
  const canEdit = held.has(WORKFLOW_PERMISSIONS.workflows.edit);
  const canExecute = held.has(WORKFLOW_PERMISSIONS.workflows.execute);
  const canDelete = held.has(WORKFLOW_PERMISSIONS.workflows.delete);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/workflows" className="text-sm text-ink-muted hover:text-foreground">
            ← All workflows
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{workflow.name}</h1>
            <WorkflowStatusBadge status={workflow.status} />
            <Badge variant="outline" className="font-mono text-[10px]">
              v{workflow.version}
            </Badge>
          </div>
          {workflow.description && (
            <p className="mt-2 max-w-2xl text-sm text-ink-muted">{workflow.description}</p>
          )}
        </div>
        <WorkflowStatusControls
          workflowId={workflow.id}
          status={workflow.status}
          canActivate={canActivate}
          canEdit={canEdit}
        />
      </div>

      <WorkflowSummary workflow={workflow} />

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 sm:grid-cols-2">
            <DetailField label="Status">
              <WorkflowStatusBadge status={workflow.status} />
            </DetailField>
            <DetailField label="Version">v{workflow.version}</DetailField>
            <DetailField label="Last run">
              {workflow.lastExecutionAt ? formatDateTime(workflow.lastExecutionAt) : '—'}
            </DetailField>
            <DetailField label="Last run status">{workflow.lastExecutionStatus ?? '—'}</DetailField>
            <DetailField label="Created">{formatDateTime(workflow.createdAt)}</DetailField>
            <DetailField label="Updated">{formatDateTime(workflow.updatedAt)}</DetailField>
          </dl>
        </CardContent>
      </Card>

      {canExecute && (
        <Card>
          <CardHeader>
            <CardTitle>Manual run</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-ink-muted">
              Execute this workflow immediately as yourself — the run can do no more than you could
              do directly.
            </p>
            <RunNowButton workflowId={workflow.id} status={workflow.status} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Execution history</CardTitle>
        </CardHeader>
        <CardContent>
          {isErrorEnvelope(executionsRes) ? (
            <ErrorMessage error={executionsRes} title="Could not load run history" />
          ) : (
            <ExecutionList workflowId={workflow.id} initial={executionsRes} />
          )}
        </CardContent>
      </Card>

      {canDelete && (
        <Card className="border-red-200 dark:border-red-900/50">
          <CardHeader>
            <CardTitle className="text-red-700 dark:text-red-300">Danger zone</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-ink-muted">
              Deleting soft-deletes this workflow. It stops matching events immediately but remains
              recoverable in the audit trail. The status lifecycle is Draft → Active → Paused —
              there is no archive transition.
            </p>
            <DeleteWorkflowButton workflowId={workflow.id} workflowName={workflow.name} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
