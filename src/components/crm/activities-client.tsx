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
import { ACTIVITY_TYPES, type Activity, type ActivityType, type Page } from './types';
import { ACTIVITY_TYPE_LABELS, formatDateTime, shortOwnerId } from './format';
import type { CrmUiPermissions } from '../../app/(app)/crm/_permissions';

const PAGE_SIZE = 25;

const selectClasses =
  'rounded-md border border-line bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-input/30';

/** Searchable, type-filtered, paginated activities table. Data arrives from the Server Component. */
export function ActivitiesList({
  data,
  initialQuery,
  initialType,
  page,
  perms,
}: {
  data: Page<Activity>;
  initialQuery: string;
  initialType: ActivityType | null;
  page: number;
  perms: CrmUiPermissions;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(initialQuery);
  const [type, setType] = useState<ActivityType | ''>(initialType ?? '');

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  function navigate(q: string, t: ActivityType | '', p: number) {
    const params = new URLSearchParams(searchParams.toString());
    if (q) params.set('q', q);
    else params.delete('q');
    if (t) params.set('type', t);
    else params.delete('type');
    if (p > 1) params.set('page', String(p));
    else params.delete('page');
    router.push(`/crm/activities?${params.toString()}`);
  }

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    navigate(query.trim(), type, 1);
  }

  function onTypeChange(t: ActivityType | '') {
    setType(t);
    navigate(query.trim(), t, 1);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <form onSubmit={onSearch} className="flex flex-1 items-center gap-2 sm:max-w-md">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search activities by subject…"
            aria-label="Search activities"
          />
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        <select
          value={type}
          onChange={(e) => onTypeChange(e.target.value as ActivityType | '')}
          aria-label="Filter by activity type"
          className={selectClasses}
        >
          <option value="">All types</option>
          {ACTIVITY_TYPES.map((t) => (
            <option key={t} value={t}>
              {ACTIVITY_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        {perms.canCreate && (
          <LinkButton href="/crm/activities/new" className="ml-auto">
            Log activity
          </LinkButton>
        )}
      </div>

      {data.rows.length === 0 ? (
        <EmptyState
          title={initialQuery || initialType ? 'No activities match' : 'No activities yet'}
          description={
            initialQuery || initialType
              ? 'Try a different search term or type filter.'
              : 'Log your first call, email, meeting or note.'
          }
          action={
            perms.canCreate && !initialQuery && !initialType ? (
              <LinkButton href="/crm/activities/new">Log activity</LinkButton>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Linked to</TableHead>
                  <TableHead>Occurred</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Owner</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="text-xs font-semibold uppercase tracking-wide text-foreground">
                      {ACTIVITY_TYPE_LABELS[a.type]}
                    </TableCell>
                    <TableCell className="font-medium">
                      <Link
                        href={`/crm/activities/${a.id}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {a.subject}
                      </Link>
                    </TableCell>
                    <TableCell className="text-ink-muted">
                      {a.entityType}: {a.entityName ?? a.entityId.slice(0, 8)}
                    </TableCell>
                    <TableCell className="text-ink-muted">{formatDateTime(a.occurredAt)}</TableCell>
                    <TableCell className="text-ink-muted">{formatDateTime(a.dueAt)}</TableCell>
                    <TableCell className="text-ink-muted" title={a.ownerPersonId}>
                      {shortOwnerId(a.ownerPersonId)}
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
          {data.total} {data.total === 1 ? 'activity' : 'activities'}
        </p>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => navigate(query.trim(), type, page - 1)}
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
              onClick={() => navigate(query.trim(), type, page + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
