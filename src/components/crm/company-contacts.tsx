'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { isErrorEnvelope, type CompanyContact, type CrmResult } from './types';
import { shortOwnerId } from './format';
import type { CrmUiPermissions } from '../../app/(app)/crm/_permissions';
import {
  createCompanyContactAction,
  updateCompanyContactAction,
  removeCompanyContactAction,
} from '../../app/(app)/crm/actions';

/**
 * Contact↔company association managers. The company page lists the company's
 * contacts; the contact page lists the contact's companies. Both share the
 * same server actions (the (companyId, contactId) pair identifies the row).
 */

type PickerContact = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  companyId: string | null;
};

function PrimaryBadge() {
  return (
    <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
      Primary
    </span>
  );
}

function AssociationRow({
  row,
  editable,
  removable,
}: {
  row: CompanyContact;
  editable: boolean;
  removable: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [role, setRole] = useState(row.role ?? '');
  const [isPrimary, setIsPrimary] = useState(row.isPrimary);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setPending(true);
    setError(null);
    try {
      const result = await updateCompanyContactAction(row.companyId, row.contactId, {
        role,
        isPrimary,
      });
      if (isErrorEnvelope(result)) {
        setError(result.error.message);
      } else {
        setEditing(false);
        router.refresh();
      }
    } catch {
      setError('The update failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove this association? It can be re-linked later.`)) return;
    setPending(true);
    setError(null);
    try {
      const result = await removeCompanyContactAction(row.companyId, row.contactId);
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

  return (
    <TableRow>
      <TableCell className="font-medium">
        {row.contactName ? (
          <Link
            href={`/crm/contacts/${row.contactId}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {row.contactName}
          </Link>
        ) : (
          <Link
            href={`/crm/companies/${row.companyId}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            {row.companyName ?? row.companyId}
          </Link>
        )}
      </TableCell>
      <TableCell>
        {editing ? (
          <Input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Role, e.g. Decision Maker"
            maxLength={128}
            className="max-w-55"
          />
        ) : (
          <span className="text-ink-muted">{row.role ?? '—'}</span>
        )}
      </TableCell>
      <TableCell>
        {editing ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Primary
          </label>
        ) : row.isPrimary ? (
          <PrimaryBadge />
        ) : (
          '—'
        )}
      </TableCell>
      <TableCell className="text-ink-muted">{shortOwnerId(row.ownerPersonId)}</TableCell>
      <TableCell className="text-right">
        {editing ? (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            {editable && (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            {removable && (
              <Button size="sm" variant="destructive" onClick={remove} disabled={pending}>
                Remove
              </Button>
            )}
          </div>
        )}
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </TableCell>
    </TableRow>
  );
}

function AssociationTable({
  rows,
  perms,
  emptyTitle,
  emptyDescription,
}: {
  rows: CompanyContact[];
  perms: CrmUiPermissions;
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Record</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Primary</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <AssociationRow
                key={r.id}
                row={r}
                editable={perms.canEdit}
                removable={perms.canDelete}
              />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function AddAssociationForm({
  companyId,
  contacts,
}: {
  companyId: string;
  contacts: PickerContact[];
}) {
  const router = useRouter();
  const [contactId, setContactId] = useState('');
  const [role, setRole] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!contactId) return;
    setPending(true);
    setError(null);
    try {
      const result: CrmResult<CompanyContact> = await createCompanyContactAction({
        companyId,
        contactId,
        role: role.trim() === '' ? null : role,
        isPrimary,
      });
      if (isErrorEnvelope(result)) {
        setError(result.error.message);
      } else {
        setContactId('');
        setRole('');
        setIsPrimary(false);
        router.refresh();
      }
    } catch {
      setError('Linking failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <div className="min-w-60 flex-1">
        <FieldLabel htmlFor="assoc-contact">Contact</FieldLabel>
        <ContactPicker
          id="assoc-contact"
          contacts={contacts}
          value={contactId}
          onChange={setContactId}
          disabled={pending}
        />
      </div>
      <div className="min-w-45 flex-1">
        <FieldLabel htmlFor="assoc-role">Role</FieldLabel>
        <Input
          id="assoc-role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="e.g. Decision Maker"
          maxLength={128}
          disabled={pending}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isPrimary}
          onChange={(e) => setIsPrimary(e.target.checked)}
          disabled={pending}
          className="h-4 w-4 accent-primary"
        />
        Primary
      </label>
      <Button type="submit" disabled={pending || !contactId}>
        {pending ? 'Linking…' : 'Link contact'}
      </Button>
      {error && <p className="w-full text-xs text-destructive">{error}</p>}
    </form>
  );
}

/** Company detail side: the contacts linked to this company, plus the add form. */
export function CompanyContacts({
  companyId,
  rows,
  contacts,
  perms,
}: {
  companyId: string;
  rows: CompanyContact[];
  contacts: PickerContact[];
  perms: CrmUiPermissions;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">
        Contacts <span className="text-sm text-ink-muted">({rows.length})</span>
      </h2>
      <AssociationTable
        rows={rows}
        perms={perms}
        emptyTitle="No contacts linked"
        emptyDescription="Contacts linked to this company appear here."
      />
      {perms.canCreate && <AddAssociationForm companyId={companyId} contacts={contacts} />}
    </section>
  );
}

/** Contact detail side: the companies this contact is associated with. */
export function ContactAssociations({
  rows,
  perms,
}: {
  rows: CompanyContact[];
  perms: CrmUiPermissions;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">
        Companies <span className="text-sm text-ink-muted">({rows.length})</span>
      </h2>
      <AssociationTable
        rows={rows}
        perms={perms}
        emptyTitle="No companies linked"
        emptyDescription="Companies this contact is associated with appear here."
      />
    </section>
  );
}
