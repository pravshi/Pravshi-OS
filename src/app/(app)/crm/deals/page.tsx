import { ErrorMessage } from '@/components/crm/error-message';
import { DealsList } from '@/components/crm/deals-client';
import { isErrorEnvelope, DEAL_STAGES, type DealStage } from '@/components/crm/types';
import { listDealsAction, listCompaniesAction } from '../_api';
import { getCrmPermissions, requireCrmPagePermission, uiPermissionsFor } from '../_permissions';

const PAGE_SIZE = 25;

/** /crm/deals — deal list with stage filter tabs. deals.view to see. */
export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string; page?: string }>;
}) {
  await requireCrmPagePermission('deals', 'view');
  const params = await searchParams;
  const stage: DealStage | null = DEAL_STAGES.includes(params.stage as DealStage)
    ? (params.stage as DealStage)
    : null;
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const [result, companiesRes, held] = await Promise.all([
    listDealsAction({
      stage: stage ?? undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    // Company names for the table; the real API should join these (gap note).
    listCompaniesAction({ limit: 100 }),
    getCrmPermissions(),
  ]);

  if (isErrorEnvelope(result)) {
    return (
      <div className="space-y-6">
        <ListHeader />
        <ErrorMessage error={result} title="Could not load deals" />
      </div>
    );
  }

  const companyNames = new Map<string, string>();
  if (!isErrorEnvelope(companiesRes)) {
    for (const c of companiesRes.rows) companyNames.set(c.id, c.name);
  }

  return (
    <div className="space-y-6">
      <ListHeader />
      <DealsList
        data={result}
        stage={stage}
        page={page}
        perms={uiPermissionsFor(held, 'deals')}
        companyNames={companyNames}
      />
    </div>
  );
}

function ListHeader() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Deals</h1>
      <p className="mt-1 text-sm text-ink-muted">Pipeline: value, stage, and expected close.</p>
    </div>
  );
}
