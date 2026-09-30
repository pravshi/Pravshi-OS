'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from './empty-state';
import { FieldLabel, ContactPicker } from './pickers';
import {
  isErrorEnvelope,
  CONTACT_LINK_TYPES,
  type ContactLink,
  type ContactLinkType,
} from './types';
import { shortOwnerId } from './format';
import type { CrmUiPermissions } from '../../app/(app)/crm/_permissions';
import { createContactLinkAction, removeContactLinkAction } from '../../app/(app)/crm/actions';

const LINK_TYPE_LABELS: Record<ContactLinkType, string> = {
  COLLEAGUE: 'Colleague',
  REFERRAL: 'Referred by',
  OTHER: 'Linked with',
};

type PickerContact = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  companyId: string | null;
};

/** Contact↔contact link manager for the contact relationships page. */
export function ContactLinks({
  contactId,
  links,
  contacts,
  perms,
}: {
  contactId: string;
  links: ContactLink[];
  contacts: PickerContact[];
  perms: CrmUiPermissions;
}) {
  const router = useRouter();
  const [otherId, setOtherId] = useState('');
  const [linkType, setLinkType] = useState<ContactLinkType>('COLLEAGUE');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!otherId) return;
    setPending(true);
    setError(null);
    try {
      const result = await createContactLinkAction({
        fromContactId: contactId,
        toContactId: otherId,
        linkType,
      });
      if (isErrorEnvelope(result)) {
        setError(result.error.message);
      } else {
        setOtherId('');
        router.refresh();
      }
    } catch {
      setError('Linking failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  async function remove(link: ContactLink) {
    if (!window.confirm(`Remove this link to “${link.otherName}”?`)) return;
    setPending(true);
    setError(null);
    try {
      const result = await removeContactLinkAction(link.id);
      if (isErrorEnvelope(result)) {
        setError(result.error.message);
      } else {
        router.refresh();
      }
    } catch {
      setError('The removal failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  const options = contacts.filter((c) => c.id !== contactId);

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">
        Linked contacts <span className="text-sm text-ink-muted">({links.length})</span>
      </h2>
      {links.length === 0 ? (
        <EmptyState
          title="No linked contacts"
          description="Colleague, referral and other links appear here."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead>Relationship</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {links.map((l) => {
                  const otherIdFor = l.direction === 'outgoing' ? l.toContactId : l.fromContactId;
                  return (
                    <TableRow key={l.id}>
                      <TableCell className="font-medium">
                        <Link
                          href={`/crm/contacts/${otherIdFor}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {l.otherName}
                        </Link>
                      </TableCell>
                      <TableCell className="text-ink-muted">
                        {LINK_TYPE_LABELS[l.linkType]}
                      </TableCell>
                      <TableCell className="text-ink-muted">
                        {shortOwnerId(l.ownerPersonId)}
                      </TableCell>
                      <TableCell className="text-right">
                        {perms.canDelete && (
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => remove(l)}
                            disabled={pending}
                          >
                            Remove
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      {perms.canCreate && (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="min-w-60 flex-1">
            <FieldLabel htmlFor="link-contact">Contact</FieldLabel>
            <ContactPicker
              id="link-contact"
              contacts={options}
              value={otherId}
              onChange={setOtherId}
              disabled={pending}
            />
          </div>
          <div className="min-w-45 flex-1">
            <FieldLabel htmlFor="link-type">Relationship</FieldLabel>
            <select
              id="link-type"
              value={linkType}
              onChange={(e) => setLinkType(e.target.value as ContactLinkType)}
              disabled={pending}
              className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
            >
              {CONTACT_LINK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {LINK_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={pending || !otherId}>
            {pending ? 'Linking…' : 'Link contact'}
          </Button>
          {error && <p className="w-full text-xs text-red-600 dark:text-red-400">{error}</p>}
        </form>
      )}
    </section>
  );
}
