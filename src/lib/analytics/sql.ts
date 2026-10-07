/**
 * Phase 7 analytics — safe query builders.
 *
 * ANTI-INJECTION RULES:
 *  - Every VALUE is a bound parameter via drizzle's sql`` interpolation.
 *  - NO value is ever string-interpolated into SQL text.
 *  - Identifiers (table/column names) are never taken from callers. Builders
 *    accept drizzle SQL fragments (columns) or fixed allowlists only.
 *  - Dynamic ORDER BY / GROUP BY choices come from allowlists in this file.
 *
 * Conventions:
 *  - orgId is always bound as a parameter; org_id comparisons also rely on
 *    RLS (withAuthorizedDb) as defense-in-depth per the metric contracts.
 *  - Ranges are half-open [startInclusive, endExclusive) — matches the SQL
 *    `>= start AND < end` built here.
 *  - Ratios return NULL on zero denominator (never 0, never Infinity).
 */

import { sql, type SQL } from 'drizzle-orm';
import type { DateRange, TimeSeriesGrain } from './types';

/**
 * org_id = $1 — tenant isolation on top of RLS.
 * `column` must be a drizzle column/SQL fragment from your own code, never
 * from the request.
 */
export function orgFilter(column: SQL, orgId: string): SQL {
  return sql`${column} = ${orgId}`;
}

/**
 * Half-open date-range predicate: col >= startInclusive AND col < endExclusive.
 * Binds both bounds as parameters. Avoids the classic `BETWEEN` off-by-one
 * that double-counts midnight rows.
 */
export function dateRangeFilter(column: SQL, range: DateRange): SQL {
  return sql`${column} >= ${range.startInclusive} AND ${column} < ${range.endExclusive}`;
}

/** deleted_at IS NULL for the given timestamp column (soft-delete convention). */
export function notDeletedFilter(deletedAtColumn: SQL): SQL {
  return sql`${deletedAtColumn} IS NULL`;
}

/** Combine predicates with AND. Empty input returns SQL `true`. */
export function andAll(predicates: SQL[]): SQL {
  if (predicates.length === 0) return sql`true`;
  return sql.join(predicates, sql` AND `);
}

/**
 * Safe ratio: numerator / denominator, NULL when denominator is 0.
 * Pass already-bound SQL fragments (e.g. sql`count(*) filter (where ...)`).
 * Returns numeric; callers cast/format as needed.
 */
export function ratio(numerator: SQL, denominator: SQL): SQL {
  return sql`case when (${denominator}) = 0 then null else (${numerator})::numeric / nullif((${denominator}), 0) end`;
}

/** Count of rows matching a predicate. */
export function countWhere(predicate: SQL): SQL {
  return sql`count(*) filter (where ${predicate})`;
}

/** Sum of a numeric column over rows matching a predicate. */
export function sumWhere(column: SQL, predicate: SQL): SQL {
  return sql`sum(${column}) filter (where ${predicate})`;
}

/** Avg of a numeric column over rows matching a predicate. */
export function avgWhere(column: SQL, predicate: SQL): SQL {
  return sql`avg(${column}) filter (where ${predicate})`;
}

const GRAIN_TRUNC: Record<TimeSeriesGrain, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
};

/**
 * Bucket expression for time-series GROUP BY. The trunc unit comes from a
 * fixed allowlist keyed by grain — never from caller strings.
 */
export function bucketExpression(column: SQL, grain: TimeSeriesGrain): SQL {
  const unit = GRAIN_TRUNC[grain];
  if (!unit) throw new Error(`analytics: invalid grain: ${JSON.stringify(grain)}`);
  return sql`date_trunc(${unit}, ${column})`;
}

/**
 * Turn a metric row with a nullable value into `number | null`, guarding
 * against NaN/Infinity leaking out of the database (e.g. from float division
 * or bad casts). null stays null.
 */
export function toMetricResult(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Parse a numeric (Postgres numeric arrives as string) to number, or null.
 * Use for SUM/AVG results that must stay numeric in JS.
 */
export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : null;
}
