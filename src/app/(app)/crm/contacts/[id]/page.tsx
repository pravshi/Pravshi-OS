import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorMessage } from '@/components/crm/error-message';
import { EmptyState } from '@/components/crm/empty-state';
import { DetailField, DetailLink } from '@/components/crm/detail-fields';
import { EditableSection } from '@/components/crm/editable-section';
import { DeleteDialog } from '@/components/crm/delete-dialog';
import { ContactForm } from '@/components/crm/contact-form';
import { ActivityTimeline } from '@/components/crm/activity-timeline';
import { isErrorEnvelope, contactDisplayName, type Deal } from '@/components/crm/types';
import { formatMoney, DEAL_STAGE_LABELS, formatDateTime } from '@/components/crm/format';
import {
  getContactAction,
  getCompanyAction,
  listCompaniesAction,
  listDealsAction,
  updateContactAction,
  deleteContactAction,
} from '../../actions';
import { getCrmPermissions, requireCrmPagePermission, uiPermissionsFor } from '../../_permissions';

/** /crm/contacts/[id] — contact detail with edit, company link, related deals. */
export default async function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCrmPagePermission('contacts', 'view');
  const { id } = await params;

  const [contactRes, companiesRes, dealsRes, held] = await Promise.all([
    getContactAction(id),
    listCompaniesAction({ limit: 100 }),
    listDealsAction({ contactId: id, limit: 100 }),
    getCrmPermissions(),
  ]);

  if (isErrorEnvelope(contactRes)) {
    return (
      <div className="space-y-6">
        <BackLink />
        <ErrorMessage error={contactRes} title="Could not load contact" />
      </div>
    );
  }

  const contact = contactRes;
  const perms = uiPermissionsFor(held, 'contacts');
  // The timeline's create form gates on activities.create independently of the
  // contact permissions.
  const activityPerms = uiPermissionsFor(held, 'activities');

  const companyNames = new Map<string, string>();
  if (!isErrorEnvelope(companiesRes)) {
    for (const c of companiesRes.rows) companyNames.set(c.id, c.name);
  }

  let companyName: string | null = contact.companyName;
  if (contact.companyId) {
    companyName = companyNames.get(contact.companyId) ?? contact.companyName;
    if (companyName === null) {
      // Fall back to a direct fetch in case the company sits outside the first 100.
      const companyRes = await getCompanyAction(contact.companyId);
      if (!isErrorEnvelope(companyRes)) companyName = companyRes.name;
    }
  }

  const deals = isErrorEnvelope(dealsRes) ? [] : dealsRes.rows;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <BackLink />
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {contactDisplayName(contact)}
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            {[contact.title, companyName].filter(Boolean).join(' · ') || 'Contact detail'}
          </p>
        </div>
        {perms.canDelete && (
          <DeleteDialog
            resourceName="contact"
            recordName={contactDisplayName(contact)}
            onDelete={() => deleteContactAction(contact.id)}
            redirectTo="/crm/contacts"
          />
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y divide-line">
            <DetailField label="First name">{contact.firstName}</DetailField>
            <DetailField label="Last name">{contact.lastName ?? '—'}</DetailField>
            <DetailField label="Email">
              {contact.email ? (
                <DetailLink href={`mailto:${contact.email}`}>{contact.email}</DetailLink>
              ) : (
                '—'
              )}
            </DetailField>
            <DetailField label="Phone">{contact.phone ?? '—'}</DetailField>
            <DetailField label="Title">{contact.title ?? '—'}</DetailField>
            <DetailField label="Department">{contact.department ?? '—'}</DetailField>
            <DetailField label="Company">
              {contact.companyId ? (
                <DetailLink href={`/crm/companies/${contact.companyId}`}>
                  {companyName ?? 'View company'}
                </DetailLink>
              ) : (
                '—'
              )}
            </DetailField>
            <DetailField label="Created">{formatDateTime(contact.createdAt)}</DetailField>
            <DetailField label="Updated">{formatDateTime(contact.updatedAt)}</DetailField>
          </dl>
        </CardContent>
      </Card>

      {perms.canEdit && (
        <EditableSection buttonLabel="Edit contact">
          <ContactForm
            initial={contact}
            companies={
              isErrorEnvelope(companiesRes)
                ? []
                : companiesRes.rows.map((c) => ({ id: c.id, name: c.name }))
            }
            onSave={(input) => updateContactAction(contact.id, input)}
          />
        </EditableSection>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">
          Related deals <span className="text-sm text-ink-muted">({deals.length})</span>
        </h2>
        {deals.length === 0 ? (
          <EmptyState
            title="No deals linked"
            description="Deals naming this contact appear here."
          />
        ) : (
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y divide-line">
                {deals.map((d: Deal) => (
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

      <ActivityTimeline
        entityType="contact"
        entityId={id}
        entityName={contactDisplayName(contact)}
        canCreate={activityPerms.canCreate}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/crm/contacts" className="text-sm text-ink-muted hover:text-foreground">
      ← All contacts
    </Link>
  );
}
