'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { LinkButton } from '@/components/crm/link-button';
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
import { contactDisplayName, type Page, type Contact } from './types';
import { shortOwnerId } from './format';
import type { CrmUiPermissions } from '../../app/(app)/crm/_permissions';

const PAGE_SIZE = 25;

/** Searchable, paginated contacts table. */
export function ContactsList({
  data,
  initialQuery,
  page,
  perms,
  companyNames,
}: {
  data: Page<Contact>;
  initialQuery: string;
  page: number;
  perms: CrmUiPermissions;
  companyNames: Map<string, string>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(initialQuery);

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  function navigate(q: string, p: number) {
    const params = new URLSearchParams(searchParams.toString());
    if (q) params.set('q', q);
    else params.delete('q');
    if (p > 1) params.set('page', String(p));
    else params.delete('page');
    router.push(`/crm/contacts?${params.toString()}`);
  }

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    navigate(query.trim(), 1);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <form onSubmit={onSearch} className="flex flex-1 items-center gap-2 sm:max-w-md">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search contacts by name or email…"
            aria-label="Search contacts"
          />
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        {perms.canCreate && (
          <LinkButton href="/crm/contacts/new" className="ml-auto">
            New contact
          </LinkButton>
        )}
      </div>

      {data.rows.length === 0 ? (
        <EmptyState
          title={initialQuery ? 'No contacts match your search' : 'No contacts yet'}
          description={
            initialQuery ? 'Try a different search term.' : 'Add your first contact to get started.'
          }
          action={
            perms.canCreate && !initialQuery ? (
              <LinkButton href="/crm/contacts/new">New contact</LinkButton>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Owner</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/crm/contacts/${c.id}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {contactDisplayName(c)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-ink-muted">{c.email ?? '—'}</TableCell>
                    <TableCell className="text-ink-muted">
                      {c.companyId ? (
                        <Link
                          href={`/crm/companies/${c.companyId}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {companyNames.get(c.companyId) ?? '—'}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-ink-muted">{c.title ?? '—'}</TableCell>
                    <TableCell className="text-ink-muted" title={c.ownerPersonId}>
                      {shortOwnerId(c.ownerPersonId)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between text-sm text-ink-muted">
        <p>
          {data.total} {data.total === 1 ? 'contact' : 'contacts'}
        </p>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => navigate(query.trim(), page - 1)}
            >
              Previous
            </Button>
            <span>
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => navigate(query.trim(), page + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
