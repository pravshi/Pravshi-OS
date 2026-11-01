/**
 * Phase 7 analytics — centralized, timezone-aware date range handling.
 *
 * ── CONVENTIONS (read before using) ──────────────────────────────────────────
 *
 * 1. Every range is half-open: [startInclusive, endExclusive). A row with
 *    timestamp t belongs iff startInclusive <= t < endExclusive.
 * 2. "Day" boundaries are calendar days in the given IANA timezone, resolved to
 *    exact UTC instants. DST transitions are handled: a 23- or 25-hour local day
 *    produces a 23- or 25-hour UTC range, never a shifted window.
 * 3. LAST_7_DAYS = today plus the previous 6 calendar days (7 days total).
 *    LAST_30_DAYS = today plus the previous 29 calendar days (30 days total).
 * 4. CUSTOM takes ISO calendar dates (YYYY-MM-DD); the end date is INCLUSIVE of
 *    that whole local day. start must be <= end.
 *
 * Timezone: every function takes an IANA tz. Callers (tenant.ts validation,
 * API routes) pass the org's display timezone; default 'Asia/Calcutta' matches
 * the operating timezone of this deployment.
 */

import type { DateRange, DateRangePreset } from './types';

/** All valid presets, in UI order. */
export const DATE_RANGE_PRESETS: readonly DateRangePreset[] = [
  'TODAY',
  'LAST_7_DAYS',
  'LAST_30_DAYS',
  'THIS_MONTH',
  'LAST_MONTH',
  'THIS_QUARTER',
  'THIS_YEAR',
  'CUSTOM',
] as const;

export const DEFAULT_TIMEZONE = 'Asia/Calcutta';

export interface ResolveDateRangeOptions {
  /** IANA timezone for calendar-day math. Defaults to Asia/Calcutta. */
  timezone?: string;
  /** Reference instant; defaults to now. Useful for tests. */
  now?: Date;
  /** Required when preset === 'CUSTOM'. ISO calendar date YYYY-MM-DD. */
  customStart?: string;
  /** Required when preset === 'CUSTOM'. ISO calendar date YYYY-MM-DD, inclusive. */
  customEnd?: string;
}

/** Offset in milliseconds that `timeZone` is ahead of UTC at `instant`. */
function tzOffsetMs(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - instant.getTime();
}

/** Calendar y/m/d components of `instant` as seen in `timeZone`. */
function localParts(instant: Date, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '1');
  return { y: get('year'), m: get('month'), d: get('day') };
}

/**
 * UTC instant of local midnight for the given wall-clock calendar date in
 * `timeZone`. Iterates twice so DST transitions converge to the exact
 * boundary — no off-by-one, no 23/25-hour drift.
 */
export function startOfLocalYmd(y: number, m: number, d: number, timeZone: string): Date {
  const midnightAsUtc = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  let t = midnightAsUtc - tzOffsetMs(timeZone, new Date(midnightAsUtc));
  t = midnightAsUtc - tzOffsetMs(timeZone, new Date(t));
  return new Date(t);
}

/** UTC instant of local midnight (start of the local day containing `instant`). */
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  const { y, m, d } = localParts(instant, timeZone);
  return startOfLocalYmd(y, m, d, timeZone);
}

/**
 * Add n calendar days (wall-clock) to a local-midnight UTC instant.
 * Uses UTC date arithmetic for month/year overflow, then resolves the exact
 * local midnight of the resulting wall-clock date.
 */
function addLocalDays(dayStartUtc: Date, days: number, timeZone: string): Date {
  const { y, m, d } = localParts(dayStartUtc, timeZone);
  const shifted = new Date(Date.UTC(y, m - 1, d + days, 0, 0, 0, 0));
  return startOfLocalYmd(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    timeZone,
  );
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseYmd(value: string): { y: number; m: number; d: number } {
  const parts = value.split('-').map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (
    y === undefined ||
    m === undefined ||
    d === undefined ||
    !Number.isInteger(y) ||
    !Number.isInteger(m) ||
    !Number.isInteger(d)
  ) {
    throw new Error(`analytics: unparseable ISO date: ${value}`);
  }
  return { y, m, d };
}

function parseIsoDate(value: string | undefined, label: string): string {
  if (!value || !ISO_DATE_RE.test(value)) {
    throw new Error(
      `analytics: ${label} must be an ISO calendar date (YYYY-MM-DD), got ${JSON.stringify(value)}`,
    );
  }
  const { y, m, d } = parseYmd(value);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new Error(`analytics: ${label} is not a real calendar date: ${value}`);
  }
  return value;
}

function assertValidTimezone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`analytics: invalid IANA timezone: ${JSON.stringify(timeZone)}`);
  }
}

/**
 * Resolve a preset (or CUSTOM) into an exact [startInclusive, endExclusive)
 * DateRange. Throws on invalid CUSTOM input or invalid timezone.
 */
export function resolveDateRange(
  preset: DateRangePreset,
  opts: ResolveDateRangeOptions = {},
): DateRange {
  const timezone = opts.timezone ?? DEFAULT_TIMEZONE;
  assertValidTimezone(timezone);
  const now = opts.now ?? new Date();
  const todayStart = startOfLocalDay(now, timezone);

  let startInclusive: Date;
  let endExclusive: Date;

  switch (preset) {
    case 'TODAY':
      startInclusive = todayStart;
      endExclusive = addLocalDays(todayStart, 1, timezone);
      break;
    case 'LAST_7_DAYS':
      startInclusive = addLocalDays(todayStart, -6, timezone);
      endExclusive = addLocalDays(todayStart, 1, timezone);
      break;
    case 'LAST_30_DAYS':
      startInclusive = addLocalDays(todayStart, -29, timezone);
      endExclusive = addLocalDays(todayStart, 1, timezone);
      break;
    case 'THIS_MONTH': {
      const { y, m } = localParts(now, timezone);
      startInclusive = startOfLocalYmd(y, m, 1, timezone);
      endExclusive =
        m === 12 ? startOfLocalYmd(y + 1, 1, 1, timezone) : startOfLocalYmd(y, m + 1, 1, timezone);
      break;
    }
    case 'LAST_MONTH': {
      const { y, m } = localParts(now, timezone);
      endExclusive = startOfLocalYmd(y, m, 1, timezone);
      startInclusive =
        m === 1 ? startOfLocalYmd(y - 1, 12, 1, timezone) : startOfLocalYmd(y, m - 1, 1, timezone);
      break;
    }
    case 'THIS_QUARTER': {
      const { y, m } = localParts(now, timezone);
      const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
      startInclusive = startOfLocalYmd(y, qStartMonth, 1, timezone);
      const nextQ = qStartMonth + 3;
      endExclusive =
        nextQ > 12
          ? startOfLocalYmd(y + 1, 1, 1, timezone)
          : startOfLocalYmd(y, nextQ, 1, timezone);
      break;
    }
    case 'THIS_YEAR': {
      const { y } = localParts(now, timezone);
      startInclusive = startOfLocalYmd(y, 1, 1, timezone);
      endExclusive = startOfLocalYmd(y + 1, 1, 1, timezone);
      break;
    }
    case 'CUSTOM': {
      const s = parseIsoDate(opts.customStart, 'customStart');
      const e = parseIsoDate(opts.customEnd, 'customEnd');
      if (s > e)
        throw new Error(`analytics: customStart (${s}) must not be after customEnd (${e})`);
      const { y: sy, m: sm, d: sd } = parseYmd(s);
      const { y: ey, m: em, d: ed } = parseYmd(e);
      startInclusive = startOfLocalYmd(sy, sm, sd, timezone);
      endExclusive = addLocalDays(startOfLocalYmd(ey, em, ed, timezone), 1, timezone);
      // Cap custom range at 370 days to prevent unbounded bucket generation (security: mild DoS)
      const maxMs = 370 * 24 * 60 * 60 * 1000;
      if (endExclusive.getTime() - startInclusive.getTime() > maxMs) {
        throw new Error('analytics: custom date range must not exceed 370 days');
      }
      break;
    }
  }

  return { preset, timezone, startInclusive, endExclusive };
}

/**
 * The previous equal-length period immediately before `range` — the standard
 * comparison baseline for dashboards. [start - len, start).
 */
export function previousPeriod(range: DateRange): DateRange {
  const len = range.endExclusive.getTime() - range.startInclusive.getTime();
  if (len <= 0) throw new Error('analytics: cannot compute previous period of an empty range');
  return {
    preset: range.preset,
    timezone: range.timezone,
    startInclusive: new Date(range.startInclusive.getTime() - len),
    endExclusive: new Date(range.startInclusive.getTime()),
  };
}

/** Duration of the range in milliseconds. */
export function rangeDurationMs(range: DateRange): number {
  return range.endExclusive.getTime() - range.startInclusive.getTime();
}

/** True iff `ts` falls inside the half-open range. */
export function isInRange(ts: Date, range: DateRange): boolean {
  return (
    ts.getTime() >= range.startInclusive.getTime() && ts.getTime() < range.endExclusive.getTime()
  );
}
