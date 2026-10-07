/**
 * Phase 7 analytics — CRM metrics (leads, contacts, companies, activities).
 *
 * ── THE LEADS CONVENTION ─────────────────────────────────────────────────────
 * There is no leads table in Pravshi OS. A "lead" is defined as a deal sitting
 * in the NEW stage of its pipeline: leads = deals@NEW. Every function below
 * documents the convention, and dashboards should repeat it in UI copy so the
 * number is never mistaken for a separate lead entity.
 *
 * ── STAGE TRUTH ──────────────────────────────────────────────────────────────
 * Stage membership is read from public.pipeline_stages (joined on
 * deals.pipeline_stage_id), NEVER from the legacy deals.stage text column —
 * the same rule the sales metrics follow. A deal counts for a stage when its
 * pipeline_stage_id points at any stage row with that name in the org
 * (non-default pipelines included). Deals with pipeline_stage_id NULL are
 * invisible to stage-based counts (migration 0039 recovered unassigned deals,
 * so in practice this set is empty).
 *
 * ── SIGNATURES ───────────────────────────────────────────────────────────────
 * Every function takes (orgId, ctx, …): orgId first per the Phase 7 metric
 * contract; ctx second because withAuthorizedDb requires a real session
 * identity (personId/aal) for RLS — a bare orgId cannot fabricate one.
 * assertTenant() fail-closes when orgId !== ctx.orgId: callers thread
 * ctx.orgId (reconciled via validateDashboardFilter), never a request-supplied
 * tenant.
 *
 * ── QUERY PATTERNS ───────────────────────────────────────────────────────────
 * - org_id = ${orgId} first in every WHERE (defense in depth; RLS enforces it
 *   too via withAuthorizedDb).
 * - deleted_at IS NULL on every soft-deletable table. deal_stage_history is
 *   append-only (no deleted_at, no runtime delete path).
 * - Counts are cast ::int and returned as numbers; rates return null on empty
 *   denominators, never 0, NaN or Infinity.
 * - CRM metrics are counts and rates only — no money moves here, so unlike
 *   sales.ts there is no per-currency grouping.
 * - DateRange bounds are half-open [startInclusive, endExclusive) UTC instants;
 *   time-series buckets are UTC calendar boundaries (day/week/month).
 *
 * ── KNOWN LIMITATIONS ────────────────────────────────────────────────────────
 * 1. LEAD SOURCE ANALYTICS ARE IMPOSSIBLE. No source column exists on deals,
 *    companies, contacts or activities, so there is nothing to group by. This
 *    module does not synthesize, infer or invent source data — any "lead
 *    source" breakdown would be fiction.
 * 2. getLeadConversionRate is cohort-based: the QUALIFIED transition is not
 *    bounded by the range end (a lead created in the period may convert later
 *    and still counts).
 * 3. Activity volume buckets on activities.created_at (the logging instant),
 *    not the nullable occurred_at.
 */

import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { AuthContext } from '@/lib/db/context';
import { assertValidOrgId } from './tenant';
import type {
  DashboardFilter,
  DateRange,
  MetricResult,
  TimeSeriesGrain,
  TimeSeriesPoint,
} from './types';

/** Activity types from the activities_type CHECK constraint (0034). */
export type ActivityType = 'CALL' | 'EMAIL' | 'MEETING' | 'NOTE';

/** Snapshot + inflow counts for the leads = deals@NEW convention. */
export interface LeadCounts {
  /** Deals currently sitting in the NEW stage (point-in-time snapshot, not period-bounded). */
  totalLeads: number;
  /** Deals created into NEW during the filter's date range (the conversion-rate denominator). */
  newLeads: number;
  /** Deals currently sitting in the QUALIFIED stage (point-in-time snapshot, not period-bounded). */
  qualifiedLeads: number;
}

/** One bucket of activity volume: every type is present in every bucket (zeros included). */
export interface ActivityVolumeBucket {
  /** Bucket start (inclusive), UTC. */
  periodStart: Date;
  /** Bucket end (exclusive), UTC. */
  periodEnd: Date;
  type: ActivityType;
  count: number;
}

/**
 * Fail-closed tenant check: the orgId argument must be a valid UUID and must
 * equal the session context's orgId. A mismatch is a caller bug or a smuggled
 * tenant — never silently substituted.
 */
function assertTenant(orgId: string, ctx: AuthContext): void {
  assertValidOrgId(orgId);
  if (orgId !== ctx.orgId) {
    throw new Error('analytics/crm: orgId argument does not match session orgId');
  }
}

type SeriesRow = {
  period_start: string;
  period_end: string;
  value: number;
};

function toTimeSeriesPoint(r: SeriesRow): TimeSeriesPoint {
  return {
    periodStart: new Date(r.period_start),
    periodEnd: new Date(r.period_end),
    // Empty buckets are 0 (a real measurement), never null.
    value: Number(r.value ?? 0),
  };
}

/**
 * Shared bucket CTE: emits one row per grain bucket covering
 * [startInclusive, endExclusive). Compose as `with ${seriesBuckets(...)}`.
 */
function seriesBuckets(dateRange: DateRange, grain: TimeSeriesGrain) {
  const { startInclusive, endExclusive } = dateRange;
  return sql`
    params as (
      select
        date_trunc(${grain}, ${startInclusive}::timestamptz) as series_start,
        ${endExclusive}::timestamptz as range_end,
        case ${grain}
          when 'day' then interval '1 day'
          when 'week' then interval '1 week'
          else interval '1 month'
        end as step
    ),
    buckets as (
      select
        gs.bucket as period_start,
        gs.bucket + (select step from params) as period_end
      from params,
        generate_series(
          (select series_start from params),
          (select range_end from params),
          (select step from params)
        ) as gs(bucket)
      where gs.bucket < (select range_end from params)
    )
  `;
}

/**
 * Counts of leads under the leads = deals@NEW convention.
 *
 * - totalLeads: deals currently in NEW (snapshot).
 * - newLeads: deals whose creation history row (from_stage_id NULL, written by
 *   the deals_record_stage_history trigger) targeted NEW, with changed_at in
 *   the filter's date range. A deal created straight into another stage was
 *   never a lead and is excluded — this is exactly the conversion-rate
 *   denominator, so the two metrics stay consistent.
 * - qualifiedLeads: deals currently in QUALIFIED (snapshot).
 */
export async function getLeadCounts(
  orgId: string,
  ctx: AuthContext,
  filters: DashboardFilter,
): Promise<LeadCounts> {
  assertTenant(orgId, ctx);
  const { startInclusive, endExclusive } = filters.dateRange;
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{
      total_leads: number;
      new_leads: number;
      qualified_leads: number;
    }>(sql`
      with
        new_stage as (
          select id from pipeline_stages where org_id = ${orgId} and name = 'NEW'
        ),
        qualified_stage as (
          select id from pipeline_stages where org_id = ${orgId} and name = 'QUALIFIED'
        )
      select
        (select count(*)::int
         from deals d
         where d.org_id = ${orgId}
           and d.deleted_at is null
           and d.pipeline_stage_id in (select id from new_stage)
        ) as total_leads,
        (select count(*)::int
         from deals d
         join deal_stage_history h
           on h.deal_id = d.id
           and h.org_id = d.org_id
           and h.from_stage_id is null
         where d.org_id = ${orgId}
           and d.deleted_at is null
           and h.to_stage_id in (select id from new_stage)
           and h.changed_at >= ${startInclusive}::timestamptz
           and h.changed_at < ${endExclusive}::timestamptz
        ) as new_leads,
        (select count(*)::int
         from deals d
         where d.org_id = ${orgId}
           and d.deleted_at is null
           and d.pipeline_stage_id in (select id from qualified_stage)
        ) as qualified_leads
    `);
    const r = res.rows[0];
    return {
      totalLeads: Number(r?.total_leads ?? 0),
      newLeads: Number(r?.new_leads ?? 0),
      qualifiedLeads: Number(r?.qualified_leads ?? 0),
    };
  });
}

/**
 * Lead conversion rate: deals reaching QUALIFIED / deals created as NEW.
 *
 * Cohort-based: the denominator is deals created into NEW within the date
 * range (same definition as getLeadCounts().newLeads); the numerator is the
 * distinct deals of that cohort having a deal_stage_history transition into
 * QUALIFIED at or after their creation instant. The transition is deliberately
 * NOT bounded by the range end — a lead created in the period may convert
 * later and still counts as converted.
 *
 * Returns null when no leads were created in the range (empty denominator),
 * never 0 or Infinity.
 */
export async function getLeadConversionRate(
  orgId: string,
  ctx: AuthContext,
  dateRange: DateRange,
): Promise<MetricResult> {
  assertTenant(orgId, ctx);
  const { startInclusive, endExclusive } = dateRange;
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{ numerator: number; denominator: number }>(sql`
      with cohort as (
        select d.id, h.changed_at as created_at
        from deals d
        join deal_stage_history h
          on h.deal_id = d.id
          and h.org_id = d.org_id
          and h.from_stage_id is null
        where d.org_id = ${orgId}
          and d.deleted_at is null
          and h.to_stage_id in (
            select id from pipeline_stages where org_id = ${orgId} and name = 'NEW'
          )
          and h.changed_at >= ${startInclusive}::timestamptz
          and h.changed_at < ${endExclusive}::timestamptz
      ),
      converted as (
        select distinct c.id
        from cohort c
        join deal_stage_history q
          on q.deal_id = c.id
          and q.org_id = ${orgId}
          and q.changed_at >= c.created_at
        where q.to_stage_id in (
          select id from pipeline_stages where org_id = ${orgId} and name = 'QUALIFIED'
        )
      )
      select
        (select count(*)::int from converted) as numerator,
        (select count(*)::int from cohort) as denominator
    `);
    const r = res.rows[0];
    const denominator = Number(r?.denominator ?? 0);
    if (denominator === 0) return null;
    return Number(r?.numerator ?? 0) / denominator;
  });
}

/**
 * Contacts created over time, bucketed by grain (default 'day').
 * Soft-deleted contacts excluded; date field is contacts.created_at.
 */
export async function getContactGrowth(
  orgId: string,
  ctx: AuthContext,
  dateRange: DateRange,
  grain: TimeSeriesGrain = 'day',
): Promise<TimeSeriesPoint[]> {
  return getCreatedSeries(orgId, ctx, 'contacts', dateRange, grain);
}

/**
 * Companies created over time, bucketed by grain (default 'day').
 * Soft-deleted companies excluded; date field is companies.created_at.
 */
export async function getCompanyGrowth(
  orgId: string,
  ctx: AuthContext,
  dateRange: DateRange,
  grain: TimeSeriesGrain = 'day',
): Promise<TimeSeriesPoint[]> {
  return getCreatedSeries(orgId, ctx, 'companies', dateRange, grain);
}

/**
 * Activity volume: counts grouped by activity type and date bucket.
 * Every type (CALL, EMAIL, MEETING, NOTE) appears in every bucket, zeros
 * included, so stacked charts need no re-indexing. Soft-deleted activities
 * excluded; date field is activities.created_at (the logging instant).
 */
export async function getActivityVolume(
  orgId: string,
  ctx: AuthContext,
  dateRange: DateRange,
  grain: TimeSeriesGrain = 'day',
): Promise<ActivityVolumeBucket[]> {
  assertTenant(orgId, ctx);
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{
      period_start: string;
      period_end: string;
      type: string;
      value: number;
    }>(sql`
      with ${seriesBuckets(dateRange, grain)}
      select b.period_start, b.period_end, at.type, count(a.id)::int as value
      from buckets b
      cross join (values ('CALL'), ('EMAIL'), ('MEETING'), ('NOTE')) as at(type)
      left join activities a
        on a.org_id = ${orgId}
        and a.deleted_at is null
        and a.type = at.type
        and date_trunc(${grain}, a.created_at) = b.period_start
      group by b.period_start, b.period_end, at.type
      order by b.period_start, at.type
    `);
    return res.rows.map((r) => ({
      periodStart: new Date(r.period_start),
      periodEnd: new Date(r.period_end),
      type: r.type as ActivityType,
      count: Number(r.value ?? 0),
    }));
  });
}

/** Shared created_at time-series for the soft-deleted CRM entity tables. */
async function getCreatedSeries(
  orgId: string,
  ctx: AuthContext,
  table: 'contacts' | 'companies',
  dateRange: DateRange,
  grain: TimeSeriesGrain,
): Promise<TimeSeriesPoint[]> {
  assertTenant(orgId, ctx);
  // Constant identifiers only — never caller input.
  const tableIdent = table === 'contacts' ? sql`contacts` : sql`companies`;
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<SeriesRow>(sql`
      with ${seriesBuckets(dateRange, grain)}
      select b.period_start, b.period_end, count(t.id)::int as value
      from buckets b
      left join ${tableIdent} t
        on t.org_id = ${orgId}
        and t.deleted_at is null
        and date_trunc(${grain}, t.created_at) = b.period_start
      group by b.period_start, b.period_end
      order by b.period_start
    `);
    return res.rows.map(toTimeSeriesPoint);
  });
}
