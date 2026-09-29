import { ErrorMessage } from '@/components/crm/error-message';
import { DealForm } from '@/components/crm/deal-form';
import { isErrorEnvelope } from '@/components/crm/types';
import { createDealAction, listCompaniesAction, listContactsAction } from '../../_api';
import { requireCrmPagePermission } from '../../_permissions';

/** /crm/deals/new — create a deal with company and contact pickers. */
export default async function NewDealPage() {
  await requireCrmPagePermission('deals', 'create');

  const [companiesRes, contactsRes] = await Promise.all([
    listCompaniesAction({ limit: 100 }),
    listContactsAction({ limit: 100 }),
  ]);

  if (isErrorEnvelope(companiesRes)) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">New deal</h1>
        <ErrorMessage error={companiesRes} title="Could not load companies" />
      </div>
    );
  }

  if (isErrorEnvelope(contactsRes)) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">New deal</h1>
        <ErrorMessage error={contactsRes} title="Could not load contacts" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New deal</h1>
        <p className="mt-1 text-sm text-ink-muted">
          You become the owner of every deal you create. A contact must belong to the deal&apos;s
          company.
        </p>
      </div>
      <DealForm
        companies={companiesRes.rows.map((c) => ({ id: c.id, name: c.name }))}
        contacts={contactsRes.rows.map((c) => ({
          id: c.id,
          company_id: c.company_id,
          first_name: c.first_name,
          last_name: c.last_name,
          email: c.email,
        }))}
        onSave={createDealAction}
      />
    </div>
  );
}
