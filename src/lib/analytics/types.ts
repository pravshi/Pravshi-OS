/**
 * Phase 7 analytics — shared types.
 *
 * These are the contracts every metric agent builds on. Rules:
 *
 *   - Metric values are ALWAYS `number | null`. null means "no data / undefined",
 *     never 0. (0 is a real measurement: zero deals won is different from no
 *     deals closed.) Agents must propagate null, never convert it.
 *   - Money is never summed across currencies. Currency-bearing metrics return
 *     a per-currency map; see MetricByCurrency.
 *   - Every interval bound is a half-open [startInclusive, endExclusive) UTC
 *     instant. A record belongs to the range iff startInclusive <= ts < endExclusive.
 */

/** Presets a dashboard filter may request. Canonical home — re-used by date-ranges.ts. */
export type DateRangePreset =
  | 'TODAY'
  | 'LAST_7_DAYS'
  | 'LAST_30_DAYS'
  | 'THIS_MONTH'
  | 'LAST_MONTH'
  | 'THIS_QUARTER'
  | 'THIS_YEAR'
  | 'CUSTOM';

/** A resolved, timezone-aware date range. Bounds are UTC Date objects. */
export interface DateRange {
  /** The preset this range was resolved from. */
  preset: DateRangePreset;
  /** IANA timezone the calendar-day math was done in (e.g. 'Asia/Calcutta'). */
  timezone: string;
  /** First instant included (inclusive). */
  startInclusive: Date;
  /** First instant NOT included (exclusive). */
  endExclusive: Date;
}

/** Scalar metric result. null = undefined or no data (e.g. empty denominator). */
export type MetricResult = number | null;

/** Money metric grouped by ISO currency code. NEVER sum across currencies. */
export type MetricByCurrency = Record<string, number | null>;

/** One bucket of a time series. Bounds are the same half-open convention. */
export interface TimeSeriesPoint {
  /** Bucket start (inclusive), UTC. */
  periodStart: Date;
  /** Bucket end (exclusive), UTC. */
  periodEnd: Date;
  /** Bucket value; null when the bucket has no data. */
  value: MetricResult;
}

/** Grain options for time-series bucketing. */
export type TimeSeriesGrain = 'day' | 'week' | 'month';

/**
 * Filters every dashboard query accepts. orgId is DELIBERATELY ABSENT:
 * tenant identity comes from the session via tenant.ts, never from the request.
 */
export interface DashboardFilter {
  dateRange: DateRange;
  /** Optional grain for time-series views. */
  grain?: TimeSeriesGrain;
  /** Optional explicit comparison range; defaults to the previous equal-length period. */
  compareRange?: DateRange;
}
