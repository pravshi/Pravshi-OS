'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/crm/empty-state';
import { formatDate } from '@/components/crm/format';
import type { CrmUiPermissions } from '../../_permissions';
import type { Page, PipelineListRow } from '@/components/crm/types';
import { PipelineDialog } from './PipelineForm';

const PAGE_SIZE = 25;

/** Pipeline list: search, create dialog, cards linking to each board. */
export function PipelinesList({
  data,
  search,
  page,
  perms,
}: {
  data: Page<PipelineListRow>;
  search: string;
  page: number;
  perms: CrmUiPermissions;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  function href(p: number, s: string): string {
    const params = new URLSearchParams();
    if (s) params.set('search', s);
    if (p > 1) params.set('page', String(p));
    const qs = params.toString();
    return qs ? `/crm/pipelines?${qs}` : '/crm/pipelines';
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <form action="/crm/pipelines" method="get" className="flex gap-2">
          <Input
            name="search"
            defaultValue={search}
            placeholder="Search pipelines…"
            maxLength={128}
            className="w-56"
          />
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        {perms.canCreate && (
          <Button className="ml-auto" onClick={() => setDialogOpen(true)}>
            New pipeline
          </Button>
        )}
      </div>

      {data.rows.length === 0 ? (
        <EmptyState
          title={search ? 'No pipelines match your search' : 'No pipelines yet'}
          description={
            search
              ? 'Try a different search term.'
              : 'Create a pipeline to start tracking deals on a kanban board.'
          }
          action={
            perms.canCreate && !search ? (
              <Button onClick={() => setDialogOpen(true)}>New pipeline</Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.rows.map((p) => (
            <Link key={p.id} href={`/crm/pipelines/${p.id}`} className="block">
              <Card className="h-full transition-colors hover:border-brand">
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-base font-semibold">{p.name}</h2>
                    {p.isDefault && <Badge>Default</Badge>}
                  </div>
                  {p.description && (
                    <p className="line-clamp-2 text-sm text-ink-muted">{p.description}</p>
                  )}
                  <p className="text-xs text-ink-muted">
                    {p.stageCount} {p.stageCount === 1 ? 'stage' : 'stages'} · updated{' '}
                    {formatDate(p.updatedAt)}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <nav className="flex items-center gap-2 text-sm" aria-label="Pagination">
          {page > 1 && (
            <Link href={href(page - 1, search)} className="text-ink-muted hover:text-foreground">
              ← Previous
            </Link>
          )}
          <span className="text-ink-muted">
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <Link href={href(page + 1, search)} className="text-ink-muted hover:text-foreground">
              Next →
            </Link>
          )}
        </nav>
      )}

      <PipelineDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
