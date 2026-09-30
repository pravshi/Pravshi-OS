import Link from 'next/link';
import { ErrorMessage } from '@/components/crm/error-message';
import { CompanyContacts } from '@/components/crm/company-contacts';
import { CompanyLinks } from '@/components/crm/company-links';
import { isErrorEnvelope, type Company, type Contact } from '@/components/crm/types';
import {
  getCompanyAction,
  listCompaniesAction,
  listContactsAction,
  listCompanyContactsAction,
  listCompanyLinksAction,
} from '../../../actions';
import {
  getCrmPermissions,
  requireCrmPagePermission,
  uiPermissionsFor,
} from '../../../_permissions';

/**
 * /crm/companies/[id]/relationships — the contextual relationship sub-page for a
 * company: contact associations (roles, primary) and company↔company links.
 * Deliberately NOT a sidebar entry; reached from the company detail page.
 */
export default async function CompanyRelationshipsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireCrmPagePermission('relationships', 'view');
  const { id } = await params;

  const [companyRes, contactsRes, linksRes, allContactsRes, allCompaniesRes, held] =
    await Promise.all([
      getCompanyAction(id),
      listCompanyContactsAction(id, { limit: 100 }),
      listCompanyLinksAction(id, { limit: 100 }),
      listContactsAction({ limit: 100 }),
      listCompaniesAction({ limit: 100 }),
      getCrmPermissions(),
    ]);

  if (isErrorEnvelope(companyRes)) {
    return (
      <div className="space-y-6">
        <BackLink />
        <ErrorMessage error={companyRes} title="Could not load company" />
      </div>
    );
  }

  const company: Company = companyRes;
  const perms = uiPermissionsFor(held, 'relationships');
  const contacts = isErrorEnvelope(contactsRes) ? [] : contactsRes.rows;
  const links = isErrorEnvelope(linksRes) ? [] : linksRes.rows;
  // Picker options are fetched server-side; the actions enforce RLS per call.
  const allContacts: Contact[] = isErrorEnvelope(allContactsRes) ? [] : allContactsRes.rows;
  const allCompanies: Company[] = isErrorEnvelope(allCompaniesRes) ? [] : allCompaniesRes.rows;

  return (
    <div className="space-y-8">
      <div>
        <BackLink companyId={company.id} />
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Relationships</h1>
        <p className="mt-1 text-sm text-ink-muted">{company.name}</p>
      </div>

      <CompanyContacts
        companyId={company.id}
        rows={contacts}
        contacts={allContacts}
        perms={perms}
      />
      <CompanyLinks companyId={company.id} links={links} companies={allCompanies} perms={perms} />
    </div>
  );
}

function BackLink({ companyId }: { companyId?: string }) {
  return (
    <Link
      href={companyId ? `/crm/companies/${companyId}` : '/crm/companies'}
      className="text-sm text-ink-muted hover:text-foreground"
    >
      ← Back to company
    </Link>
  );
}
