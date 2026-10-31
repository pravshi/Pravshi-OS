import { ErrorMessage } from '@/components/crm/error-message';
import { CompaniesList } from '@/components/crm/companies-client';
import { isErrorEnvelope } from '@/components/crm/types';
import { listCompaniesAction } from '../actions';
import { getCrmPermissions, requireCrmPagePermission, uiPermissionsFor } from '../_permissions';

const PAGE_SIZE = 25;

/** /crm/companies — searchable, paginated company list. companies.view to see. */
export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  await requireCrmPagePermission('companies', 'view');
  const params = await searchParams;
  const q = params.q?.trim() ?? '';
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const [result, held] = await Promise.all([
    listCompaniesAction({
      search: q === '' ? undefined : q,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    getCrmPermissions(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
        <p className="mt-1 text-sm text-ink-muted">Customer and prospect organizations.</p>
      </div>
      {isErrorEnvelope(result) ? (
        <ErrorMessage error={result} title="Could not load companies" />
      ) : (
        <CompaniesList
          data={result}
          initialQuery={q}
          page={page}
          perms={uiPermissionsFor(held, 'companies')}
        />
      )}
    </div>
  );
}
