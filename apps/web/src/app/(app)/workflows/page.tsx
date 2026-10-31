import Link from 'next/link';
import { requirePagePermission } from '@/lib/authz/page';
import { WORKFLOW_STATUSES } from '@/lib/workflows/schema';
import { EmptyState } from '@/components/crm/empty-state';
import { ErrorMessage } from '@/components/crm/error-message';
import { LinkButton } from '@/components/crm/link-button';
import { listWorkflowsAction } from './_actions';
import { WORKFLOW_PERMISSIONS, getWorkflowPermissions } from './_permissions';
import {
  WORKFLOW_STATUS_LABELS,
  isErrorEnvelope,
  toRows,
  triggerSummary,
  workflowStatusBadgeClass,
  type Workflow,
  type WorkflowStatus,
} from './_types';
import { WorkflowSearchForm } from './_components/WorkflowSearchForm';

function WorkflowCard({ workflow }: { workflow: Workflow }) {
  return (
    <Link
      href={`/workflows/${workflow.id}`}
      className="block rounded-lg border border-line bg-card p-4 transition-colors hover:border-foreground/30"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold">{workflow.name}</h2>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${workflowStatusBadgeClass(workflow.status)}`}
        >
          {WORKFLOW_STATUS_LABELS[workflow.status]}
        </span>
      </div>
      {workflow.description && (
        <p className="mt-1 line-clamp-2 text-sm text-ink-muted">{workflow.description}</p>
      )}
      <dl className="mt-3 space-y-1 text-xs text-ink-muted">
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 font-medium">Trigger</dt>
          <dd>{triggerSummary(workflow.trigger)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 font-medium">Actions</dt>
          <dd>
            {workflow.actions.length} step{workflow.actions.length === 1 ? '' : 's'} · v
            {workflow.version}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 font-medium">Last run</dt>
          <dd>
            {workflow.lastExecutionAt
              ? `${workflow.lastExecutionStatus ?? 'ran'} · ${new Date(workflow.lastExecutionAt).toLocaleString()}`
              : 'Never'}
          </dd>
        </div>
      </dl>
    </Link>
  );
}

/** /workflows — automation list with search + status filter. */
export default async function WorkflowsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  await requirePagePermission(WORKFLOW_PERMISSIONS.workflows.view);

  const params = await searchParams;
  const q = params.q?.trim() ?? '';
  const status = (WORKFLOW_STATUSES as readonly string[]).includes(params.status ?? '')
    ? (params.status as WorkflowStatus)
    : '';

  const [workflowsRes, held] = await Promise.all([
    listWorkflowsAction({
      search: q === '' ? undefined : q,
      status: status === '' ? undefined : status,
      limit: 100,
      offset: 0,
    }),
    getWorkflowPermissions(),
  ]);

  if (isErrorEnvelope(workflowsRes)) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Automations</h1>
        <ErrorMessage error={workflowsRes} title="Could not load workflows" />
      </div>
    );
  }

  const workflows = toRows(workflowsRes);
  const canCreate = held.has(WORKFLOW_PERMISSIONS.workflows.create);
  const filtered = q !== '' || status !== '';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Automations</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Workflows watch for events and run ordered actions — e.g. a won deal spawning onboarding
            tasks.
          </p>
        </div>
        {canCreate && (
          <LinkButton href="/workflows/new" size="sm">
            New workflow
          </LinkButton>
        )}
      </div>

      <WorkflowSearchForm initialQuery={q} initialStatus={status} />

      {workflows.length === 0 ? (
        <EmptyState
          title={filtered ? 'No workflows match your filters' : 'No workflows yet'}
          description={
            filtered
              ? 'Try a different search term or status.'
              : 'Build your first WHEN → IF → THEN automation. It starts as a draft, and you activate it when it is ready.'
          }
          action={
            canCreate && !filtered ? (
              <LinkButton href="/workflows/new" size="sm">
                New workflow
              </LinkButton>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workflows.map((workflow) => (
            <WorkflowCard key={workflow.id} workflow={workflow} />
          ))}
        </div>
      )}
    </div>
  );
}
