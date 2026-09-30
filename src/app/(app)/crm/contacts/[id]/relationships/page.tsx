import Link from 'next/link';
import { ErrorMessage } from '@/components/crm/error-message';
import { ContactAssociations } from '@/components/crm/company-contacts';
import { ContactLinks } from '@/components/crm/contact-links';
import { isErrorEnvelope, contactDisplayName, type Contact } from '@/components/crm/types';
import {
  getContactAction,
  listContactsAction,
  listContactAssociationsAction,
  listContactLinksAction,
} from '../../../actions';
import {
  getCrmPermissions,
  requireCrmPagePermission,
  uiPermissionsFor,
} from '../../../_permissions';

/**
 * /crm/contacts/[id]/relationships — the contextual relationship sub-page for a
 * contact: company associations (roles, primary) and contact↔contact links.
 * Deliberately NOT a sidebar entry; reached from the contact detail page.
 */
export default async function ContactRelationshipsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireCrmPagePermission('relationships', 'view');
  const { id } = await params;

  const [contactRes, associationsRes, linksRes, allContactsRes, held] = await Promise.all([
    getContactAction(id),
    listContactAssociationsAction(id, { limit: 100 }),
    listContactLinksAction(id, { limit: 100 }),
    listContactsAction({ limit: 100 }),
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

  const contact: Contact = contactRes;
  const perms = uiPermissionsFor(held, 'relationships');
  const associations = isErrorEnvelope(associationsRes) ? [] : associationsRes.rows;
  const links = isErrorEnvelope(linksRes) ? [] : linksRes.rows;
  // Picker options are fetched server-side; the actions enforce RLS per call.
  const allContacts: Contact[] = isErrorEnvelope(allContactsRes) ? [] : allContactsRes.rows;

  return (
    <div className="space-y-8">
      <div>
        <BackLink contactId={contact.id} />
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Relationships</h1>
        <p className="mt-1 text-sm text-ink-muted">{contactDisplayName(contact)}</p>
      </div>

      <ContactAssociations rows={associations} perms={perms} />
      <ContactLinks contactId={contact.id} links={links} contacts={allContacts} perms={perms} />
    </div>
  );
}

function BackLink({ contactId }: { contactId?: string }) {
  return (
    <Link
      href={contactId ? `/crm/contacts/${contactId}` : '/crm/contacts'}
      className="text-sm text-ink-muted hover:text-foreground"
    >
      ← Back to contact
    </Link>
  );
}
