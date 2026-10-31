import { ErrorMessage } from '@/components/crm/error-message';
import { isErrorEnvelope } from '@/components/crm/types';
import { PipelinesList } from './_components/PipelinesList';
import { listPipelinesAction } from './_actions';
import { getCrmPermissions, requireCrmPagePermission, uiPermissionsFor } from '../_permissions';

const PAGE_SIZE = 25;

/** /crm/pipelines — pipeline list. pipelines.view to see. */
export default async function PipelinesPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; page?: string }>;
}) {
  await requireCrmPagePermission('pipelines', 'view');
  const params = await searchParams;
  const search = (params.search ?? '').trim();
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const [result, held] = await Promise.all([
    listPipelinesAction({
      search: search || undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    getCrmPermissions(),
  ]);

  if (isErrorEnvelope(result)) {
    return (
      <div className="space-y-6">
        <ListHeader />
        <ErrorMessage error={result} title="Could not load pipelines" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ListHeader />
      <PipelinesList
        data={result}
        search={search}
        page={page}
        perms={uiPermissionsFor(held, 'pipelines')}
      />
    </div>
  );
}

function ListHeader() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Pipelines</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Kanban boards for every sales pipeline: stages, forecast, and velocity.
      </p>
    </div>
  );
}
