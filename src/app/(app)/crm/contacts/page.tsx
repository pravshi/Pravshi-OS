import { ErrorMessage } from '@/components/crm/error-message';
import { ContactsList } from '@/components/crm/contacts-client';
import { isErrorEnvelope } from '@/components/crm/types';
import { listContactsAction, listCompaniesAction } from '../_api';
import { getCrmPermissions, requireCrmPagePermission, uiPermissionsFor } from '../_permissions';

const PAGE_SIZE = 25;

/** /crm/contacts — searchable, paginated contact list. contacts.view to see. */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  await requireCrmPagePermission('contacts', 'view');
  const params = await searchParams;
  const q = params.q?.trim() ?? '';
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const [result, companiesRes, held] = await Promise.all([
    listContactsAction({
      search: q === '' ? undefined : q,
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
        <ErrorMessage error={result} title="Could not load contacts" />
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
      <ContactsList
        data={result}
        initialQuery={q}
        page={page}
        perms={uiPermissionsFor(held, 'contacts')}
        companyNames={companyNames}
      />
    </div>
  );
}

function ListHeader() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
      <p className="mt-1 text-sm text-ink-muted">People at customer and prospect organizations.</p>
    </div>
  );
}
