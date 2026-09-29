import { CompanyForm } from '@/components/crm/company-form';
import { createCompanyAction } from '../../_api';
import { requireCrmPagePermission } from '../../_permissions';

/** /crm/companies/new — create a company. companies.create to use. */
export default async function NewCompanyPage() {
  await requireCrmPagePermission('companies', 'create');

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New company</h1>
        <p className="mt-1 text-sm text-ink-muted">
          You become the owner of every company you create.
        </p>
      </div>
      <CompanyForm onSave={createCompanyAction} />
    </div>
  );
}
