/**
 * Phase 7 analytics — automation (operational) metrics.
 *
 * BUSINESS vs OPERATIONAL distinction (per metric contracts):
 *   - This module is the OPERATIONAL side: it measures the health of the
 *     background-job machinery itself — queue backlog per status, throughput
 *     per job type, success rate of the runner, and the dead-letter pile.
 *     These are infrastructure numbers: they tell an operator whether the
 *     automation engine is keeping up, not whether the business is doing well.
 *   - src/lib/analytics/workflows.ts is the BUSINESS side: how the org's
 *     workflows (business processes) perform — execution counts, success
 *     rates, busiest processes.
 *
 * A job and a workflow execution are related but distinct: a `workflow_run`
 * job is the queue entry that *drives* a workflow execution. Success-rate
 * here is about the job machinery (did the runner finish the job?); the
 * workflow module's success rate is about the process (did the workflow's
 * steps complete?). They can legitimately differ.
 *
 * Tenant isolation: every query re-states `org_id = ctx.orgId`, where ctx is
 * the authenticated session context — NEVER a caller-supplied org id. All
 * reads go through withAuthorizedDb; the RLS policies fail closed on top.
 * Pattern mirrors getJobsStats in src/app/(app)/jobs/_jobs.ts.
 *
 * Phase 12 (F-12-01): every metric accepts an optional trailing `tx?: Tx`.
 * When a caller (an analytics route composing a dashboard) supplies one, the
 * metric runs on that shared authorized transaction and opens none of its
 * own; when omitted, it opens its own via withAuthorizedDb exactly as
 * before. Results are identical either way — one snapshot instead of many.
 *
 * Server-only module. Never import from a 'use client' component.
 *
 * Source: public.jobs (Phase 6; drizzle/0045_automation_jobs.sql).
 * Statuses (7, lowercase): pending | claimed | running | succeeded | failed |
 *   dead_letter | cancelled (CHECK-constrained state machine).
 * Types (7, lowercase): workflow_run | scheduled_trigger | retry | webhook |
 *   cleanup | notification | email.
 */
import { sql } from 'drizzle-orm';
import { withAuthorizedDb, type Tx } from '@/lib/db/authorized';
import type { AuthContext } from '@/lib/db/context';
import { JOB_STATUSES, JOB_TYPES, type JobStatus, type JobType } from '@/lib/jobs/types';
import type {
  DashboardFilter,
  DateRange,
  MetricResult,
  TimeSeriesGrain,
  TimeSeriesPoint,
} from './types';

// ── Shared helpers ───────────────────────────────────────────────────────────

function bounds(range: DateRange): { start: Date; end: Date } {
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
 * range start and end is emitted; buckets with no jobs are 0 — a real
 * measurement (zero jobs enqueued), not missing data.
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

/** Job counts broken down by all 7 statuses and all 7 job types. */
export interface JobStats {
  byStatus: Record<JobStatus, number>;
  byType: Record<JobType, number>;
}

/**
 * Job queue snapshot for the date range (date field: jobs.created_at):
 * how many jobs sit in each of the 7 lifecycle statuses, and how many of
 * each of the 7 job types were created. Every key is always present, even
 * when the count is 0 — an absent key would mean "not measured", and here
 * zero is a real measurement.
 */
export async function getJobStats(
  ctx: AuthContext,
  filters: DashboardFilter,
  tx?: Tx,
): Promise<JobStats> {
  const { start, end } = bounds(filters.dateRange);
  const run = async (db: Tx): Promise<JobStats> => {
    const res = await db.execute<Record<string, string>>(sql`
      select
        count(*) filter (where status = 'pending')     as s_pending,
        count(*) filter (where status = 'claimed')     as s_claimed,
        count(*) filter (where status = 'running')     as s_running,
        count(*) filter (where status = 'succeeded')  as s_succeeded,
        count(*) filter (where status = 'failed')     as s_failed,
        count(*) filter (where status = 'dead_letter') as s_dead_letter,
        count(*) filter (where status = 'cancelled')  as s_cancelled,
        count(*) filter (where type = 'workflow_run')      as t_workflow_run,
        count(*) filter (where type = 'scheduled_trigger') as t_scheduled_trigger,
        count(*) filter (where type = 'retry')              as t_retry,
        count(*) filter (where type = 'webhook')            as t_webhook,
        count(*) filter (where type = 'cleanup')           as t_cleanup,
        count(*) filter (where type = 'notification')      as t_notification,
        count(*) filter (where type = 'email')              as t_email
      from jobs
      where org_id = ${ctx.orgId}
        and created_at >= ${start}
        and created_at < ${end}
    `);
    const r = res.rows[0] ?? {};
    const byStatus = {} as Record<JobStatus, number>;
    for (const status of JOB_STATUSES) {
      byStatus[status] = Number(r[`s_${status}`] ?? 0);
    }
    const byType = {} as Record<JobType, number>;
    for (const type of JOB_TYPES) {
      byType[type] = Number(r[`t_${type}`] ?? 0);
    }
    return { byStatus, byType };
  };
  return tx ? run(tx) : withAuthorizedDb(ctx, run);
}

/**
 * Automation success rate: succeeded / (succeeded + failed + dead_letter).
 * Denominator is terminal *failure-bearing* outcomes only — in-flight
 * (pending/claimed/running) and cancelled jobs are excluded, so a healthy
 * backlog cannot depress the rate. A job that lands in dead_letter counts as
 * a failure of the machinery (it exhausted retries or was routed there).
 * Returns NULL (not 0) when there are no resolved jobs in the range.
 *
 * NOTE: this is the *operational* success rate of the job runner. The
 * business-process success rate lives in
 * src/lib/analytics/workflows.ts#getWorkflowSuccessRate — the two can differ
 * (e.g. a job can succeed while the workflow it drove reports FAILED).
 */
export async function getAutomationSuccessRate(
  ctx: AuthContext,
  filters: DashboardFilter,
  tx?: Tx,
): Promise<MetricResult> {
  const { start, end } = bounds(filters.dateRange);
  const run = async (db: Tx): Promise<MetricResult> => {
    const res = await db.execute<{ rate: string | null }>(sql`
      select
        count(*) filter (where status = 'succeeded')::float
        / nullif(count(*) filter (where status in ('succeeded', 'failed', 'dead_letter')), 0)
        as rate
      from jobs
      where org_id = ${ctx.orgId}
        and created_at >= ${start}
        and created_at < ${end}
    `);
    const rate = res.rows[0]?.rate;
    return rate == null ? null : Number(rate);
  };
  return tx ? run(tx) : withAuthorizedDb(ctx, run);
}

/**
 * Current dead-letter backlog: jobs in status='dead_letter' for this org.
 * Operational signal — each one needs operator attention (manual replay or
 * cancellation). Unlike the ranged metrics, this is a live snapshot: no
 * date range applies, because a dead-lettered job stays actionable until
 * someone resolves it.
 */
export async function getDeadLetterCount(ctx: AuthContext, tx?: Tx): Promise<number> {
  const run = async (db: Tx): Promise<number> => {
    const res = await db.execute<{ n: string }>(sql`
      select count(*) as n
      from jobs
      where org_id = ${ctx.orgId}
        and status = 'dead_letter'
    `);
    return Number(res.rows[0]?.n ?? 0);
  };
  return tx ? run(tx) : withAuthorizedDb(ctx, run);
}

/**
 * Jobs created over time, bucketed by filters.grain (default 'day').
 * Each bucket counts jobs whose created_at falls in the half-open bucket
 * [periodStart, periodEnd).
 */
export async function getJobsOverTime(
  ctx: AuthContext,
  filters: DashboardFilter,
  tx?: Tx,
): Promise<TimeSeriesPoint[]> {
  const { start, end } = bounds(filters.dateRange);
  const grain: TimeSeriesGrain = filters.grain ?? 'day';
  const run = async (db: Tx): Promise<TimeSeriesPoint[]> => {
    const res = await db.execute<{ bucket: Date; n: string }>(sql`
      select date_trunc(${grain}, created_at) as bucket, count(*) as n
      from jobs
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
  };
  return tx ? run(tx) : withAuthorizedDb(ctx, run);
}
