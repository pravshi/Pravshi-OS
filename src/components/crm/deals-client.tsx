'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { LinkButton } from '@/components/crm/link-button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from './empty-state';
import { DEAL_STAGES, type Deal, type DealStage, type Page } from './types';
import {
  DEAL_STAGE_LABELS,
  formatMoney,
  formatDate,
  shortOwnerId,
  stageBadgeClasses,
} from './format';
import type { CrmUiPermissions } from '../../app/(app)/crm/_permissions';

const PAGE_SIZE = 25;

/**
 * Deals list with stage filter tabs. Stage filtering drives the server via the
 * ?stage= search param so the list stays bookmarkable and RLS-scoped.
 */
export function DealsList({
  data,
  stage,
  page,
  perms,
  companyNames,
}: {
  data: Page<Deal>;
  stage: DealStage | null;
  page: number;
  perms: CrmUiPermissions;
  companyNames: Map<string, string>;
}) {
  const router = useRouter();
  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  function stageHref(s: DealStage | null): string {
    const params = new URLSearchParams();
    if (s) params.set('stage', s);
    const qs = params.toString();
    return qs ? `/crm/deals?${qs}` : '/crm/deals';
  }

  function pageHref(p: number): string {
    const params = new URLSearchParams();
    if (stage) params.set('stage', stage);
    if (p > 1) params.set('page', String(p));
    const qs = params.toString();
    return qs ? `/crm/deals?${qs}` : '/crm/deals';
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Deal stages">
          <TabLink href={stageHref(null)} active={stage === null} label="All stages" />
          {DEAL_STAGES.map((s) => (
            <TabLink
              key={s}
              href={stageHref(s)}
              active={stage === s}
              label={DEAL_STAGE_LABELS[s]}
            />
          ))}
        </div>
        {perms.canCreate && (
          <LinkButton href="/crm/deals/new" className="ml-auto">
            New deal
          </LinkButton>
        )}
      </div>

      {data.rows.length === 0 ? (
        <EmptyState
          title={stage ? `No deals in ${DEAL_STAGE_LABELS[stage].toLowerCase()}` : 'No deals yet'}
          description={
            stage
              ? 'Deals you move into this stage will show up here.'
              : 'Create your first deal to start tracking pipeline.'
          }
          action={
            perms.canCreate && !stage ? (
              <LinkButton href="/crm/deals/new">New deal</LinkButton>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Expected close</TableHead>
                  <TableHead>Owner</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/crm/deals/${d.id}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {d.title}
                      </Link>
                    </TableCell>
                    <TableCell className="text-ink-muted">
                      {d.company_id ? (
                        <Link
                          href={`/crm/companies/${d.company_id}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {companyNames.get(d.company_id) ?? '—'}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-right">{formatMoney(d.value, d.currency)}</TableCell>
                    <TableCell>
                      <Badge className={stageBadgeClasses(d.stage)}>
                        {DEAL_STAGE_LABELS[d.stage]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-ink-muted">
                      {formatDate(d.expected_close_date)}
                    </TableCell>
                    <TableCell className="text-ink-muted" title={d.owner_person_id}>
                      {shortOwnerId(d.owner_person_id)}
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
          {data.total} {data.total === 1 ? 'deal' : 'deals'}
        </p>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => router.push(pageHref(page - 1))}
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
              onClick={() => router.push(pageHref(page + 1))}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function TabLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-ink-muted hover:bg-muted/70 hover:text-foreground'
      }`}
    >
      {label}
    </Link>
  );
}
