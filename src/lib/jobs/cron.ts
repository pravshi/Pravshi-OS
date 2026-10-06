/**
 * Cron parsing, validation, and timezone-aware next-run computation.
 *
 * Scope (per Phase 6 §3.5 contract):
 *  - Strict 5-field cron: `minute hour dayOfMonth month dayOfWeek`
 *  - Field ranges: minute 0-59, hour 0-23, dom 1-31, month 1-12, dow 0-6
 *  - Supported syntax: `*`, ranges (`1-5`), steps (`*\/15`, `1-30/5`),
 *    lists (`1,15`). `@`-aliases, seconds (6-field), and month/dow
 *    names are NOT supported.
 *
 * Timezone approach (native `Intl`, no extra dependency):
 *  No date library (date-fns etc.) is present in package.json, and the
 *  contract forbids adding dependencies without Lead approval. All
 *  timezone math is done with `Intl.DateTimeFormat` in two primitives:
 *    - `localParts(utcMs, tz)` — wall-clock parts of a UTC instant in `tz`
 *    - `wallToUtc(...)` — inverse mapping of a wall-clock time in `tz`
 *      back to a UTC instant, via fixed-point iteration on the zone
 *      offset (two iterations handle any single DST transition).
 *
 * DST policy (documented per contract):
 *  - Nonexistent wall times (spring-forward gap, e.g. 02:30 on the day
 *    US clocks jump 02:00 -> 03:00) are SKIPPED — the run simply does
 *    not happen that day, matching system-cron behavior.
 *  - Ambiguous wall times (fall-back overlap, e.g. 01:30 occurs twice)
 *    resolve to the FIRST occurrence (the earlier UTC instant).
 */

/** Structural regex for one cron field: `*`, `*\/n`, `n`, `n-m`, `n/step`, `n-m/step`, comma lists. */
const CRON_FIELD_PATTERN =
  String.raw`(?:\*(?:\/[0-9]+)?|[0-9]+(?:-[0-9]+)?(?:\/[0-9]+)?)` +
  String.raw`(?:,(?:\*(?:\/[0-9]+)?|[0-9]+(?:-[0-9]+)?(?:\/[0-9]+)?))*`;

/**
 * Structural validation: exactly 5 cron fields separated by whitespace.
 * Rejects 6-field (seconds) expressions, `@`-aliases, names, and junk.
 * Semantic range checks (minute 0-59 etc.) are done by `isValidCron`.
 */
export const CRON_REGEX = new RegExp(
  '^\\s*' + CRON_FIELD_PATTERN + '(?:\\s+' + CRON_FIELD_PATTERN + '){4}\\s*$',
);

interface FieldDef {
  name: 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek';
  min: number;
  max: number;
}

const FIELD_DEFS: FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
];

interface ParsedField {
  values: Set<number>;
  /** True only when the field is exactly `*` (matters for dom/dow OR-semantics). */
  isWildcard: boolean;
}

interface ParsedCron {
  minutes: number[];
  hours: number[];
  months: Set<number>;
  daysOfMonth: ParsedField;
  daysOfWeek: ParsedField;
}

const ITEM_RE = /^(?:(\d+)(?:-(\d+))?|\*)(?:\/(\d+))?$/;

function parseField(raw: string, def: FieldDef): ParsedField {
  const values = new Set<number>();
  const isWildcard = raw === '*';
  for (const item of raw.split(',')) {
    const m = ITEM_RE.exec(item);
    if (!m) throw new Error(`Invalid ${def.name} item: "${item}"`);
    const [, startStr, endStr, stepStr] = m;
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid ${def.name} step in "${item}" (must be a positive integer)`);
    }
    let start: number;
    let end: number;
    if (startStr === undefined) {
      // `*` or `*/step`
      start = def.min;
      end = def.max;
    } else {
      start = Number(startStr);
      end = endStr === undefined ? (stepStr === undefined ? start : def.max) : Number(endStr);
    }
    if (start < def.min || start > def.max || end < def.min || end > def.max) {
      throw new Error(`Invalid ${def.name} value in "${item}" (allowed ${def.min}-${def.max})`);
    }
    if (end < start) {
      throw new Error(`Invalid ${def.name} range in "${item}" (end < start)`);
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return { values, isWildcard };
}

function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron must have exactly 5 fields, got ${fields.length}`);
  const parsed = fields.map((f, i) => parseField(f, FIELD_DEFS[i] as FieldDef));
  const [minutes, hours, dom, months, dow] = parsed as [
    ParsedField,
    ParsedField,
    ParsedField,
    ParsedField,
    ParsedField,
  ];
  return {
    minutes: [...minutes.values].sort((a, b) => a - b),
    hours: [...hours.values].sort((a, b) => a - b),
    months: months.values,
    daysOfMonth: dom,
    daysOfWeek: dow,
  };
}

/**
 * Strict 5-field cron validation. Rejects 6-field expressions,
 * `@`-aliases, out-of-range values, zero steps, reversed ranges.
 */
export function isValidCron(expr: string): boolean {
  if (typeof expr !== 'string') return false;
  if (!CRON_REGEX.test(expr)) return false;
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate an IANA timezone name.
 *
 * Primary check is `Intl.supportedValuesOf('timeZone')` per the Phase 6
 * contract. Some ICU builds omit UTC aliases (e.g. `UTC`, `Etc/UTC`) from
 * that list even though they are valid and `Intl.DateTimeFormat` accepts
 * them, so we additionally accept those aliases explicitly and fall back
 * to the `DateTimeFormat` constructor itself as the validity oracle.
 * The `schedules.timezone` column defaults to `'UTC'`, so it must pass.
 */
export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  const upper = tz.toUpperCase();
  if (upper === 'UTC' || upper === 'ETC/UTC') return true;
  try {
    if (Intl.supportedValuesOf('timeZone').includes(tz)) return true;
  } catch {
    // supportedValuesOf unavailable — rely on the constructor check below
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface WallParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const PARTS_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = PARTS_FORMATTER_CACHE.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
      hourCycle: 'h23',
    });
    PARTS_FORMATTER_CACHE.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of a UTC instant in `tz`. */
function localParts(utcMs: number, tz: string): WallParts {
  const out: WallParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0 };
  for (const p of partsFormatter(tz).formatToParts(new Date(utcMs))) {
    switch (p.type) {
      case 'year':
        out.year = Number(p.value);
        break;
      case 'month':
        out.month = Number(p.value);
        break;
      case 'day':
        out.day = Number(p.value);
        break;
      case 'hour':
        // hourCycle h23 keeps midnight at 0 (never 24)
        out.hour = Number(p.value) % 24;
        break;
      case 'minute':
        out.minute = Number(p.value);
        break;
    }
  }
  return out;
}

/** Zone offset in ms such that `utcMs + offset = wall clock in tz`. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const p = localParts(utcMs, tz);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  return wallAsUtc - utcMs;
}

/**
 * Map a wall-clock time in `tz` to a UTC instant.
 * Returns `null` when the wall time does not exist (spring-forward gap).
 * For ambiguous times (fall-back overlap) returns the FIRST occurrence.
 */
function wallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number | null {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Fixed-point iteration: utc = guess - offset(utc). Two passes handle
  // a transition lying between the guess and the true instant.
  let utc = guess - tzOffsetMs(guess, tz);
  utc = guess - tzOffsetMs(utc, tz);

  const p = localParts(utc, tz);
  const matches =
    p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  if (!matches) return null; // nonexistent local time (DST gap) -> skip

  // Ambiguity check: if one hour earlier maps to the same wall time,
  // the wall time occurs twice — return the first (earlier) occurrence.
  const earlier = utc - 3_600_000;
  const pe = localParts(earlier, tz);
  if (
    pe.year === year &&
    pe.month === month &&
    pe.day === day &&
    pe.hour === hour &&
    pe.minute === minute
  ) {
    return earlier;
  }
  return utc;
}

/** Standard cron dom/dow semantics: restricted fields OR together; `*` fields are unrestricted. */
function dayMatches(cron: ParsedCron, domMatch: boolean, dowMatch: boolean): boolean {
  const domRestricted = !cron.daysOfMonth.isWildcard;
  const dowRestricted = !cron.daysOfWeek.isWildcard;
  if (!domRestricted && !dowRestricted) return true;
  if (domRestricted && !dowRestricted) return domMatch;
  if (!domRestricted && dowRestricted) return dowMatch;
  return domMatch || dowMatch;
}

/** Maximum lookahead for a next occurrence (covers leap-day crons; "Feb 30" throws). */
export const CRON_MAX_SEARCH_DAYS = 366 * 5;

/**
 * Next occurrence of `cron` strictly AFTER `from` (default: now),
 * interpreting the cron fields in the IANA `timezone`, returned as a
 * UTC `Date`. Nonexistent local times (DST spring-forward gap) are
 * skipped; ambiguous times (fall-back) use the first occurrence.
 * Throws on invalid cron/timezone, or when no occurrence exists
 * within 5 years (e.g. Feb 30).
 */
export function nextRunAt(cron: string, timezone: string, from: Date = new Date()): Date {
  if (!isValidCron(cron)) throw new Error(`Invalid cron expression: "${cron}"`);
  if (!isValidTimezone(timezone)) throw new Error(`Invalid IANA timezone: "${timezone}"`);
  const fromMs = from instanceof Date ? from.getTime() : NaN;
  if (!Number.isFinite(fromMs)) throw new Error('Invalid `from` date');

  const cronParts = parseCron(cron);

  // Start of the minute strictly after `from`.
  const t0 = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const local0 = localParts(t0, timezone);
  const startWallMinutes = local0.hour * 60 + local0.minute;
  const day0 = Date.UTC(local0.year, local0.month - 1, local0.day);

  for (let d = 0; d <= CRON_MAX_SEARCH_DAYS; d++) {
    const day = new Date(day0 + d * 86_400_000);
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const dd = day.getUTCDate();
    if (!cronParts.months.has(m)) continue;
    const dow = day.getUTCDay();
    if (
      !dayMatches(
        cronParts,
        cronParts.daysOfMonth.values.has(dd),
        cronParts.daysOfWeek.values.has(dow),
      )
    ) {
      continue;
    }
    for (const h of cronParts.hours) {
      for (const min of cronParts.minutes) {
        if (d === 0 && h * 60 + min < startWallMinutes) continue;
        const utc = wallToUtc(y, m, dd, h, min, timezone);
        if (utc === null) continue; // DST gap: nonexistent local time, skip
        return new Date(utc);
      }
    }
  }
  throw new Error(
    `No occurrence of cron "${cron}" within ${CRON_MAX_SEARCH_DAYS} days (unsatisfiable schedule, e.g. Feb 30?)`,
  );
}

/**
 * Minute-precision UTC ISO string for schedule dedup keys,
 * e.g. `2026-10-06T05:38:00.000Z`.
 */
export function cronWindowStart(date: Date): string {
  const t = date instanceof Date ? date.getTime() : NaN;
  if (!Number.isFinite(t)) throw new Error('Invalid date for cronWindowStart');
  const truncated = Math.floor(t / 60_000) * 60_000;
  return new Date(truncated).toISOString();
}
