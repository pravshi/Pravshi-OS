/**
 * Phase 7 analytics — sales metrics.
 *
 * Metric contracts (from /tmp/phase7-metric-contracts.md):
 *  - Stage truth is public.pipeline_stages via deals.pipeline_stage_id — NEVER
 *    the legacy deals.stage text column. WON/LOST classification comes from the
 *    pipeline_stages.is_won / is_lost flags, so renamed stages still classify.
 *  - Money is NEVER summed across currencies: every money metric returns a
 *    per-currency map. Money values are numeric strings (Postgres numeric
 *    arrives as text; we keep it that way — no float precision loss), per the
 *    API convention used across the CRM services.
 *  - Every query scopes org_id to the session identity and excludes
 *    soft-deleted rows (deleted_at IS NULL). RLS via withAuthorizedDb() is
 *    defense-in-depth on top.
 *  - All joins are 1:1 (stage per deal, person per owner), so aggregates
 *    cannot double-count.
 *
 * Deliberate deviations, for the integration agent:
 *  1. The first parameter is `ctx: AuthContext` (session-derived), not a bare
 *     `orgId: string`. withAuthorizedDb() requires the full context
 *     (person_id / org_id / aal) to set the RLS session vars; fabricating one
 *     from orgId alone would corrupt the audit identity. orgId is always
 *     ctx.orgId — from the session, never from the request (see
 *     analytics/tenant.ts getAnalyticsContext + validateDashboardFilter).
 *  2. Money maps are Record<string, string | null> (numeric strings), not the
 *     foundation's MetricByCurrency = Record<string, number | null>, because
 *     the metric contracts mandate numeric strings for money per API
 *     conventions (numeric(19,4) precision safety).
 */

import { sql, type SQL } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { AuthContext } from '@/lib/db/context';
import type { DashboardFilter, DateRange, MetricResult } from './types';
import {
  andAll,
  countWhere,
  dateRangeFilter,
  notDeletedFilter,
  orgFilter,
  ratio,
  toMetricResult,
} from './sql';

/**
 * Money totals keyed by ISO currency code. Values are numeric strings;
 * null = deals exist in this currency but the total is unmeasurable
 * (every value NULL). An absent key = no deals in that currency.
 * NEVER summed across currencies.
 */
export type MoneyByCurrency = Record<string, string | null>;

/** One row of the deals-by-stage funnel. */
export type DealsByStageRow = {
  stageId: string;
  stageName: string;
  pipelineId: string;
  pipelineName: string;
  position: number;
  isWon: boolean;
  isLost: boolean;
  /** 0 is a real measurement here: the stage exists but holds no deals. */
  dealCount: number;
  valueByCurrency: MoneyByCurrency;
};

/** One row of the deals-by-owner leaderboard. */
export type DealsByOwnerRow = {
  /** null = unassigned deals bucket. */
  ownerPersonId: string | null;
  /** null when unassigned or the person row is gone/soft-deleted. */
  ownerName: string | null;
  dealCount: number;
  valueByCurrency: MoneyByCurrency;
};

/**
 * Standard scope for a deals alias: tenant + soft-delete + half-open
 * date range. Column fragments must be built by the caller (never from the
 * request) — e.g. sql`d.org_id`.
 */
function dealScope(
  ctx: AuthContext,
  orgCol: SQL,
  deletedCol: SQL,
  dateCol: SQL,
  range: DateRange,
): SQL {
  return andAll([
    orgFilter(orgCol, ctx.orgId),
    notDeletedFilter(deletedCol),
    dateRangeFilter(dateCol, range),
  ]);
}

/**
 * Deals created in the range, bucketed by their current pipeline stage.
 * One row per pipeline stage (including zero-deal stages, so funnels render
 * completely). Grouped by stage id rather than bare name so same-named stages
 * in different pipelines never merge.
 */
export async function getDealsByStage(
  ctx: AuthContext,
  filters: DashboardFilter,
): Promise<DealsByStageRow[]> {
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<DealsByStageRow>(sql`
      select
        ps.id as "stageId",
        ps.name as "stageName",
        ps.pipeline_id as "pipelineId",
        p.name as "pipelineName",
        ps.position,
        ps.is_won as "isWon",
        ps.is_lost as "isLost",
        count(d.id)::int as "dealCount",
        (
          select coalesce(jsonb_object_agg(sub.currency, sub.total), '{}'::jsonb)
          from (
            select d2.currency as currency, sum(d2.value)::text as total
            from public.deals d2
            where ${andAll([
              dealScope(
                ctx,
                sql`d2.org_id`,
                sql`d2.deleted_at`,
                sql`d2.created_at`,
                filters.dateRange,
              ),
              sql`d2.pipeline_stage_id = ps.id`,
            ])}
            group by d2.currency
          ) sub
        ) as "valueByCurrency"
      from public.pipeline_stages ps
      join public.pipelines p
        on p.id = ps.pipeline_id
       and p.org_id = ps.org_id
       and p.deleted_at is null
      left join public.deals d
        on d.pipeline_stage_id = ps.id
       and d.org_id = ps.org_id
       and d.deleted_at is null
       and ${dateRangeFilter(sql`d.created_at`, filters.dateRange)}
      where ${orgFilter(sql`ps.org_id`, ctx.orgId)}
      group by ps.id, ps.name, ps.pipeline_id, p.name, ps.position, ps.is_won, ps.is_lost
      having count(d.id) > 0
      order by p.name asc, ps.position asc, ps.id asc
    `);
    return res.rows;
  });
}

/**
 * SUM(value) by currency for OPEN deals (stage neither WON nor LOST),
 * created in the range. Never summed across currencies.
 */
export async function getPipelineValue(
  ctx: AuthContext,
  filters: DashboardFilter,
): Promise<MoneyByCurrency> {
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{ currency: string; total: string | null }>(sql`
      select d.currency as currency, sum(d.value)::text as total
      from public.deals d
      join public.pipeline_stages ps
        on ps.id = d.pipeline_stage_id
       and ps.org_id = d.org_id
      where ${andAll([
        dealScope(ctx, sql`d.org_id`, sql`d.deleted_at`, sql`d.created_at`, filters.dateRange),
        sql`not (ps.is_won or ps.is_lost)`,
      ])}
      group by d.currency
      order by d.currency asc
    `);
    const out: MoneyByCurrency = {};
    for (const row of res.rows) out[row.currency] = row.total;
    return out;
  });
}

/**
 * SUM(value) by currency for WON deals, using closed_at (not created_at)
 * for the date range. Never summed across currencies. Not to be confused
 * with pipeline_value (open deals).
 */
export async function getWonRevenue(
  ctx: AuthContext,
  filters: DashboardFilter,
): Promise<MoneyByCurrency> {
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{ currency: string; total: string | null }>(sql`
      select d.currency as currency, sum(d.value)::text as total
      from public.deals d
      join public.pipeline_stages ps
        on ps.id = d.pipeline_stage_id
       and ps.org_id = d.org_id
      where ${andAll([
        dealScope(ctx, sql`d.org_id`, sql`d.deleted_at`, sql`d.closed_at`, filters.dateRange),
        sql`ps.is_won`,
      ])}
      group by d.currency
      order by d.currency asc
    `);
    const out: MoneyByCurrency = {};
    for (const row of res.rows) out[row.currency] = row.total;
    return out;
  });
}

/**
 * COUNT(WON) / COUNT(WON + LOST) for deals closed in the range
 * (closed_at), as a 0–1 fraction. NULL when no deals were closed —
 * never 0, never Infinity.
 */
export async function getWinRate(
  ctx: AuthContext,
  filters: DashboardFilter,
): Promise<MetricResult> {
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{ winRate: string | null }>(sql`
      select ${ratio(countWhere(sql`ps.is_won`), countWhere(sql`ps.is_won or ps.is_lost`))} as "winRate"
      from public.deals d
      join public.pipeline_stages ps
        on ps.id = d.pipeline_stage_id
       and ps.org_id = d.org_id
      where ${dealScope(ctx, sql`d.org_id`, sql`d.deleted_at`, sql`d.closed_at`, filters.dateRange)}
    `);
    return toMetricResult(res.rows[0]?.winRate ?? null);
  });
}

/**
 * AVG(value) for WON deals closed in the range (closed_at), by currency.
 * NULL averages (all values NULL) stay null; they are not coerced to 0.
 */
export async function getAvgDealValue(
  ctx: AuthContext,
  filters: DashboardFilter,
): Promise<MoneyByCurrency> {
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{ currency: string; average: string | null }>(sql`
      select d.currency as currency, round(avg(d.value), 4)::text as average
      from public.deals d
      join public.pipeline_stages ps
        on ps.id = d.pipeline_stage_id
       and ps.org_id = d.org_id
      where ${andAll([
        dealScope(ctx, sql`d.org_id`, sql`d.deleted_at`, sql`d.closed_at`, filters.dateRange),
        sql`ps.is_won`,
      ])}
      group by d.currency
      order by d.currency asc
    `);
    const out: MoneyByCurrency = {};
    for (const row of res.rows) out[row.currency] = row.average;
    return out;
  });
}

/**
 * Deals created in the range grouped by owner_person_id, with the owner's
 * display name from public.people. Includes an unassigned bucket
 * (ownerPersonId null) for deals with no owner.
 */
export async function getDealsByOwner(
  ctx: AuthContext,
  filters: DashboardFilter,
): Promise<DealsByOwnerRow[]> {
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<DealsByOwnerRow>(sql`
      select
        d.owner_person_id as "ownerPersonId",
        p.full_legal_name as "ownerName",
        count(d.id)::int as "dealCount",
        (
          select coalesce(jsonb_object_agg(sub.currency, sub.total), '{}'::jsonb)
          from (
            select d2.currency as currency, sum(d2.value)::text as total
            from public.deals d2
            where ${andAll([
              dealScope(
                ctx,
                sql`d2.org_id`,
                sql`d2.deleted_at`,
                sql`d2.created_at`,
                filters.dateRange,
              ),
              sql`d2.owner_person_id is not distinct from d.owner_person_id`,
            ])}
            group by d2.currency
          ) sub
        ) as "valueByCurrency"
      from public.deals d
      left join public.people p
        on p.id = d.owner_person_id
       and p.org_id = d.org_id
       and p.deleted_at is null
      where ${dealScope(ctx, sql`d.org_id`, sql`d.deleted_at`, sql`d.created_at`, filters.dateRange)}
      group by d.owner_person_id, p.full_legal_name
      order by count(d.id) desc, p.full_legal_name asc nulls last
    `);
    return res.rows;
  });
}
