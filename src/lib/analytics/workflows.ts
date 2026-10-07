/**
 * Phase 7 analytics — workflow (business-process) metrics.
 *
 * BUSINESS vs OPERATIONAL distinction (per metric contracts):
 *   - This module is the BUSINESS side: it measures how the org's *workflows*
 *     (its business processes) perform — how often they run, how often they
 *     succeed, which processes are the busiest. These are the numbers a
 *     business owner cares about on a dashboard.
 *   - src/lib/analytics/automation.ts is the OPERATIONAL side: it measures the
 *     health of the background-job machinery (queue backlog, dead letters,
 *     per-job-type throughput) — infrastructure numbers, not business numbers.
 *
 * Tenant isolation: every query re-states `org_id = ctx.orgId`, where ctx is
 * the authenticated session context — NEVER a caller-supplied org id. All
 * reads go through withAuthorizedDb; the RLS policies fail closed on top.
 *
 * Server-only module. Never import from a 'use client' component.
 *
 * Source: public.workflow_executions (Phase 5; drizzle/0044_workflow_engine.sql).
 * Statuses are UPPERCASE: PENDING | RUNNING | SUCCEEDED | FAILED | CANCELLED
 * (enforced by a CHECK constraint; execution *steps* are a different table
 * with different statuses and are NOT aggregated here).
 */
import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { AuthContext } from '@/lib/db/context';
import type {
  DashboardFilter,
  DateRange,
  MetricResult,
  TimeSeriesGrain,
  TimeSeriesPoint,
} from './types';

// ── Execution-status constants ───────────────────────────────────────────────

/** Statuses on public.workflow_executions (UPPERCASE, CHECK-constrained). */
export const EXECUTION_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** Terminal statuses: the execution finished and will not move again. */
const TERMINAL_STATUSES: readonly ExecutionStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

// ── Shared helpers ───────────────────────────────────────────────────────────

interface DateBounds {
  start: Date;
  end: Date;
}

function bounds(range: DateRange): DateBounds {
  return { start: range.startInclusive, end: range.endExclusive };
}

function alignToGrain(d: Date, grain: TimeSeriesGrain): Date {
  const out = new Date(d);
  if (grain === 'month') {
    out.setUTCHours(0, 0, 0, 0);
    out.setUTCDate(1);
    return out;
  }
  out.setUTCHours(0, 0, 0, 0);
  if (grain === 'week') {
    // ISO week: Monday start (matches Postgres date_trunc('week', …)).
    const daysSinceMonday = (out.getUTCDay() + 6) % 7;
    out.setUTCDate(out.getUTCDate() - daysSinceMonday);
  }
  return out;
}

function stepGrain(d: Date, grain: TimeSeriesGrain): Date {
  const out = new Date(d);
  if (grain === 'day') out.setUTCDate(out.getUTCDate() + 1);
  else if (grain === 'week') out.setUTCDate(out.getUTCDate() + 7);
  else out.setUTCMonth(out.getUTCMonth() + 1);
  return out;
}

/**
 * Fills a count time series from SQL date_trunc buckets. Every bucket between
 * range start and end is emitted; buckets with no executions are 0 — a real
 * measurement (zero runs happened), not missing data.
 */
function buildCountSeries(
  range: DateRange,
  grain: TimeSeriesGrain,
  bucketCounts: Map<string, number>,
): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = [];
  if (!(range.endExclusive > range.startInclusive)) return points;
  let cursor = alignToGrain(range.startInclusive, grain);
  for (let guard = 0; guard < 366 && cursor < range.endExclusive; guard++) {
    const next = stepGrain(cursor, grain);
    points.push({
      periodStart: new Date(cursor),
      periodEnd: new Date(next),
      value: bucketCounts.get(cursor.toISOString()) ?? 0,
    });
    cursor = next;
  }
  return points;
}

// ── Metrics ──────────────────────────────────────────────────────────────────

/** Execution counts, total and broken down by execution status. */
export interface WorkflowStats {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

/**
 * Total workflow executions in the date range, broken down by status.
 * Date field: executions' created_at. Status is the *current* status, not the
 * status at creation.
 */
export async function getWorkflowStats(
  ctx: AuthContext,
  filters: DashboardFilter,
): Promise<WorkflowStats> {
  const { start, end } = bounds(filters.dateRange);
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{
      total: string;
      pending: string;
      running: string;
      succeeded: string;
      failed: string;
      cancelled: string;
    }>(sql`
      select
        count(*) as total,
        count(*) filter (where status = 'PENDING')   as pending,
        count(*) filter (where status = 'RUNNING')   as running,
        count(*) filter (where status = 'SUCCEEDED') as succeeded,
        count(*) filter (where status = 'FAILED')    as failed,
        count(*) filter (where status = 'CANCELLED') as cancelled
      from workflow_executions
      where org_id = ${ctx.orgId}
        and created_at >= ${start}
        and created_at < ${end}
    `);
    const r = res.rows[0];
    return {
      total: Number(r?.total ?? 0),
      pending: Number(r?.pending ?? 0),
      running: Number(r?.running ?? 0),
      succeeded: Number(r?.succeeded ?? 0),
      failed: Number(r?.failed ?? 0),
      cancelled: Number(r?.cancelled ?? 0),
    };
  });
}

/**
 * Workflow success rate: SUCCEEDED / (SUCCEEDED + FAILED + CANCELLED).
 * Only *terminal* executions count — in-flight (PENDING/RUNNING) executions
 * are excluded so a surge of just-started runs cannot depress the rate.
 * Returns NULL (not 0) when there are no terminal executions in the range.
 */
export async function getWorkflowSuccessRate(
  ctx: AuthContext,
  filters: DashboardFilter,
): Promise<MetricResult> {
  const { start, end } = bounds(filters.dateRange);
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{ rate: string | null }>(sql`
      select
        count(*) filter (where status = 'SUCCEEDED')::float
        / nullif(count(*) filter (where status in ('SUCCEEDED', 'FAILED', 'CANCELLED')), 0)
        as rate
      from workflow_executions
      where org_id = ${ctx.orgId}
        and created_at >= ${start}
        and created_at < ${end}
    `);
    const rate = res.rows[0]?.rate;
    return rate == null ? null : Number(rate);
  });
}

/**
 * Executions over time, bucketed by filters.grain (default 'day').
 * Each bucket counts executions whose created_at falls in the half-open
 * bucket [periodStart, periodEnd).
 */
export async function getExecutionsOverTime(
  ctx: AuthContext,
  filters: DashboardFilter,
): Promise<TimeSeriesPoint[]> {
  const { start, end } = bounds(filters.dateRange);
  const grain: TimeSeriesGrain = filters.grain ?? 'day';
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{ bucket: Date; n: string }>(sql`
      select date_trunc(${grain}, created_at) as bucket, count(*) as n
      from workflow_executions
      where org_id = ${ctx.orgId}
        and created_at >= ${start}
        and created_at < ${end}
      group by 1
      order by 1
    `);
    const counts = new Map<string, number>();
    for (const row of res.rows) {
      const bucket = row.bucket instanceof Date ? row.bucket : new Date(String(row.bucket));
      counts.set(bucket.toISOString(), Number(row.n));
    }
    return buildCountSeries(filters.dateRange, grain, counts);
  });
}

/** One workflow ranked by execution volume. */
export interface TopWorkflow {
  workflowId: string;
  workflowName: string;
  executions: number;
}

/**
 * The most-executed workflows in the date range (deleted workflows excluded —
 * this is a dashboard of what the org is actively running).
 * Terminal-state note: TERMINAL_STATUSES export above for callers that need
 * the contract's denominator definition in one place.
 */
export async function getTopWorkflows(
  ctx: AuthContext,
  filters: DashboardFilter,
  limit = 10,
): Promise<TopWorkflow[]> {
  const { start, end } = bounds(filters.dateRange);
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{
      workflow_id: string;
      workflow_name: string;
      executions: string;
    }>(sql`
      select
        e.workflow_id,
        w.name as workflow_name,
        count(*) as executions
      from workflow_executions e
      join workflows w
        on w.id = e.workflow_id
       and w.org_id = e.org_id
       and w.deleted_at is null
      where e.org_id = ${ctx.orgId}
        and e.created_at >= ${start}
        and e.created_at < ${end}
      group by e.workflow_id, w.name
      order by executions desc, w.name asc
      limit ${safeLimit}
    `);
    return res.rows.map((row) => ({
      workflowId: String(row.workflow_id),
      workflowName: String(row.workflow_name),
      executions: Number(row.executions),
    }));
  });
}

export { TERMINAL_STATUSES };
