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
  getProjectStats,
  getTasksByStatus,
  getTasksByPriority,
  getOverdueTasks,
  getTasksByAssignee,
  getTaskCompletionTrend,
} from '@/lib/analytics/work';
import type { TaskStatus } from '@/lib/work/schema';
import { DateRangePicker } from '../_components/DateRangePicker';
import { StatCard, SectionSkeleton } from '../_components/StatCard';
import { ChartCard, DonutChart, HBarChart, LineChart, CHART_COLORS } from '../_components/charts';
import {
  formatInt,
  parseDashboardFilter,
  tzDateString,
  type DashboardFilter,
} from '../_components/lib';

/** /analytics/work — projects, tasks, overdue, workload. */
export default async function WorkDashboardPage({
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
        <PageHeader title="Work dashboard" actions={<DateRangePicker />} />
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
        title="Work dashboard"
        description={`Projects and tasks · ${rangeLabel}`}
        actions={<DateRangePicker />}
      />

      <Suspense fallback={<SectionSkeleton lines={2} />}>
        <WorkKpis ctx={ctx} filter={filter} />
      </Suspense>

      <div className="grid gap-4 lg:grid-cols-2">
        <Suspense fallback={<SectionSkeleton />}>
          <TaskStatusCard ctx={ctx} />
        </Suspense>
        <Suspense fallback={<SectionSkeleton />}>
          <TaskPriorityCard ctx={ctx} />
        </Suspense>
        <Suspense fallback={<SectionSkeleton />}>
          <CompletionTrendCard ctx={ctx} filter={filter} />
        </Suspense>
        <Suspense fallback={<SectionSkeleton />}>
          <OverdueCard ctx={ctx} />
        </Suspense>
      </div>

      <Suspense fallback={<SectionSkeleton lines={4} />}>
        <WorkloadCard ctx={ctx} />
      </Suspense>
    </div>
  );
}

async function WorkKpis({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  let kpis: {
    active: number;
    total: number;
    todo: number;
    inProgress: number;
    done: number;
    overdueTotal: number;
    completed: number;
  } | null = null;
  try {
    const grain = filter.grain ?? 'day';
    const [projectStats, statusCounts, overdue, trend] = await Promise.all([
      getProjectStats(ctx),
      getTasksByStatus(ctx),
      getOverdueTasks(ctx, { limit: 1 }),
      getTaskCompletionTrend(ctx, {
        from: tzDateString(filter.dateRange.startInclusive),
        to: tzDateString(new Date(filter.dateRange.endExclusive.getTime() - 1)),
        granularity: grain === 'month' ? 'week' : grain,
      }),
    ]);
    kpis = {
      active: projectStats.active,
      total: projectStats.total,
      todo: statusCounts.todo,
      inProgress: statusCounts.in_progress,
      done: statusCounts.done,
      overdueTotal: overdue.total,
      completed: trend.reduce((s, b) => s + b.completed, 0),
    };
  } catch {
    return (
      <ErrorMessage
        error={{ error: { code: 'INTERNAL', message: 'Could not load work metrics.' } }}
        title="Could not load work metrics"
      />
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard
        label="Active projects"
        value={formatInt(kpis.active)}
        sub={`${formatInt(kpis.total)} total`}
      />
      <StatCard
        label="Open tasks"
        value={formatInt(kpis.todo + kpis.inProgress)}
        sub="to do + in progress"
      />
      <StatCard label="Tasks completed" value={formatInt(kpis.completed)} sub="in this range" />
      <StatCard label="Overdue tasks" value={formatInt(kpis.overdueTotal)} />
    </div>
  );
}

async function TaskStatusCard({ ctx }: { ctx: AuthContext }) {
  let counts: Awaited<ReturnType<typeof getTasksByStatus>> | null = null;
  try {
    counts = await getTasksByStatus(ctx);
  } catch {
    return (
      <ChartCard title="Tasks by status">
        <ErrorMessage
          error={{ error: { code: 'INTERNAL', message: 'Could not load task status counts.' } }}
        />
      </ChartCard>
    );
  }
  const order = ['todo', 'in_progress', 'done'] as const;
  const labels: Record<TaskStatus, string> = {
    todo: 'To do',
    in_progress: 'In progress',
    done: 'Done',
  };
  const colors: Record<string, string> = {
    todo: '#94a3b8',
    in_progress: '#3b82f6',
    done: '#22c55e',
  };
  return (
    <ChartCard title="Tasks by status" description="All non-deleted tasks, current snapshot">
      <DonutChart
        ariaLabel="Tasks by status — donut chart"
        segments={order.map((s) => ({
          label: labels[s],
          value: counts[s],
          color: colors[s],
        }))}
      />
    </ChartCard>
  );
}

async function TaskPriorityCard({ ctx }: { ctx: AuthContext }) {
  let counts: Awaited<ReturnType<typeof getTasksByPriority>> | null = null;
  try {
    counts = await getTasksByPriority(ctx);
  } catch {
    return (
      <ChartCard title="Tasks by priority">
        <ErrorMessage
          error={{ error: { code: 'INTERNAL', message: 'Could not load task priority counts.' } }}
        />
      </ChartCard>
    );
  }
  const order = ['urgent', 'high', 'medium', 'low'] as const;
  const colors: Record<string, string> = {
    urgent: '#ef4444',
    high: '#f59e0b',
    medium: '#3b82f6',
    low: '#94a3b8',
  };
  return (
    <ChartCard title="Tasks by priority" description="All non-deleted tasks, current snapshot">
      <HBarChart
        data={order.map((p) => ({
          label: p.charAt(0).toUpperCase() + p.slice(1),
          value: counts[p],
        }))}
        colorFor={(row) => colors[row.label.toLowerCase()] ?? CHART_COLORS[0]}
      />
    </ChartCard>
  );
}

async function CompletionTrendCard({ ctx, filter }: { ctx: AuthContext; filter: DashboardFilter }) {
  const grain = filter.grain ?? 'day';
  let trend: Awaited<ReturnType<typeof getTaskCompletionTrend>> = [];
  try {
    trend = await getTaskCompletionTrend(ctx, {
      from: tzDateString(filter.dateRange.startInclusive),
      to: tzDateString(new Date(filter.dateRange.endExclusive.getTime() - 1)),
      granularity: grain === 'month' ? 'week' : grain,
    });
  } catch {
    return (
      <ChartCard title="Task completion trend">
        <ErrorMessage
          error={{ error: { code: 'INTERNAL', message: 'Could not load the completion trend.' } }}
        />
      </ChartCard>
    );
  }
  return (
    <ChartCard title="Task completion trend" description="Tasks completed per period">
      <LineChart
        ariaLabel="Task completion trend — line chart"
        data={trend.map((b) => ({
          label: new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(
            new Date(`${b.bucket}T00:00:00`),
          ),
          value: b.completed,
        }))}
        color={CHART_COLORS[2]}
      />
    </ChartCard>
  );
}

async function OverdueCard({ ctx }: { ctx: AuthContext }) {
  let page: Awaited<ReturnType<typeof getOverdueTasks>> | null = null;
  try {
    page = await getOverdueTasks(ctx, { limit: 10 });
  } catch {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Overdue tasks</CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorMessage
            error={{ error: { code: 'INTERNAL', message: 'Could not load overdue tasks.' } }}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Overdue tasks{page.total > 0 ? ` (${page.total})` : ''}
        </CardTitle>
        <p className="text-xs text-ink-muted">Past due date and not done — live snapshot</p>
      </CardHeader>
      <CardContent>
        {page.rows.length === 0 ? (
          <EmptyState title="Nothing overdue" description="Every task is on schedule." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Assignee</TableHead>
                  <TableHead>Due</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.rows.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="max-w-xs truncate text-sm font-medium" title={t.title}>
                      {t.title}
                    </TableCell>
                    <TableCell className="text-sm text-ink-muted">{t.projectName ?? '—'}</TableCell>
                    <TableCell className="text-sm text-ink-muted">
                      {t.assigneeName ?? 'Unassigned'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm tabular-nums text-red-600">
                      {t.dueDate}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {page.total > page.rows.length && (
              <p className="mt-2 text-xs text-ink-muted">
                Showing {page.rows.length} of {page.total} overdue tasks.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

async function WorkloadCard({ ctx }: { ctx: AuthContext }) {
  let rows: Awaited<ReturnType<typeof getTasksByAssignee>> = [];
  try {
    rows = await getTasksByAssignee(ctx);
  } catch {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Workload by assignee</CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorMessage
            error={{
              error: { code: 'INTERNAL', message: 'Could not load the workload breakdown.' },
            }}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Workload by assignee</CardTitle>
        <p className="text-xs text-ink-muted">Open vs completed load per person — live snapshot</p>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState title="No data yet" description="Assign tasks to see workload per person." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Assignee</TableHead>
                  <TableHead className="text-right">To do</TableHead>
                  <TableHead className="text-right">In progress</TableHead>
                  <TableHead className="text-right">Done</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(0, 15).map((r) => (
                  <TableRow key={r.assigneePersonId ?? 'unassigned'}>
                    <TableCell className="text-sm font-medium">
                      {r.assigneeName ?? 'Unassigned'}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">{r.todo}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {r.inProgress}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">{r.done}</TableCell>
                    <TableCell className="text-right text-sm font-medium tabular-nums">
                      {r.total}
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
