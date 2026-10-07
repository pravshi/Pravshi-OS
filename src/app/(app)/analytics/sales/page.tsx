import { Suspense } from 'react';
import { requirePagePermission } from '@/lib/authz/page';
import { PageHeader } from '@/components/shell/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/crm/empty-state';
import { ErrorMessage } from '@/components/crm/error-message';
import type { AuthContext } from '@/lib/db/context';
import {
  getDealsByStage,
  getPipelineValue,
  getWonRevenue,
  getWinRate,
  getAvgDealValue,
  getDealsByOwner,
} from '@/lib/analytics/sales';
import { getLeadCounts, getLeadConversionRate } from '@/lib/analytics/crm';
import { DateRangePicker } from '../_components/DateRangePicker';
import { StatCard, SectionSkeleton } from '../_components/StatCard';
import { ChartCard, HBarChart, colorAt } from '../_components/charts';
import {
  formatInt,
  formatMoneySummary,
  formatPercent,
  parseDashboardFilter,
  type DashboardFilter,
} from '../_components/lib';

/** /analytics/sales — pipeline, revenue, win rate, owners. */
export default async function SalesDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await requirePagePermission('reports.view');

  let filter: DashboardFilter;
  let rangeLabel: string;
  try {
    ({ filter, rangeLabel } = parseDashboardFilter(auth.ctx, await searchParams));
  } catch {
    return (
      <div className="space-y-6">
        <PageHeader title="Sales dashboard" actions={<DateRangePicker />} />
        <ErrorMessage
          error={{
            error: { code: 'INTERNAL', message: 'The selected date range is invalid.' },
          }}
          title="Invalid date range"
        />
      </div>
    );
  }

  const ctx = auth.ctx;
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Sales dashboard"
        description={`Pipeline and revenue · ${rangeLabel}`}
        actions={<DateRangePicker />}
      />

      <Suspense fallback={<SectionSkeleton lines={2} />}>
        <SalesKpis ctx={ctx} filter={filter} />
      </Suspense>

      <div className="grid gap-4 lg:grid-cols-2">
        <Suspense fallback={<SectionSkeleton />}>
          <DealsByStageChart ctx={ctx} filter={filter} />
        </Suspense>
        <Suspense fallback={<SectionSkeleton />}>
          <DealsByOwnerCard ctx={ctx} filter={filter} />
        </Suspense>
      </div>
    </div>
  );
}

async function SalesKpis({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  let kpis: {
    pipelineValue: Awaited<ReturnType<typeof getPipelineValue>>;
    wonRevenue: Awaited<ReturnType<typeof getWonRevenue>>;
    winRate: number | null;
    avgDealValue: Awaited<ReturnType<typeof getAvgDealValue>>;
    newLeads: number;
    conversionRate: number | null;
  } | null = null;
  try {
    const [pipelineValue, wonRevenue, winRate, avgDealValue, leadCounts, conversionRate] =
      await Promise.all([
        getPipelineValue(ctx, filter),
        getWonRevenue(ctx, filter),
        getWinRate(ctx, filter),
        getAvgDealValue(ctx, filter),
        getLeadCounts(ctx.orgId, ctx, filter),
        getLeadConversionRate(ctx.orgId, ctx, filter.dateRange),
      ]);
    kpis = {
      pipelineValue,
      wonRevenue,
      winRate,
      avgDealValue,
      newLeads: leadCounts.newLeads,
      conversionRate,
    };
  } catch {
    return (
      <ErrorMessage
        error={{ error: { code: 'INTERNAL', message: 'Could not load sales metrics.' } }}
        title="Could not load sales metrics"
      />
    );
  }

  const pipeline = formatMoneySummary(kpis.pipelineValue);
  const revenue = formatMoneySummary(kpis.wonRevenue);
  const avg = formatMoneySummary(kpis.avgDealValue);

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard label="Open pipeline value" value={pipeline.value} sub={pipeline.sub} />
      <StatCard label="Revenue won" value={revenue.value} sub={revenue.sub} />
      <StatCard label="Win rate" value={formatPercent(kpis.winRate)} sub="of closed deals" />
      <StatCard label="Avg won deal" value={avg.value} sub={avg.sub} />
      <StatCard label="New leads" value={formatInt(kpis.newLeads)} />
      <StatCard label="Lead conversion" value={formatPercent(kpis.conversionRate)} />
    </div>
  );
}

async function DealsByStageChart({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  let stages: Awaited<ReturnType<typeof getDealsByStage>> = [];
  try {
    stages = await getDealsByStage(ctx, filter);
  } catch {
    return (
      <ChartCard title="Deals by stage">
        <ErrorMessage
          error={{ error: { code: 'INTERNAL', message: 'Could not load the stage funnel.' } }}
        />
      </ChartCard>
    );
  }

  const data = stages.map((s, i) => ({
    label: `${s.pipelineName} · ${s.stageName}`,
    value: s.dealCount,
    _color: s.isWon ? '#22c55e' : s.isLost ? '#ef4444' : colorAt(i),
  }));

  return (
    <ChartCard title="Deals by stage" description="Deals created in the range, grouped by stage">
      {data.length === 0 ? (
        <EmptyState
          title="No data yet"
          description="Deals appear here once the pipeline is in use."
        />
      ) : (
        <HBarChart data={data} colorFor={(_, i) => data[i]?._color ?? colorAt(i)} />
      )}
    </ChartCard>
  );
}

async function DealsByOwnerCard({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  let owners: Awaited<ReturnType<typeof getDealsByOwner>> = [];
  try {
    owners = await getDealsByOwner(ctx, filter);
  } catch {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Deals by owner</CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorMessage
            error={{
              error: { code: 'INTERNAL', message: 'Could not load the owner leaderboard.' },
            }}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Deals by owner</CardTitle>
        <p className="text-xs text-ink-muted">Leaderboard for deals created in the range</p>
      </CardHeader>
      <CardContent>
        {owners.length === 0 ? (
          <EmptyState
            title="No data yet"
            description="Assign deal owners to see the leaderboard."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Owner</TableHead>
                  <TableHead className="text-right">Deals</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {owners.slice(0, 12).map((o) => {
                  const money = formatMoneySummary(o.valueByCurrency);
                  return (
                    <TableRow key={o.ownerPersonId ?? 'unassigned'}>
                      <TableCell className="text-sm font-medium">
                        {o.ownerName ?? 'Unassigned'}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {o.dealCount}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {money.value ?? '—'}
                        {money.sub ? (
                          <span className="block text-[11px] text-ink-muted">{money.sub}</span>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
