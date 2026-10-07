import { Suspense } from 'react';
import { requirePagePermission } from '@/lib/authz/page';
import { PageHeader } from '@/components/shell/page-header';
import { ErrorMessage } from '@/components/crm/error-message';
import type { AuthContext } from '@/lib/db/context';
import {
  getLeadCounts,
  getLeadConversionRate,
  getContactGrowth,
  getCompanyGrowth,
  getActivityVolume,
  type ActivityType,
} from '@/lib/analytics/crm';
import { DateRangePicker } from '../_components/DateRangePicker';
import { StatCard, SectionSkeleton } from '../_components/StatCard';
import { ChartCard, LineChart, StackedBarChart, CHART_COLORS } from '../_components/charts';
import {
  bucketLabel,
  formatInt,
  formatPercent,
  parseDashboardFilter,
  type DashboardFilter,
} from '../_components/lib';

const ACTIVITY_COLORS: Record<ActivityType, string> = {
  CALL: CHART_COLORS[0],
  EMAIL: CHART_COLORS[1],
  MEETING: CHART_COLORS[2],
  NOTE: CHART_COLORS[7],
};

const ACTIVITY_LABELS: Record<ActivityType, string> = {
  CALL: 'Calls',
  EMAIL: 'Emails',
  MEETING: 'Meetings',
  NOTE: 'Notes',
};

/** /analytics/crm — leads, contacts, companies, activity volume. */
export default async function CrmDashboardPage({
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
        <PageHeader title="CRM dashboard" actions={<DateRangePicker />} />
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
        title="CRM dashboard"
        description={`Leads, contacts and activity · ${rangeLabel}`}
        actions={<DateRangePicker />}
      />

      <Suspense fallback={<SectionSkeleton lines={2} />}>
        <CrmKpis ctx={ctx} filter={filter} />
      </Suspense>

      <div className="grid gap-4 lg:grid-cols-2">
        <Suspense fallback={<SectionSkeleton />}>
          <ContactGrowthChart ctx={ctx} filter={filter} />
        </Suspense>
        <Suspense fallback={<SectionSkeleton />}>
          <CompanyGrowthChart ctx={ctx} filter={filter} />
        </Suspense>
      </div>

      <Suspense fallback={<SectionSkeleton lines={4} />}>
        <ActivityVolumeChart ctx={ctx} filter={filter} />
      </Suspense>
    </div>
  );
}

async function CrmKpis({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  let kpis: {
    totalLeads: number;
    newLeads: number;
    qualifiedLeads: number;
    conversionRate: number | null;
  } | null = null;
  try {
    const [leadCounts, conversionRate] = await Promise.all([
      getLeadCounts(ctx.orgId, ctx, filter),
      getLeadConversionRate(ctx.orgId, ctx, filter.dateRange),
    ]);
    kpis = {
      totalLeads: leadCounts.totalLeads,
      newLeads: leadCounts.newLeads,
      qualifiedLeads: leadCounts.qualifiedLeads,
      conversionRate,
    };
  } catch {
    return (
      <ErrorMessage
        error={{ error: { code: 'INTERNAL', message: 'Could not load CRM metrics.' } }}
        title="Could not load CRM metrics"
      />
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard
        label="Open leads"
        value={formatInt(kpis.totalLeads)}
        sub="currently in NEW stage"
      />
      <StatCard label="New leads" value={formatInt(kpis.newLeads)} sub="created in this range" />
      <StatCard
        label="Qualified leads"
        value={formatInt(kpis.qualifiedLeads)}
        sub="currently in QUALIFIED stage"
      />
      <StatCard
        label="Lead conversion"
        value={formatPercent(kpis.conversionRate)}
        sub="lead → customer"
      />
    </div>
  );
}

async function ContactGrowthChart({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  const grain = filter.grain ?? 'day';
  const series = await loadPoints(
    () => getContactGrowth(ctx.orgId, ctx, filter.dateRange, grain),
    grain,
  );
  return (
    <ChartCard title="New contacts" description="Contacts created per period">
      <LineChart data={series} color={CHART_COLORS[0]} ariaLabel="New contacts — line chart" />
    </ChartCard>
  );
}

async function CompanyGrowthChart({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  const grain = filter.grain ?? 'day';
  const series = await loadPoints(
    () => getCompanyGrowth(ctx.orgId, ctx, filter.dateRange, grain),
    grain,
  );
  return (
    <ChartCard title="New companies" description="Companies created per period">
      <LineChart data={series} color={CHART_COLORS[1]} ariaLabel="New companies — line chart" />
    </ChartCard>
  );
}

async function ActivityVolumeChart({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  const grain = filter.grain ?? 'day';
  let rows: Awaited<ReturnType<typeof getActivityVolume>> = [];
  try {
    rows = await getActivityVolume(ctx.orgId, ctx, filter.dateRange, grain);
  } catch {
    return (
      <ChartCard title="Activity volume" description="Logged activities per period, by type">
        <ErrorMessage
          error={{ error: { code: 'INTERNAL', message: 'Could not load activity volume.' } }}
        />
      </ChartCard>
    );
  }

  // Collapse to one bucket per period with per-type segments.
  const order: ActivityType[] = ['CALL', 'EMAIL', 'MEETING', 'NOTE'];
  const byPeriod = new Map<string, { label: string; counts: Record<ActivityType, number> }>();
  for (const r of rows) {
    const key = r.periodStart.toISOString();
    let entry = byPeriod.get(key);
    if (!entry) {
      entry = {
        label: bucketLabel(r.periodStart, grain),
        counts: { CALL: 0, EMAIL: 0, MEETING: 0, NOTE: 0 },
      };
      byPeriod.set(key, entry);
    }
    entry.counts[r.type] = r.count;
  }
  const buckets = [...byPeriod.values()].map((b) => ({
    label: b.label,
    segments: order.map((t) => ({
      label: ACTIVITY_LABELS[t],
      value: b.counts[t],
      color: ACTIVITY_COLORS[t],
    })),
  }));

  return (
    <ChartCard title="Activity volume" description="Logged activities per period, by type">
      <StackedBarChart buckets={buckets} ariaLabel="Activity volume — stacked bar chart" />
      <ul className="mt-3 flex flex-wrap gap-4">
        {order.map((t) => (
          <li key={t} className="flex items-center gap-1.5 text-xs text-ink-muted">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: ACTIVITY_COLORS[t] }}
            />
            {ACTIVITY_LABELS[t]}
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}

async function loadPoints(
  fetch: () => Promise<{ periodStart: Date; value: number | null }[]>,
  grain: 'day' | 'week' | 'month',
) {
  try {
    const points = await fetch();
    return points.map((p) => ({ label: bucketLabel(p.periodStart, grain), value: p.value }));
  } catch {
    return [];
  }
}
