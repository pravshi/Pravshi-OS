import type { AuthContext } from '@/lib/db/context';
import type { DashboardFilter, DateRangePreset, TimeSeriesGrain } from '@/lib/analytics/types';
import { DATE_RANGE_PRESETS } from '@/lib/analytics/date-ranges';
import { validateDashboardFilter } from '@/lib/analytics/tenant';
import { DEFAULT_TIMEZONE } from '@/lib/analytics/date-ranges';

export type { DashboardFilter };

/**
 * Parse dashboard query params into a validated DashboardFilter.
 * orgId always comes from the session context, never the URL.
 */
export function parseDashboardFilter(
  ctx: AuthContext,
  searchParams: Record<string, string | string[] | undefined>,
): { filter: DashboardFilter; preset: DateRangePreset; rangeLabel: string } {
  const first = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;

  const rawPreset = first(searchParams.range);
  const preset: DateRangePreset = (DATE_RANGE_PRESETS as readonly string[]).includes(
    rawPreset ?? '',
  )
    ? (rawPreset as DateRangePreset)
    : 'LAST_30_DAYS';

  const { filter } = validateDashboardFilter(
    {
      preset,
      timezone: DEFAULT_TIMEZONE,
      customStart: first(searchParams.from),
      customEnd: first(searchParams.to),
      grain: grainForPreset(preset, first(searchParams.from), first(searchParams.to)),
    },
    ctx.orgId,
  );

  const { startInclusive, endExclusive } = filter.dateRange;
  const fmt = new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: DEFAULT_TIMEZONE,
  });
  // endExclusive is the first instant NOT included; show the last included day.
  const lastIncluded = new Date(endExclusive.getTime() - 1);
  const rangeLabel =
    preset === 'TODAY'
      ? fmt.format(startInclusive)
      : `${fmt.format(startInclusive)} – ${fmt.format(lastIncluded)}`;

  return { filter, preset, rangeLabel };
}

/** Pick a sensible time-series grain for the preset so charts stay readable. */
function grainForPreset(preset: DateRangePreset, from?: string, to?: string): TimeSeriesGrain {
  switch (preset) {
    case 'THIS_YEAR':
      return 'month';
    case 'THIS_QUARTER':
      return 'week';
    case 'CUSTOM': {
      if (from && to) {
        const days = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000 + 1;
        if (days > 180) return 'month';
        if (days > 45) return 'week';
      }
      return 'day';
    }
    default:
      return 'day';
  }
}

/** Whole-number formatting with Indian grouping (matches the app's locale). */
export function formatInt(n: number | null): string | null {
  if (n === null || Number.isNaN(n)) return null;
  return new Intl.NumberFormat('en-IN').format(n);
}

/** 0–1 fraction → "62.5%". null stays null (no data), never 0. */
export function formatPercent(fraction: number | null, digits = 1): string | null {
  if (fraction === null || Number.isNaN(fraction)) return null;
  return `${(fraction * 100).toFixed(digits)}%`;
}

/**
 * Money-by-currency summary. NEVER sums across currencies: picks the largest
 * single currency and reports the rest as a count.
 */
export function formatMoneySummary(byCurrency: Record<string, string | null>): {
  value: string | null;
  sub?: string;
} {
  const entries = Object.entries(byCurrency)
    .map(([currency, total]) => ({
      currency,
      total: total === null ? null : Number(total),
    }))
    .filter((e) => e.total !== null && !Number.isNaN(e.total)) as {
    currency: string;
    total: number;
  }[];
  if (entries.length === 0) return { value: null };
  entries.sort((a, b) => b.total - a.total);
  const primary = entries[0];
  if (!primary) return { value: null };
  const value = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: primary.currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(primary.total);
  const sub =
    entries.length > 1
      ? `+ ${entries.length - 1} more ${entries.length === 2 ? 'currency' : 'currencies'}`
      : undefined;
  return { value, sub };
}

/** Bucket label for a time-series point in the org display timezone. */
export function bucketLabel(d: Date, grain: TimeSeriesGrain): string {
  const tz = DEFAULT_TIMEZONE;
  if (grain === 'month')
    return new Intl.DateTimeFormat('en-IN', {
      month: 'short',
      year: '2-digit',
      timeZone: tz,
    }).format(d);
  if (grain === 'week')
    return new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      timeZone: tz,
    }).format(d);
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: tz }).format(
    d,
  );
}

/** YYYY-MM-DD in the org display timezone. */
export function tzDateString(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: DEFAULT_TIMEZONE,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
