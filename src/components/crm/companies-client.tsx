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
import { type Page, type Company } from './types';
import { shortOwnerId } from './format';
import type { CrmUiPermissions } from '../../app/(app)/crm/_permissions';

const PAGE_SIZE = 25;

/** Searchable, paginated companies table. Data arrives from the Server Component. */
export function CompaniesList({
  data,
  initialQuery,
  page,
  perms,
}: {
  data: Page<Company>;
  initialQuery: string;
  page: number;
  perms: CrmUiPermissions;
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
    router.push(`/crm/companies?${params.toString()}`);
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
            placeholder="Search companies by name…"
            aria-label="Search companies"
          />
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        {perms.canCreate && (
          <LinkButton href="/crm/companies/new" className="ml-auto">
            New company
          </LinkButton>
        )}
      </div>

      {data.rows.length === 0 ? (
        <EmptyState
          title={initialQuery ? 'No companies match your search' : 'No companies yet'}
          description={
            initialQuery
              ? 'Try a different search term.'
              : 'Add your first company to start building the CRM.'
          }
          action={
            perms.canCreate && !initialQuery ? (
              <LinkButton href="/crm/companies/new">New company</LinkButton>
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
                  <TableHead>Domain</TableHead>
                  <TableHead>Industry</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Owner</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/crm/companies/${c.id}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-ink-muted">{c.domain ?? '—'}</TableCell>
                    <TableCell className="text-ink-muted">{c.industry ?? '—'}</TableCell>
                    <TableCell className="text-ink-muted">
                      {c.size ? c.size.replace('_', ' ') : '—'}
                    </TableCell>
                    <TableCell className="text-ink-muted" title={c.owner_person_id}>
                      {shortOwnerId(c.owner_person_id)}
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
          {data.total} {data.total === 1 ? 'company' : 'companies'}
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
