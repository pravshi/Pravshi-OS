import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorMessage } from '@/components/crm/error-message';
import { EmptyState } from '@/components/crm/empty-state';
import { DetailField, DetailLink } from '@/components/crm/detail-fields';
import { EditableSection } from '@/components/crm/editable-section';
import { DeleteDialog } from '@/components/crm/delete-dialog';
import { CompanyForm } from '@/components/crm/company-form';
import {
  isErrorEnvelope,
  contactDisplayName,
  type Contact,
  type Deal,
} from '@/components/crm/types';
import { formatMoney, DEAL_STAGE_LABELS, formatDateTime } from '@/components/crm/format';
import {
  getCompanyAction,
  listContactsAction,
  listDealsAction,
  updateCompanyAction,
  deleteCompanyAction,
} from '../../actions';
import { getCrmPermissions, requireCrmPagePermission, uiPermissionsFor } from '../../_permissions';

/**
 * /crm/companies/[id] — company detail with edit form, soft delete, and the
 * linked contacts and deals.
 */
export default async function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCrmPagePermission('companies', 'view');
  const { id } = await params;

  const [companyRes, contactsRes, dealsRes, held] = await Promise.all([
    getCompanyAction(id),
    listContactsAction({ companyId: id, limit: 100 }),
    listDealsAction({ companyId: id, limit: 100 }),
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

  const company = companyRes;
  const perms = uiPermissionsFor(held, 'companies');
  // Related records are filtered server-side (companyId); the API enforces the
  // caller's permissions on each list call independently.
  const contacts = isErrorEnvelope(contactsRes) ? [] : contactsRes.rows;
  const deals = isErrorEnvelope(dealsRes) ? [] : dealsRes.rows;

  const address = [
    company.addressLine1,
    company.addressLine2,
    company.addressCity,
    company.addressState,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <BackLink />
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{company.name}</h1>
          <p className="mt-1 text-sm text-ink-muted">{company.domain ?? 'Company detail'}</p>
        </div>
        {perms.canDelete && (
          <DeleteDialog
            resourceName="company"
            recordName={company.name}
            onDelete={() => deleteCompanyAction(company.id)}
            redirectTo="/crm/companies"
          />
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y divide-line">
            <DetailField label="Name">{company.name}</DetailField>
            <DetailField label="Domain">{company.domain ?? '—'}</DetailField>
            <DetailField label="Industry">{company.industry ?? '—'}</DetailField>
            <DetailField label="Size">
              {company.size ? company.size.replace('_', ' ') : '—'}
            </DetailField>
            <DetailField label="Website">
              {company.website ? (
                <DetailLink href={company.website}>{company.website}</DetailLink>
              ) : (
                '—'
              )}
            </DetailField>
            <DetailField label="Phone">{company.phone ?? '—'}</DetailField>
            <DetailField label="Address">
              {address === '' ? '—' : address}
              {company.addressPostalCode ? ` — ${company.addressPostalCode}` : ''}
            </DetailField>
            <DetailField label="Country">{company.countryCode}</DetailField>
            <DetailField label="Created">{formatDateTime(company.createdAt)}</DetailField>
            <DetailField label="Updated">{formatDateTime(company.updatedAt)}</DetailField>
          </dl>
        </CardContent>
      </Card>

      {perms.canEdit && (
        <EditableSection buttonLabel="Edit company">
          <CompanyForm
            initial={company}
            onSave={(input) => updateCompanyAction(company.id, input)}
          />
        </EditableSection>
      )}

      <RelatedContacts contacts={contacts} />
      <RelatedDeals deals={deals} />
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/crm/companies" className="text-sm text-ink-muted hover:text-foreground">
      ← All companies
    </Link>
  );
}

function RelatedContacts({ contacts }: { contacts: Contact[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">
        Contacts <span className="text-sm text-ink-muted">({contacts.length})</span>
      </h2>
      {contacts.length === 0 ? (
        <EmptyState
          title="No contacts linked"
          description="Contacts linked to this company appear here."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-line">
              {contacts.map((c) => (
                <li key={c.id} className="px-4 py-3 text-sm">
                  <DetailLink href={`/crm/contacts/${c.id}`}>{contactDisplayName(c)}</DetailLink>
                  <span className="ml-2 text-ink-muted">
                    {[c.title, c.email].filter(Boolean).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function RelatedDeals({ deals }: { deals: Deal[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">
        Deals <span className="text-sm text-ink-muted">({deals.length})</span>
      </h2>
      {deals.length === 0 ? (
        <EmptyState title="No deals linked" description="Deals for this company appear here." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-line">
              {deals.map((d) => (
                <li key={d.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <div>
                    <DetailLink href={`/crm/deals/${d.id}`}>{d.title}</DetailLink>
                    <span className="ml-2 text-ink-muted">{DEAL_STAGE_LABELS[d.stage]}</span>
                  </div>
                  <span className="font-medium">{formatMoney(d.value, d.currency)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
