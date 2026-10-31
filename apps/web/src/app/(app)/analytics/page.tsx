import { Suspense } from 'react';
import Link from 'next/link';
import { requirePagePermission } from '@/lib/authz/page';
import { PageHeader } from '@/components/shell/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { ErrorMessage } from '@/components/crm/error-message';
import type { AuthContext } from '@/lib/db/context';
import { getWonRevenue, getPipelineValue, getWinRate } from '@/lib/analytics/sales';
import { getContactGrowth, getLeadCounts } from '@/lib/analytics/crm';
import { getProjectStats, getTaskCompletionTrend } from '@/lib/analytics/work';
import { getAutomationSuccessRate, getJobsOverTime } from '@/lib/analytics/automation';
import { getWorkflowSuccessRate, getExecutionsOverTime } from '@/lib/analytics/workflows';
import { DateRangePicker } from './_components/DateRangePicker';
import { StatCard, SectionSkeleton } from './_components/StatCard';
import { ChartCard, LineChart } from './_components/charts';
import {
  bucketLabel,
  formatInt,
  formatMoneySummary,
  formatPercent,
  parseDashboardFilter,
  tzDateString,
  type DashboardFilter,
} from './_components/lib';

/** /analytics — organization overview: headline KPIs across every module. */
export default async function AnalyticsOverviewPage({
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
        <PageHeader title="Analytics" actions={<DateRangePicker />} />
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
        title="Analytics"
        description={`Organization overview · ${rangeLabel}`}
        actions={<DateRangePicker />}
      />

      <Suspense fallback={<SectionSkeleton lines={2} />}>
        <OverviewKpis ctx={ctx} filter={filter} />
      </Suspense>

      <div className="grid gap-4 lg:grid-cols-2">
        <Suspense fallback={<SectionSkeleton />}>
          <WorkflowActivityChart ctx={ctx} filter={filter} />
        </Suspense>
        <Suspense fallback={<SectionSkeleton />}>
          <ContactGrowthChart ctx={ctx} filter={filter} />
        </Suspense>
        <Suspense fallback={<SectionSkeleton />}>
          <TaskCompletionChart ctx={ctx} filter={filter} />
        </Suspense>
        <Suspense fallback={<SectionSkeleton />}>
          <JobsActivityChart ctx={ctx} filter={filter} />
        </Suspense>
      </div>

      <Card>
        <CardContent className="flex flex-wrap gap-x-8 gap-y-2 px-6 py-4">
          <DashboardLink href="/analytics/sales" label="Sales dashboard" />
          <DashboardLink href="/analytics/crm" label="CRM dashboard" />
          <DashboardLink href="/analytics/work" label="Work dashboard" />
          <DashboardLink href="/analytics/automation" label="Automation dashboard" />
        </CardContent>
      </Card>
    </div>
  );
}

function DashboardLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="text-sm font-medium text-brand hover:underline">
      {label} →
    </Link>
  );
}

async function OverviewKpis({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  let data: Awaited<ReturnType<typeof loadKpis>> | null = null;
  try {
    data = await loadKpis(ctx, filter);
  } catch {
    return (
      <ErrorMessage
        error={{ error: { code: 'INTERNAL', message: 'Could not load overview metrics.' } }}
        title="Could not load overview"
      />
    );
  }

  const revenue = formatMoneySummary(data.wonRevenue);
  const pipeline = formatMoneySummary(data.pipelineValue);

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard label="Revenue won" value={revenue.value} sub={revenue.sub} />
      <StatCard label="Open pipeline value" value={pipeline.value} sub={pipeline.sub} />
      <StatCard label="Win rate" value={formatPercent(data.winRate)} />
      <StatCard label="New leads" value={formatInt(data.leadCounts.newLeads)} />
      <StatCard label="Active projects" value={formatInt(data.projectStats.active)} />
      <StatCard
        label="Tasks completed"
        value={formatInt(data.completedTasks)}
        sub="in this range"
      />
      <StatCard label="Workflow success rate" value={formatPercent(data.workflowSuccessRate)} />
      <StatCard label="Job success rate" value={formatPercent(data.jobSuccessRate)} />
    </div>
  );
}

async function loadKpis(ctx: AuthContext, filter: DashboardFilter) {
  const grain = filter.grain ?? 'day';
  const [
    wonRevenue,
    pipelineValue,
    winRate,
    leadCounts,
    projectStats,
    workflowSuccessRate,
    jobSuccessRate,
    trend,
  ] = await Promise.all([
    getWonRevenue(ctx, filter),
    getPipelineValue(ctx, filter),
    getWinRate(ctx, filter),
    getLeadCounts(ctx.orgId, ctx, filter),
    getProjectStats(ctx),
    getWorkflowSuccessRate(ctx, filter),
    getAutomationSuccessRate(ctx, filter),
    getTaskCompletionTrend(ctx, {
      from: tzDateString(filter.dateRange.startInclusive),
      to: tzDateString(new Date(filter.dateRange.endExclusive.getTime() - 1)),
      granularity: grain === 'month' ? 'week' : grain,
    }),
  ]);
  const completedTasks = trend.reduce((s, b) => s + b.completed, 0);
  return {
    wonRevenue,
    pipelineValue,
    winRate,
    leadCounts,
    projectStats,
    workflowSuccessRate,
    jobSuccessRate,
    completedTasks,
  };
}

async function WorkflowActivityChart({
  ctx,
  filter,
}: {
  ctx: AuthContext;
  filter: DashboardFilter;
}) {
  const grain = filter.grain ?? 'day';
  const series = await loadSeries(() => getExecutionsOverTime(ctx, filter), grain);
  return (
    <ChartCard title="Workflow executions" description="Executions started per period">
      <LineChart data={series} ariaLabel="Workflow executions — line chart" />
    </ChartCard>
  );
}

async function JobsActivityChart({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  const grain = filter.grain ?? 'day';
  const series = await loadSeries(() => getJobsOverTime(ctx, filter), grain);
  return (
    <ChartCard title="Jobs enqueued" description="Background jobs created per period">
      <LineChart data={series} color="#8b5cf6" ariaLabel="Jobs enqueued — line chart" />
    </ChartCard>
  );
}

async function ContactGrowthChart({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  const grain = filter.grain ?? 'day';
  const series = await loadSeries(
    () => getContactGrowth(ctx.orgId, ctx, filter.dateRange, grain),
    grain,
  );
  return (
    <ChartCard title="New contacts" description="Contacts created per period">
      <LineChart data={series} color="#22c55e" ariaLabel="New contacts — line chart" />
    </ChartCard>
  );
}

async function TaskCompletionChart({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  const grain = filter.grain ?? 'day';
  let trend: { bucket: string; completed: number }[] = [];
  try {
    trend = await getTaskCompletionTrend(ctx, {
      from: tzDateString(filter.dateRange.startInclusive),
      to: tzDateString(new Date(filter.dateRange.endExclusive.getTime() - 1)),
      granularity: grain === 'month' ? 'week' : grain,
    });
  } catch {
    return (
      <ChartCard title="Tasks completed" description="Tasks completed per period">
        <ErrorMessage
          error={{ error: { code: 'INTERNAL', message: 'Could not load the completion trend.' } }}
        />
      </ChartCard>
    );
  }
  return (
    <ChartCard title="Tasks completed" description="Tasks completed per period">
      <LineChart
        ariaLabel="Tasks completed — line chart"
        data={trend.map((b) => ({
          label: new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(
            new Date(`${b.bucket}T00:00:00`),
          ),
          value: b.completed,
        }))}
        color="#f59e0b"
      />
    </ChartCard>
  );
}

async function loadSeries(
  fetch: () => Promise<{ periodStart: Date; value: number | null }[]>,
  grain: 'day' | 'week' | 'month',
) {
  try {
    const points = await fetch();
    if (points.length === 0) return [];
    return points.map((p) => ({
      label: bucketLabel(p.periodStart, grain),
      value: p.value,
    }));
  } catch {
    return [];
  }
}
