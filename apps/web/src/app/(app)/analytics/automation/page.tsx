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
import { JOB_STATUSES, JOB_TYPES } from '@/lib/jobs/types';
import {
  getJobStats,
  getAutomationSuccessRate,
  getDeadLetterCount,
  getJobsOverTime,
} from '@/lib/analytics/automation';
import {
  getWorkflowStats,
  getWorkflowSuccessRate,
  getExecutionsOverTime,
  getTopWorkflows,
} from '@/lib/analytics/workflows';
import { DateRangePicker } from '../_components/DateRangePicker';
import { StatCard, SectionSkeleton } from '../_components/StatCard';
import {
  ChartCard,
  DonutChart,
  HBarChart,
  LineChart,
  colorAt,
  CHART_COLORS,
} from '../_components/charts';
import {
  bucketLabel,
  formatInt,
  formatPercent,
  parseDashboardFilter,
  type DashboardFilter,
} from '../_components/lib';

const JOB_STATUS_COLORS: Record<string, string> = {
  pending: '#94a3b8',
  claimed: '#06b6d6',
  running: '#3b82f6',
  succeeded: '#22c55e',
  failed: '#f59e0b',
  dead_letter: '#ef4444',
  cancelled: '#a855f7',
};

const EXECUTION_STATUS_COLORS: Record<string, string> = {
  PENDING: '#94a3b8',
  RUNNING: '#3b82f6',
  SUCCEEDED: '#22c55e',
  FAILED: '#f59e0b',
  CANCELLED: '#a855f7',
};

const statusLabel = (s: string) =>
  s
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** /analytics/automation — jobs, workflows, executions, success rates. */
export default async function AutomationDashboardPage({
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
        <PageHeader title="Automation dashboard" actions={<DateRangePicker />} />
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
        title="Automation dashboard"
        description={`Workflows, jobs and execution health · ${rangeLabel}`}
        actions={<DateRangePicker />}
      />

      <Suspense fallback={<SectionSkeleton lines={2} />}>
        <AutomationKpis ctx={ctx} filter={filter} />
      </Suspense>

      <div className="grid gap-4 lg:grid-cols-2">
        <Suspense fallback={<SectionSkeleton />}>
          <ExecutionsChart ctx={ctx} filter={filter} />
        </Suspense>
        <Suspense fallback={<SectionSkeleton />}>
          <JobsOverTimeChart ctx={ctx} filter={filter} />
        </Suspense>
        <Suspense fallback={<SectionSkeleton />}>
          <JobStatusCard ctx={ctx} filter={filter} />
        </Suspense>
        <Suspense fallback={<SectionSkeleton />}>
          <WorkflowStatusCard ctx={ctx} filter={filter} />
        </Suspense>
        <Suspense fallback={<SectionSkeleton />}>
          <JobTypeCard ctx={ctx} filter={filter} />
        </Suspense>
        <Suspense fallback={<SectionSkeleton />}>
          <TopWorkflowsCard ctx={ctx} filter={filter} />
        </Suspense>
      </div>
    </div>
  );
}

async function AutomationKpis({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  let kpis: {
    totalJobs: number;
    failedJobs: number;
    deadLetter: number;
    jobSuccessRate: number | null;
    totalExecutions: number;
    failedExecutions: number;
    workflowSuccessRate: number | null;
  } | null = null;
  try {
    const [jobStats, jobSuccessRate, deadLetter, workflowStats, workflowSuccessRate] =
      await Promise.all([
        getJobStats(ctx, filter),
        getAutomationSuccessRate(ctx, filter),
        getDeadLetterCount(ctx),
        getWorkflowStats(ctx, filter),
        getWorkflowSuccessRate(ctx, filter),
      ]);
    kpis = {
      totalJobs: Object.values(jobStats.byStatus).reduce((s, n) => s + n, 0),
      failedJobs: jobStats.byStatus.failed,
      deadLetter,
      jobSuccessRate,
      totalExecutions: workflowStats.total,
      failedExecutions: workflowStats.failed,
      workflowSuccessRate,
    };
  } catch {
    return (
      <ErrorMessage
        error={{ error: { code: 'INTERNAL', message: 'Could not load automation metrics.' } }}
        title="Could not load automation metrics"
      />
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard label="Jobs in range" value={formatInt(kpis.totalJobs)} />
      <StatCard label="Job success rate" value={formatPercent(kpis.jobSuccessRate)} />
      <StatCard
        label="Dead letter (live)"
        value={formatInt(kpis.deadLetter)}
        sub={kpis.failedJobs > 0 ? `${formatInt(kpis.failedJobs)} failed in range` : undefined}
      />
      <StatCard label="Workflow executions" value={formatInt(kpis.totalExecutions)} />
      <StatCard label="Workflow success rate" value={formatPercent(kpis.workflowSuccessRate)} />
      <StatCard label="Failed executions" value={formatInt(kpis.failedExecutions)} />
    </div>
  );
}

async function ExecutionsChart({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  const grain = filter.grain ?? 'day';
  const series = await loadPoints(() => getExecutionsOverTime(ctx, filter), grain);
  return (
    <ChartCard title="Workflow executions" description="Executions started per period">
      <LineChart
        data={series}
        color={CHART_COLORS[0]}
        ariaLabel="Workflow executions — line chart"
      />
    </ChartCard>
  );
}

async function JobsOverTimeChart({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  const grain = filter.grain ?? 'day';
  const series = await loadPoints(() => getJobsOverTime(ctx, filter), grain);
  return (
    <ChartCard title="Jobs enqueued" description="Background jobs created per period">
      <LineChart data={series} color={CHART_COLORS[1]} ariaLabel="Jobs enqueued — line chart" />
    </ChartCard>
  );
}

async function JobStatusCard({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  let stats: Awaited<ReturnType<typeof getJobStats>> | null = null;
  try {
    stats = await getJobStats(ctx, filter);
  } catch {
    return (
      <ChartCard title="Jobs by status">
        <ErrorMessage
          error={{ error: { code: 'INTERNAL', message: 'Could not load job status counts.' } }}
        />
      </ChartCard>
    );
  }
  return (
    <ChartCard title="Jobs by status" description="Jobs created in the range">
      <DonutChart
        ariaLabel="Jobs by status — donut chart"
        segments={JOB_STATUSES.map((s) => ({
          label: statusLabel(s),
          value: stats.byStatus[s],
          color: JOB_STATUS_COLORS[s],
        }))}
      />
    </ChartCard>
  );
}

async function WorkflowStatusCard({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  let stats: Awaited<ReturnType<typeof getWorkflowStats>> | null = null;
  try {
    stats = await getWorkflowStats(ctx, filter);
  } catch {
    return (
      <ChartCard title="Executions by status">
        <ErrorMessage
          error={{
            error: { code: 'INTERNAL', message: 'Could not load execution status counts.' },
          }}
        />
      </ChartCard>
    );
  }
  const order = [
    { key: 'PENDING', value: stats.pending },
    { key: 'RUNNING', value: stats.running },
    { key: 'SUCCEEDED', value: stats.succeeded },
    { key: 'FAILED', value: stats.failed },
    { key: 'CANCELLED', value: stats.cancelled },
  ] as const;
  return (
    <ChartCard
      title="Executions by status"
      description="Current status of executions started in the range"
    >
      <DonutChart
        ariaLabel="Executions by status — donut chart"
        segments={order.map((s) => ({
          label: statusLabel(s.key.toLowerCase()),
          value: s.value,
          color: EXECUTION_STATUS_COLORS[s.key],
        }))}
      />
    </ChartCard>
  );
}

async function JobTypeCard({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  let stats: Awaited<ReturnType<typeof getJobStats>> | null = null;
  try {
    stats = await getJobStats(ctx, filter);
  } catch {
    return (
      <ChartCard title="Jobs by type">
        <ErrorMessage
          error={{ error: { code: 'INTERNAL', message: 'Could not load job type counts.' } }}
        />
      </ChartCard>
    );
  }
  const labels: Record<string, string> = {
    workflow_run: 'Workflow run',
    scheduled_trigger: 'Scheduled trigger',
    retry: 'Retry',
    webhook: 'Webhook',
    cleanup: 'Cleanup',
    notification: 'Notification',
    email: 'Email',
  };
  return (
    <ChartCard title="Jobs by type" description="Jobs created in the range">
      <HBarChart
        data={JOB_TYPES.map((t) => ({
          label: labels[t] ?? statusLabel(t),
          value: stats.byType[t],
        }))}
        colorFor={(_, i) => colorAt(i)}
      />
    </ChartCard>
  );
}

async function TopWorkflowsCard({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  let rows: Awaited<ReturnType<typeof getTopWorkflows>> = [];
  try {
    rows = await getTopWorkflows(ctx, filter, 8);
  } catch {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Top workflows</CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorMessage
            error={{ error: { code: 'INTERNAL', message: 'Could not load the top workflows.' } }}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Top workflows</CardTitle>
        <p className="text-xs text-ink-muted">Most-executed workflows in the range</p>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            title="No data yet"
            description="Workflows appear here once executions start running."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Workflow</TableHead>
                  <TableHead className="text-right">Executions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((w) => (
                  <TableRow key={w.workflowId}>
                    <TableCell
                      className="max-w-xs truncate text-sm font-medium"
                      title={w.workflowName}
                    >
                      {w.workflowName}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {w.executions}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
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
