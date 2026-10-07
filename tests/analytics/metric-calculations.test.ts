import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { bucketExpression, toMetricResult, toNumberOrNull } from '@/lib/analytics/sql';
import { assertValidOrgId, reconcileOrgId, validateDashboardFilter } from '@/lib/analytics/tenant';
import { resolveDateRange } from '@/lib/analytics/date-ranges';
import type { DashboardFilter, DateRange, MetricResult } from '@/lib/analytics/types';
import type { AuthContext } from '@/lib/db/context';
import type { MoneyByCurrency } from '@/lib/analytics/sales';
import type { LeadCounts } from '@/lib/analytics/crm';
import {
  ANALYTICS_PERMS,
  CODE,
  makeCtx,
  mkDeal,
  mkDept,
  mkEngagement,
  mkOrg,
  mkPerson,
  mkPipeline,
  mkRoleFor,
  mkStage,
  moveDealToStage,
  owner,
  setHistoryChangedAt,
} from './helpers';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

/**
 * Phase 7 — metric formula unit tests.
 *
 * Two layers, no mocks anywhere:
 *
 *  A. PURE unit tests (no DB): the null/NaN/Infinity guards every metric
 *     funnels through (toMetricResult / toNumberOrNull), the grain allowlist,
 *     and the tenant.ts validation (reconcileOrgId, assertValidOrgId,
 *     validateDashboardFilter). These run everywhere.
 *
 *  B. DB-BACKED formula tests (CI: DATABASE_URL_TEST/DATABASE_URL_MIGRATE):
 *     real metric functions against real transactions with controlled
 *     fixtures — win rate, lead conversion, per-currency separation, empty
 *     denominators, half-open boundaries, soft-delete exclusion.
 *
 * Metric contracts pinned (src/lib/analytics/types.ts):
 *  - Metric values are `number | null`. null = no data / undefined, NEVER 0.
 *  - Money is NEVER summed across currencies: per-currency maps only.
 *  - Ratios are NULL on empty denominators — never 0, never Infinity.
 */

// ── A. pure unit tests ───────────────────────────────────────────────────────

describe('toMetricResult', () => {
  it('passes null and undefined through as null', () => {
    expect(toMetricResult(null)).toBeNull();
    expect(toMetricResult(undefined)).toBeNull();
  });

  it('keeps 0 as a real measurement (not null)', () => {
    expect(toMetricResult(0)).toBe(0);
    expect(toMetricResult('0')).toBe(0);
  });

  it('parses Postgres numeric strings (ratios arrive as text)', () => {
    expect(toMetricResult('0.66666666666666666667')).toBeCloseTo(2 / 3, 10);
    expect(toMetricResult('1')).toBe(1);
  });

  it('passes finite numbers through', () => {
    expect(toMetricResult(0.5)).toBe(0.5);
    expect(toMetricResult(42)).toBe(42);
  });

  it('guards NaN and Infinity back to null — they must never leak to the API', () => {
    expect(toMetricResult(NaN)).toBeNull();
    expect(toMetricResult(Infinity)).toBeNull();
    expect(toMetricResult(-Infinity)).toBeNull();
    expect(toMetricResult('Infinity')).toBeNull();
    expect(toMetricResult('not-a-number')).toBeNull();
  });
});

describe('toNumberOrNull', () => {
  it('parses numeric strings and passes numbers through', () => {
    expect(toNumberOrNull('123.45')).toBe(123.45);
    expect(toNumberOrNull('3000.0000')).toBe(3000);
    expect(toNumberOrNull(7)).toBe(7);
    expect(toNumberOrNull(0)).toBe(0);
  });

  it('returns null for null, undefined and non-numeric input', () => {
    expect(toNumberOrNull(null)).toBeNull();
    expect(toNumberOrNull(undefined)).toBeNull();
    expect(toNumberOrNull('abc')).toBeNull();
    expect(toNumberOrNull(NaN)).toBeNull();
  });
});

describe('bucketExpression grain allowlist', () => {
  it('rejects grains outside the fixed allowlist', () => {
    expect(() => bucketExpression(sql`created_at`, 'hour' as never)).toThrow(
      /analytics: invalid grain/,
    );
    expect(() => bucketExpression(sql`created_at`, '' as never)).toThrow(
      /analytics: invalid grain/,
    );
  });
});

describe('reconcileOrgId', () => {
  const SESSION = '11111111-1111-4111-8111-111111111111';

  it('ignores an absent smuggled orgId and uses the session', () => {
    expect(reconcileOrgId(SESSION, undefined)).toBe(SESSION);
    expect(reconcileOrgId(SESSION, null)).toBe(SESSION);
    expect(reconcileOrgId(SESSION, '')).toBe(SESSION);
  });

  it('accepts a matching smuggled orgId', () => {
    expect(reconcileOrgId(SESSION, SESSION)).toBe(SESSION);
  });

  it('rejects a mismatching smuggled orgId loudly — never silently substitutes', () => {
    expect(() => reconcileOrgId(SESSION, '22222222-2222-4222-8222-222222222222')).toThrow(
      /does not match session orgId/,
    );
  });
});

describe('assertValidOrgId', () => {
  it('accepts a well-formed UUID', () => {
    expect(() => assertValidOrgId('11111111-1111-4111-8111-111111111111')).not.toThrow();
  });

  it('rejects non-UUID values', () => {
    expect(() => assertValidOrgId('not-a-uuid')).toThrow(/invalid orgId/);
    expect(() => assertValidOrgId('')).toThrow(/invalid orgId/);
    expect(() => assertValidOrgId(null)).toThrow(/invalid orgId/);
    expect(() => assertValidOrgId(42)).toThrow(/invalid orgId/);
  });
});

describe('validateDashboardFilter', () => {
  const SESSION = '11111111-1111-4111-8111-111111111111';
  const NOW = new Date('2026-10-07T04:30:00.000Z');

  it('defaults to LAST_30_DAYS in Asia/Calcutta', () => {
    const { filter, orgId } = validateDashboardFilter({}, SESSION, NOW);
    expect(orgId).toBe(SESSION);
    expect(filter.dateRange.preset).toBe('LAST_30_DAYS');
    expect(filter.dateRange.timezone).toBe('Asia/Calcutta');
    expect(filter.grain).toBeUndefined();
    expect(filter.compareRange).toBeUndefined();
  });

  it('resolves an explicit preset and grain', () => {
    const { filter } = validateDashboardFilter(
      { preset: 'TODAY', grain: 'day', timezone: 'UTC' },
      SESSION,
      NOW,
    );
    expect(filter.dateRange.preset).toBe('TODAY');
    expect(filter.dateRange.timezone).toBe('UTC');
    expect(filter.grain).toBe('day');
  });

  it('rejects an unknown preset', () => {
    expect(() => validateDashboardFilter({ preset: 'LAST_FORTNIGHT' }, SESSION, NOW)).toThrow(
      /invalid preset/,
    );
  });

  it('rejects an unknown grain', () => {
    expect(() => validateDashboardFilter({ grain: 'hour' }, SESSION, NOW)).toThrow(/invalid grain/);
  });

  it('rejects an invalid timezone', () => {
    expect(() => validateDashboardFilter({ timezone: 'Mars/Olympus' }, SESSION, NOW)).toThrow(
      /invalid IANA timezone/,
    );
  });

  it('rejects a bad CUSTOM range (start after end)', () => {
    expect(() =>
      validateDashboardFilter(
        { preset: 'CUSTOM', customStart: '2026-10-08', customEnd: '2026-10-07' },
        SESSION,
        NOW,
      ),
    ).toThrow(/must not be after/);
  });

  it('rejects a mismatched smuggled orgId; threads the session orgId otherwise', () => {
    expect(() =>
      validateDashboardFilter({ orgId: '22222222-2222-4222-8222-222222222222' }, SESSION, NOW),
    ).toThrow(/does not match session orgId/);
    const { orgId } = validateDashboardFilter({ orgId: SESSION }, SESSION, NOW);
    expect(orgId).toBe(SESSION);
  });

  it('resolves an explicit compare range', () => {
    const { filter } = validateDashboardFilter(
      { preset: 'THIS_MONTH', comparePreset: 'LAST_MONTH' },
      SESSION,
      NOW,
    );
    expect(filter.compareRange?.preset).toBe('LAST_MONTH');
    expect(filter.compareRange!.endExclusive.getTime()).toBe(
      filter.dateRange.startInclusive.getTime(),
    );
  });

  it('rejects an invalid comparePreset', () => {
    expect(() => validateDashboardFilter({ comparePreset: 'SOMETIME' }, SESSION, NOW)).toThrow(
      /invalid comparePreset/,
    );
  });
});

// ── B. DB-backed formula tests ───────────────────────────────────────────────
//
// Fixture map (single org). closed_at values are UTC-noon-anchored so CUSTOM
// calendar-date windows are unambiguous and deterministic.
//
//   stages: NEW(0) QUALIFIED(1) PROPOSAL(2) WON(3, is_won) LOST(4, is_lost)
//   d1  WON      INR 1000  closed noon 9d ago   → win, revenue
//   d2  WON      INR 2000  closed noon 8d ago   → win, revenue
//   d3  LOST     INR 5000  closed noon 7d ago   → loss
//   d4  PROPOSAL INR 3000  created 10d ago      → pipeline value
//   d5  PROPOSAL USD 700   created 10d ago      → pipeline value, currency split
//   d6  WON      EUR null  closed noon 6d ago   → win; avg stays null for EUR
//   d7  WON      INR 4000  closed noon 40d ago  → out of range, excluded
//   d8  WON      INR 9000  closed noon 5d ago, DELETED → excluded everywhere
//   d9  NEW→QUALIFIED INR 100, created noon 5d ago → lead, converted
//   d10 NEW      INR 100, created noon 5d ago   → lead, not converted
//   d11 PROPOSAL (created straight in) 5d ago   → never a lead, not in cohort
//   d12 NEW      created noon 40d ago           → out of range cohort
//   d13 PROPOSAL EUR null, created 10d ago      → pipeline value {EUR: null}
//   d14 NEW      INR 100, created 10d ago       → lead (unconverted), pipeline value
//   d15 PROPOSAL INR 1, created exactly at range end   → boundary: excluded
//   d16 PROPOSAL INR 1, created exactly at range start → boundary: included
//
// The trigger-written creation history rows are backdated to each deal's
// created_at so "created into NEW in the range" is truthful.
//
// NOTE: legacy deals.stage text keeps its 'NEW' default — stage truth comes
// from pipeline_stages.is_won/is_lost, which is exactly what these tests pin.

// Metric-function imports are dynamic so this file collects (and its pure
// section runs) on a plain `pnpm test` without credentials — the lib import
// chain validates env at import time. In CI, run with DATABASE_URL_TEST
// (pooled) and DATABASE_URL_MIGRATE (direct, app_owner).
describe.skipIf(!HAS_DB)('metric formulas against real transactions', () => {
  const NOW = new Date();
  const ago = (days: number) => new Date(NOW.getTime() - days * 24 * 3600_000);
  /** UTC noon of the calendar date n days ago — midnight-safe for CUSTOM windows. */
  const noon = (days: number) => {
    const d = ago(days);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0));
  };
  /** YYYY-MM-DD of a Date in UTC (CUSTOM ranges take calendar dates). */
  const isoDay = (d: Date) => d.toISOString().slice(0, 10);

  let orgId = '';
  let ctx: AuthContext;
  let won = '';
  let lost = '';
  let newStage = '';
  let qualified = '';
  let proposal = '';
  let range: DateRange;

  // Dynamically imported metric functions (see note above).
  let getWinRate: (ctx: AuthContext, filters: DashboardFilter) => Promise<MetricResult>;
  let getPipelineValue: (ctx: AuthContext, filters: DashboardFilter) => Promise<MoneyByCurrency>;
  let getWonRevenue: (ctx: AuthContext, filters: DashboardFilter) => Promise<MoneyByCurrency>;
  let getAvgDealValue: (ctx: AuthContext, filters: DashboardFilter) => Promise<MoneyByCurrency>;
  let getLeadConversionRate: (
    orgId: string,
    ctx: AuthContext,
    dateRange: DateRange,
  ) => Promise<MetricResult>;
  let getLeadCounts: (
    orgId: string,
    ctx: AuthContext,
    filters: DashboardFilter,
  ) => Promise<LeadCounts>;

  const filterFor = (r: DateRange): DashboardFilter => ({ dateRange: r });

  beforeAll(async () => {
    ({ getWinRate, getPipelineValue, getWonRevenue, getAvgDealValue } =
      await import('@/lib/analytics/sales'));
    ({ getLeadConversionRate, getLeadCounts } = await import('@/lib/analytics/crm'));

    orgId = await mkOrg(`mcalc-${CODE}`);
    const dept = await mkDept(orgId, `${CODE}_MC`);
    const person = await mkPerson(orgId, 'Mcalc User');
    await mkEngagement(orgId, person, dept);
    await mkRoleFor(orgId, person, `${CODE}_MC_FULL`, ANALYTICS_PERMS);
    ctx = makeCtx(person, orgId);

    const pipe = await mkPipeline(orgId, `Mcalc Pipe ${CODE}`);
    newStage = await mkStage(orgId, pipe, 'NEW', 0);
    qualified = await mkStage(orgId, pipe, 'QUALIFIED', 1);
    proposal = await mkStage(orgId, pipe, 'PROPOSAL', 2);
    won = await mkStage(orgId, pipe, 'WON', 3, { isWon: true });
    lost = await mkStage(orgId, pipe, 'LOST', 4, { isLost: true });

    range = resolveDateRange('LAST_30_DAYS', { now: NOW });

    // Seed a deal and backdate its trigger-written creation history row to the
    // deal's created_at, so history-based metrics see the truthful instant.
    const seed = async (
      title: string,
      stage: string,
      opts: {
        value?: string | null;
        currency?: string;
        createdAt?: Date;
        closedAt?: Date | null;
        deletedAt?: Date | null;
      } = {},
    ) => {
      const createdAt = opts.createdAt ?? NOW;
      const id = await mkDeal(orgId, person, title, pipe, { stage, ...opts, createdAt });
      await setHistoryChangedAt(id, createdAt);
      return id;
    };

    await seed(`d1 ${CODE}`, won, {
      value: '1000',
      currency: 'INR',
      createdAt: ago(10),
      closedAt: noon(9),
    });
    await seed(`d2 ${CODE}`, won, {
      value: '2000',
      currency: 'INR',
      createdAt: ago(10),
      closedAt: noon(8),
    });
    await seed(`d3 ${CODE}`, lost, {
      value: '5000',
      currency: 'INR',
      createdAt: ago(10),
      closedAt: noon(7),
    });
    await seed(`d4 ${CODE}`, proposal, { value: '3000', currency: 'INR', createdAt: ago(10) });
    await seed(`d5 ${CODE}`, proposal, { value: '700', currency: 'USD', createdAt: ago(10) });
    await seed(`d6 ${CODE}`, won, {
      value: null,
      currency: 'EUR',
      createdAt: ago(10),
      closedAt: noon(6),
    });
    await seed(`d7 ${CODE}`, won, {
      value: '4000',
      currency: 'INR',
      createdAt: ago(45),
      closedAt: noon(40),
    });
    await seed(`d8 ${CODE}`, won, {
      value: '9000',
      currency: 'INR',
      createdAt: ago(10),
      closedAt: noon(5),
      deletedAt: ago(4),
    });

    // Lead cohort: d9 converts, d10/d14 do not, d11 was never a lead, d12 stale.
    const d9 = await seed(`d9 ${CODE}`, newStage, {
      value: '100',
      currency: 'INR',
      createdAt: noon(5),
    });
    await seed(`d10 ${CODE}`, newStage, { value: '100', currency: 'INR', createdAt: noon(5) });
    await seed(`d11 ${CODE}`, proposal, { value: null, currency: 'INR', createdAt: ago(5) });
    await seed(`d12 ${CODE}`, newStage, { value: null, currency: 'INR', createdAt: noon(40) });
    // d9 converts NEW → QUALIFIED (transition lands "now").
    await moveDealToStage(d9, qualified);

    await seed(`d13 ${CODE}`, proposal, { value: null, currency: 'EUR', createdAt: ago(10) });
    await seed(`d14 ${CODE}`, newStage, { value: '100', currency: 'INR', createdAt: ago(10) });

    // Half-open boundary probes on created_at.
    await seed(`d15 ${CODE}`, proposal, {
      value: '1',
      currency: 'INR',
      createdAt: range.endExclusive,
    });
    await seed(`d16 ${CODE}`, proposal, {
      value: '1',
      currency: 'INR',
      createdAt: range.startInclusive,
    });
  }, 60_000);

  afterAll(async () => {
    await owner.end();
  });

  describe('getWinRate', () => {
    it('computes WON / (WON + LOST) for deals closed in the range', async () => {
      // d1, d2, d6 won; d3 lost → 3/4. d7 out of range, d8 soft-deleted.
      await expect(getWinRate(ctx, filterFor(range))).resolves.toBeCloseTo(0.75, 10);
    });

    it('classifies by pipeline_stages.is_won/is_lost — not the legacy stage text', async () => {
      // Every fixture keeps the legacy deals.stage default ('NEW'); the 0.75
      // above already proves classification came from the stage flags. This
      // window holds only d1 and d2 (both WON) → 2/2 = 1.
      const r = resolveDateRange('CUSTOM', {
        customStart: isoDay(noon(9)),
        customEnd: isoDay(noon(8)),
        now: NOW,
      });
      await expect(getWinRate(ctx, filterFor(r))).resolves.toBe(1);
    });

    it('returns 0 (a real measurement) when every closed deal was lost', async () => {
      const r = resolveDateRange('CUSTOM', {
        customStart: isoDay(noon(7)),
        customEnd: isoDay(noon(7)),
        now: NOW,
      });
      // Only d3 (lost) closed on this date → 0/1 = 0, not null.
      await expect(getWinRate(ctx, filterFor(r))).resolves.toBe(0);
    });

    it('returns null — never 0, never Infinity — on an empty denominator', async () => {
      const r = resolveDateRange('CUSTOM', {
        customStart: '2020-01-01',
        customEnd: '2020-01-02',
        now: NOW,
      });
      await expect(getWinRate(ctx, filterFor(r))).resolves.toBeNull();
    });
  });

  describe('getLeadConversionRate', () => {
    it('computes converted / created-into-NEW for the cohort', async () => {
      // d9, d10, d14 created into NEW in range; d9 converted → 1/3.
      // d11 (created into PROPOSAL) and d12 (stale) are not in the cohort.
      await expect(getLeadConversionRate(orgId, ctx, range)).resolves.toBeCloseTo(1 / 3, 10);
    });

    it('counts a conversion that lands AFTER the range end (cohort-based)', async () => {
      // d9 converted "now"; this range ended ~2 days ago — the QUALIFIED
      // transition is deliberately NOT bounded by the range end.
      const r = resolveDateRange('CUSTOM', {
        customStart: isoDay(ago(10)),
        customEnd: isoDay(ago(2)),
        now: NOW,
      });
      await expect(getLeadConversionRate(orgId, ctx, r)).resolves.toBeCloseTo(1 / 3, 10);
    });

    it('returns null on an empty cohort', async () => {
      const r = resolveDateRange('CUSTOM', {
        customStart: '2020-01-01',
        customEnd: '2020-01-02',
        now: NOW,
      });
      await expect(getLeadConversionRate(orgId, ctx, r)).resolves.toBeNull();
    });

    it('stays consistent with getLeadCounts().newLeads (same cohort definition)', async () => {
      const counts = await getLeadCounts(orgId, ctx, filterFor(range));
      // d9 + d10 + d14 created into NEW in range.
      // d11 (PROPOSAL), d12 (stale), d15 (at endExclusive) excluded.
      expect(counts.newLeads).toBe(3);
    });
  });

  describe('currency separation', () => {
    it('getPipelineValue keeps one total per currency and never merges them', async () => {
      const v = await getPipelineValue(ctx, filterFor(range));
      // Open deals created in range: d4 INR 3000, d5 USD 700, d9 INR 100,
      // d10 INR 100, d11 INR null, d13 EUR null, d14 INR 100, d16 INR 1
      // (range start, inclusive). d15 (range end) excluded; d12 out of range.
      expect(v).toEqual({
        EUR: null, // deals exist but every value is NULL → null, not 0, not absent
        INR: '3301.0000', // 3000 + 100 + 100 + 100 + 1 — never mixed with USD
        USD: '700.0000',
      });
      expect(Object.keys(v).sort()).toEqual(['EUR', 'INR', 'USD']);
    });

    it('getPipelineValue excludes WON/LOST deals (open pipeline only)', async () => {
      const v = await getPipelineValue(ctx, filterFor(range));
      // d1/d2 (INR 1000+2000, WON) would have added 3000 to INR had they leaked.
      expect(v['INR']).toBe('3301.0000');
    });

    it('getWonRevenue sums only WON deals closed in the range, per currency', async () => {
      const v = await getWonRevenue(ctx, filterFor(range));
      // d1 INR 1000 + d2 INR 2000; d6 EUR null; d7 out of range; d8 deleted.
      expect(v).toEqual({ EUR: null, INR: '3000.0000' });
    });

    it('getAvgDealValue averages per currency and keeps null averages null', async () => {
      const v = await getAvgDealValue(ctx, filterFor(range));
      expect(v).toEqual({ EUR: null, INR: '1500.0000' });
    });
  });

  describe('range boundaries and soft deletes', () => {
    it('excludes a deal created exactly at endExclusive (half-open)', async () => {
      const v = await getPipelineValue(ctx, filterFor(range));
      // d15 (INR 1 at endExclusive) must not contribute: INR stays 3301.
      expect(v['INR']).toBe('3301.0000');
    });

    it('includes a deal created exactly at startInclusive', async () => {
      const v = await getPipelineValue(ctx, filterFor(range));
      // d16 (INR 1 at startInclusive) IS included in the 3301 total.
      expect(v['INR']).toBe('3301.0000');
    });

    it('excludes soft-deleted deals from every metric', async () => {
      // d8: WON, INR 9000, closed in range, then soft-deleted.
      const rev = await getWonRevenue(ctx, filterFor(range));
      expect(rev['INR']).toBe('3000.0000'); // not 12000
      await expect(getWinRate(ctx, filterFor(range))).resolves.toBeCloseTo(0.75, 10); // not 4/5
    });
  });
});
