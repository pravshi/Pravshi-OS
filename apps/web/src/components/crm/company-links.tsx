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
import { FieldLabel, CompanyPicker } from './pickers';
import {
  isErrorEnvelope,
  COMPANY_LINK_TYPES,
  type CompanyLink,
  type CompanyLinkType,
} from './types';
import { shortOwnerId } from './format';
import type { CrmUiPermissions } from '../../app/(app)/crm/_permissions';
import { createCompanyLinkAction, removeCompanyLinkAction } from '../../app/(app)/crm/actions';

const LINK_TYPE_LABELS: Record<CompanyLinkType, string> = {
  PARENT: 'Parent of',
  SUBSIDIARY: 'Subsidiary of',
  PARTNER: 'Partner of',
};

/** Company↔company link manager for the company relationships page. */
export function CompanyLinks({
  companyId,
  links,
  companies,
  perms,
}: {
  companyId: string;
  links: CompanyLink[];
  companies: { id: string; name: string }[];
  perms: CrmUiPermissions;
}) {
  const router = useRouter();
  const [otherId, setOtherId] = useState('');
  const [linkType, setLinkType] = useState<CompanyLinkType>('PARENT');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!otherId) return;
    setPending(true);
    setError(null);
    try {
      const result = await createCompanyLinkAction({
        fromCompanyId: companyId,
        toCompanyId: otherId,
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

  async function remove(link: CompanyLink) {
    if (!window.confirm(`Remove this link to “${link.otherName}”?`)) return;
    setPending(true);
    setError(null);
    try {
      const result = await removeCompanyLinkAction(link.id);
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

  const options = companies.filter((c) => c.id !== companyId);

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">
        Linked companies <span className="text-sm text-ink-muted">({links.length})</span>
      </h2>
      {links.length === 0 ? (
        <EmptyState
          title="No linked companies"
          description="Parent, subsidiary and partner links appear here."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Relationship</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {links.map((l) => {
                  const otherIdFor = l.direction === 'outgoing' ? l.toCompanyId : l.fromCompanyId;
                  return (
                    <TableRow key={l.id}>
                      <TableCell className="font-medium">
                        <Link
                          href={`/crm/companies/${otherIdFor}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {l.otherName}
                        </Link>
                      </TableCell>
                      <TableCell className="text-ink-muted">
                        {LINK_TYPE_LABELS[l.linkType]}
                        {l.direction === 'incoming' && (
                          <span className="ml-1 text-xs">(reversed)</span>
                        )}
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
            <FieldLabel htmlFor="link-company">Company</FieldLabel>
            <CompanyPicker
              id="link-company"
              companies={options}
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
              onChange={(e) => setLinkType(e.target.value as CompanyLinkType)}
              disabled={pending}
              className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
            >
              {COMPANY_LINK_TYPES.map((t) => (
                <option key={t} value={t}>
                  This company is {LINK_TYPE_LABELS[t].toLowerCase()} the other
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={pending || !otherId}>
            {pending ? 'Linking…' : 'Link company'}
          </Button>
          {error && <p className="w-full text-xs text-red-600 dark:text-red-400">{error}</p>}
        </form>
      )}
    </section>
  );
}
