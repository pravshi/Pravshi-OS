'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { DetailField, DetailLink } from '@/components/crm/detail-fields';
import { DEAL_STAGE_LABELS, formatMoney, stageBadgeClasses } from '@/components/crm/format';
import type { Deal } from '@/lib/crm/schema';
import type { DealLinkSummary } from '@/lib/work/schema';
import type { DealStage } from '@/lib/crm/schema';

type DealSearchRow = Pick<Deal, 'id' | 'title' | 'value' | 'currency' | 'stage'>;

/**
 * LinkedDealSection — the "Linked deal" block for the project detail page.
 *
 * Shows the linked deal (title, value, stage) with unlink, or an inline deal
 * search with link actions when nothing is linked. Calls the REST routes
 * directly (fetch with same-origin credentials): POST / DELETE
 * /api/work/projects/[id]/link-deal and GET /api/crm/deals?search=…
 *
 * INTEGRATION POINT — render this in the project detail page where the
 * project is loaded, e.g. /work/projects/[id]:
 *   <LinkedDealSection projectId={project.id} initialDeal={…} canEdit={canEditProject} />
 * where initialDeal comes from GET /api/work/projects/{id} (the Project wire
 * type carries dealId) — or leave it null and pass nothing; the section
 * fetches the current link on mount when initialDeal is undefined.
 */
export function LinkedDealSection({
  projectId,
  initialDeal = null,
  canEdit,
}: {
  projectId: string;
  initialDeal?: DealLinkSummary | null;
  canEdit: boolean;
}) {
  const [deal, setDeal] = useState<DealLinkSummary | null>(initialDeal);
  const [linking, setLinking] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DealSearchRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function readError(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      return body.message ?? body.error ?? `request failed (${res.status})`;
    } catch {
      return `request failed (${res.status})`;
    }
  }

  async function searchDeals(q: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/crm/deals?search=${encodeURIComponent(q)}&limit=10`, {
        credentials: 'same-origin',
        headers: { 'Cache-Control': 'no-store' },
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as { rows: DealSearchRow[] };
      setResults(body.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed.');
    } finally {
      setBusy(false);
    }
  }

  async function linkDeal(dealId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/work/projects/${projectId}/link-deal`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealId }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as { deal: DealLinkSummary };
      setDeal(body.deal);
      setLinking(false);
      setQuery('');
      setResults([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Link failed.');
    } finally {
      setBusy(false);
    }
  }

  async function unlinkDeal() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/work/projects/${projectId}/link-deal`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(await readError(res));
      setDeal(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unlink failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Linked deal</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {deal ? (
          <>
            <dl className="divide-y divide-line">
              <DetailField label="Deal">
                <DetailLink href={`/crm/deals/${deal.id}`}>{deal.title}</DetailLink>
              </DetailField>
              <DetailField label="Value">{formatMoney(deal.value, deal.currency)}</DetailField>
              <DetailField label="Stage">
                <Badge className={stageBadgeClasses(deal.stage as DealStage)}>
                  {DEAL_STAGE_LABELS[deal.stage as DealStage]}
                </Badge>
              </DetailField>
            </dl>
            {canEdit && (
              <Button variant="outline" size="sm" onClick={unlinkDeal} disabled={busy}>
                {busy ? 'Working…' : 'Unlink deal'}
              </Button>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-ink-muted">No deal is linked to this project.</p>
            {canEdit &&
              (linking ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search deals by title…"
                      aria-label="Search deals"
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => searchDeals(query)}
                      disabled={busy}
                    >
                      Search
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setLinking(false)}>
                      Cancel
                    </Button>
                  </div>
                  {results.length > 0 && (
                    <ul className="divide-y divide-line rounded-lg border border-line">
                      {results.map((r) => (
                        <li
                          key={r.id}
                          className="flex items-center justify-between gap-3 px-3 py-2"
                        >
                          <div className="min-w-0">
                            <Link
                              href={`/crm/deals/${r.id}`}
                              className="truncate text-sm font-medium hover:underline"
                            >
                              {r.title}
                            </Link>
                            <p className="text-xs text-ink-muted">
                              {formatMoney(r.value, r.currency)} ·{' '}
                              {DEAL_STAGE_LABELS[r.stage as DealStage]}
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => linkDeal(r.id)}
                            disabled={busy}
                          >
                            Link
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {query && !busy && results.length === 0 && (
                    <p className="text-sm text-ink-muted">No deals match.</p>
                  )}
                </div>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => setLinking(true)}>
                  Link a deal
                </Button>
              ))}
          </>
        )}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </CardContent>
    </Card>
  );
}
