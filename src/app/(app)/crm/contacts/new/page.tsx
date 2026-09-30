import { ErrorMessage } from '@/components/crm/error-message';
import { ContactForm } from '@/components/crm/contact-form';
import { isErrorEnvelope } from '@/components/crm/types';
import { createContactAction, listCompaniesAction } from '../../actions';
import { requireCrmPagePermission } from '../../_permissions';

/** /crm/contacts/new — create a contact, optionally linked to a company. */
export default async function NewContactPage() {
  await requireCrmPagePermission('contacts', 'create');

  const companiesRes = await listCompaniesAction({ limit: 100 });
  if (isErrorEnvelope(companiesRes)) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">New contact</h1>
        <ErrorMessage error={companiesRes} title="Could not load companies" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New contact</h1>
        <p className="mt-1 text-sm text-ink-muted">
          You become the owner of every contact you create.
        </p>
      </div>
      <ContactForm
        companies={companiesRes.rows.map((c) => ({ id: c.id, name: c.name }))}
        onSave={createContactAction}
      />
    </div>
  );
}
