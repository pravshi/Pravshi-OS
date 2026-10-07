import { describe, expect, it } from 'vitest';
import {
  DATE_RANGE_PRESETS,
  DEFAULT_TIMEZONE,
  isInRange,
  previousPeriod,
  rangeDurationMs,
  resolveDateRange,
  startOfLocalDay,
  startOfLocalYmd,
} from '@/lib/analytics/date-ranges';
import type { DateRange } from '@/lib/analytics/types';

/**
 * Phase 7 — date range resolution: pure unit tests (no DB).
 *
 * Conventions pinned here (from src/lib/analytics/date-ranges.ts):
 *  - Every range is half-open: [startInclusive, endExclusive).
 *  - "Day" boundaries are calendar days in the given IANA timezone, resolved
 *    to exact UTC instants. DST transitions produce 23- or 25-hour days.
 *  - LAST_7_DAYS = today + previous 6 days; LAST_30_DAYS = today + 29.
 *  - CUSTOM takes ISO calendar dates; the end date INCLUDES that whole day.
 */

const DAY_MS = 24 * 3600_000;

// 2026-10-07T10:00:00+05:30 == 2026-10-07T04:30:00Z. In Asia/Calcutta the
// local date is 2026-10-07, so "today" is unambiguous for every preset.
const NOW = new Date('2026-10-07T04:30:00.000Z');

// Calcutta is UTC+5:30 year-round (no DST): local midnight == 18:30Z previous day.
const IST_MIDNIGHT_2026_10_07 = new Date('2026-10-06T18:30:00.000Z');

describe('DATE_RANGE_PRESETS / DEFAULT_TIMEZONE', () => {
  it('exposes all eight presets in UI order', () => {
    expect([...DATE_RANGE_PRESETS]).toEqual([
      'TODAY',
      'LAST_7_DAYS',
      'LAST_30_DAYS',
      'THIS_MONTH',
      'LAST_MONTH',
      'THIS_QUARTER',
      'THIS_YEAR',
      'CUSTOM',
    ]);
  });

  it('defaults to Asia/Calcutta', () => {
    expect(DEFAULT_TIMEZONE).toBe('Asia/Calcutta');
  });
});

describe('resolveDateRange presets (Asia/Calcutta)', () => {
  it('TODAY spans exactly the current local day', () => {
    const r = resolveDateRange('TODAY', { now: NOW });
    expect(r.preset).toBe('TODAY');
    expect(r.timezone).toBe('Asia/Calcutta');
    expect(r.startInclusive.getTime()).toBe(IST_MIDNIGHT_2026_10_07.getTime());
    expect(r.endExclusive.getTime()).toBe(IST_MIDNIGHT_2026_10_07.getTime() + DAY_MS);
    expect(rangeDurationMs(r)).toBe(DAY_MS);
  });

  it('LAST_7_DAYS covers today plus the previous 6 days', () => {
    const r = resolveDateRange('LAST_7_DAYS', { now: NOW });
    expect(r.startInclusive.getTime()).toBe(IST_MIDNIGHT_2026_10_07.getTime() - 6 * DAY_MS);
    expect(r.endExclusive.getTime()).toBe(IST_MIDNIGHT_2026_10_07.getTime() + DAY_MS);
    expect(rangeDurationMs(r)).toBe(7 * DAY_MS);
  });

  it('LAST_30_DAYS covers today plus the previous 29 days', () => {
    const r = resolveDateRange('LAST_30_DAYS', { now: NOW });
    expect(r.startInclusive.getTime()).toBe(IST_MIDNIGHT_2026_10_07.getTime() - 29 * DAY_MS);
    expect(r.endExclusive.getTime()).toBe(IST_MIDNIGHT_2026_10_07.getTime() + DAY_MS);
    expect(rangeDurationMs(r)).toBe(30 * DAY_MS);
  });

  it('THIS_MONTH spans the full local calendar month', () => {
    const r = resolveDateRange('THIS_MONTH', { now: NOW });
    // 2026-10-01 00:00 IST .. 2026-11-01 00:00 IST (October has 31 days)
    expect(r.startInclusive.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(r.endExclusive.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(rangeDurationMs(r)).toBe(31 * DAY_MS);
  });

  it('LAST_MONTH spans the previous local calendar month', () => {
    const r = resolveDateRange('LAST_MONTH', { now: NOW });
    // September 2026: 2026-09-01 .. 2026-10-01 local
    expect(r.startInclusive.toISOString()).toBe('2026-08-31T18:30:00.000Z');
    expect(r.endExclusive.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(rangeDurationMs(r)).toBe(30 * DAY_MS);
  });

  it('LAST_MONTH wraps the year boundary (January → December)', () => {
    const jan = new Date('2026-01-15T04:30:00.000Z');
    const r = resolveDateRange('LAST_MONTH', { now: jan });
    expect(r.startInclusive.toISOString()).toBe('2025-11-30T18:30:00.000Z');
    expect(r.endExclusive.toISOString()).toBe('2025-12-31T18:30:00.000Z');
  });

  it('THIS_QUARTER spans Q4 2026 (Oct–Dec)', () => {
    const r = resolveDateRange('THIS_QUARTER', { now: NOW });
    expect(r.startInclusive.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(r.endExclusive.toISOString()).toBe('2026-12-31T18:30:00.000Z');
    expect(rangeDurationMs(r)).toBe(92 * DAY_MS);
  });

  it('THIS_QUARTER wraps Q4 → next year correctly', () => {
    const dec = new Date('2026-12-10T04:30:00.000Z');
    const r = resolveDateRange('THIS_QUARTER', { now: dec });
    expect(r.startInclusive.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(r.endExclusive.toISOString()).toBe('2026-12-31T18:30:00.000Z');
  });

  it('THIS_YEAR spans the full local calendar year', () => {
    const r = resolveDateRange('THIS_YEAR', { now: NOW });
    expect(r.startInclusive.toISOString()).toBe('2025-12-31T18:30:00.000Z');
    expect(r.endExclusive.toISOString()).toBe('2026-12-31T18:30:00.000Z');
    // 2026 is not a leap year
    expect(rangeDurationMs(r)).toBe(365 * DAY_MS);
  });
});

describe('timezone boundaries', () => {
  it('resolves local midnight to the exact UTC instant for a positive offset', () => {
    // 2026-10-07 00:00 Asia/Calcutta == 2026-10-06 18:30 UTC
    expect(startOfLocalYmd(2026, 10, 7, 'Asia/Calcutta').toISOString()).toBe(
      '2026-10-06T18:30:00.000Z',
    );
  });

  it('resolves local midnight for a negative offset (America/New_York, EDT)', () => {
    // 2026-10-07 00:00 EDT (UTC-4) == 2026-10-07 04:00 UTC
    expect(startOfLocalYmd(2026, 10, 7, 'America/New_York').toISOString()).toBe(
      '2026-10-07T04:00:00.000Z',
    );
  });

  it('startOfLocalDay finds the local midnight containing the instant', () => {
    // 2026-10-07T04:30Z is 10:00 IST on 2026-10-07 → midnight is 18:30Z previous day
    expect(startOfLocalDay(NOW, 'Asia/Calcutta').toISOString()).toBe('2026-10-06T18:30:00.000Z');
  });

  it('DST spring-forward: the local day is 23 hours, never shifted', () => {
    // US DST starts 2026-03-08 (second Sunday of March). Noon EDT that day.
    const noon = new Date('2026-03-08T16:00:00.000Z');
    const r = resolveDateRange('TODAY', { timezone: 'America/New_York', now: noon });
    // 00:00 EST (UTC-5) → 2026-03-08T05:00Z; next midnight is 00:00 EDT (UTC-4) → 2026-03-09T04:00Z
    expect(r.startInclusive.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(r.endExclusive.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(rangeDurationMs(r)).toBe(23 * 3600_000);
  });

  it('DST fall-back: the local day is 25 hours, never shifted', () => {
    // US DST ends 2026-11-01 (first Sunday of November). Noon EST that day.
    const noon = new Date('2026-11-01T17:00:00.000Z');
    const r = resolveDateRange('TODAY', { timezone: 'America/New_York', now: noon });
    // 00:00 EDT (UTC-4) → 2026-11-01T04:00Z; next midnight is 00:00 EST (UTC-5) → 2026-11-02T05:00Z
    expect(r.startInclusive.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(r.endExclusive.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(rangeDurationMs(r)).toBe(25 * 3600_000);
  });

  it('a UTC-day boundary does not leak into the neighboring local day', () => {
    // 2026-10-06T18:29:59Z is still 2026-10-06 in Calcutta; 18:30:00Z is 2026-10-07.
    const r = resolveDateRange('TODAY', { now: NOW });
    expect(isInRange(new Date('2026-10-06T18:29:59.000Z'), r)).toBe(false);
    expect(isInRange(new Date('2026-10-06T18:30:00.000Z'), r)).toBe(true);
  });

  it('rejects an invalid IANA timezone', () => {
    expect(() => resolveDateRange('TODAY', { timezone: 'Mars/Olympus' })).toThrow(
      /invalid IANA timezone/,
    );
  });
});

describe('CUSTOM ranges', () => {
  it('resolves a single day: end date includes the whole local day', () => {
    const r = resolveDateRange('CUSTOM', {
      customStart: '2026-10-07',
      customEnd: '2026-10-07',
      now: NOW,
    });
    expect(r.startInclusive.toISOString()).toBe('2026-10-06T18:30:00.000Z');
    expect(r.endExclusive.toISOString()).toBe('2026-10-07T18:30:00.000Z');
    expect(rangeDurationMs(r)).toBe(DAY_MS);
  });

  it('resolves a multi-day range with an inclusive end date', () => {
    const r = resolveDateRange('CUSTOM', {
      customStart: '2026-10-01',
      customEnd: '2026-10-07',
      now: NOW,
    });
    expect(r.startInclusive.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(r.endExclusive.toISOString()).toBe('2026-10-07T18:30:00.000Z');
    expect(rangeDurationMs(r)).toBe(7 * DAY_MS);
  });

  it('end-of-day belongs to the range; the next midnight does not', () => {
    const r = resolveDateRange('CUSTOM', {
      customStart: '2026-10-07',
      customEnd: '2026-10-07',
      now: NOW,
    });
    // 2026-10-07T23:59:59+05:30
    expect(isInRange(new Date('2026-10-07T18:29:59.000Z'), r)).toBe(true);
    // 2026-10-08T00:00:00+05:30
    expect(isInRange(new Date('2026-10-07T18:30:00.000Z'), r)).toBe(false);
  });

  it('rejects start after end', () => {
    expect(() =>
      resolveDateRange('CUSTOM', {
        customStart: '2026-10-08',
        customEnd: '2026-10-07',
        now: NOW,
      }),
    ).toThrow(/must not be after/);
  });

  it('rejects malformed ISO dates', () => {
    expect(() =>
      resolveDateRange('CUSTOM', { customStart: '10/07/2026', customEnd: '2026-10-07', now: NOW }),
    ).toThrow(/ISO calendar date/);
    expect(() =>
      resolveDateRange('CUSTOM', { customStart: '2026-10-07', customEnd: 'tomorrow', now: NOW }),
    ).toThrow(/ISO calendar date/);
  });

  it('rejects impossible calendar dates (2026-02-30)', () => {
    expect(() =>
      resolveDateRange('CUSTOM', { customStart: '2026-02-30', customEnd: '2026-03-01', now: NOW }),
    ).toThrow(/not a real calendar date/);
  });

  it('requires both customStart and customEnd', () => {
    expect(() => resolveDateRange('CUSTOM', { customStart: '2026-10-07', now: NOW })).toThrow(
      /customEnd/,
    );
    expect(() => resolveDateRange('CUSTOM', { customEnd: '2026-10-07', now: NOW })).toThrow(
      /customStart/,
    );
  });
});

describe('previousPeriod', () => {
  it('returns the equal-length period immediately before the range', () => {
    const r = resolveDateRange('TODAY', { now: NOW });
    const p = previousPeriod(r);
    expect(p.preset).toBe(r.preset);
    expect(p.timezone).toBe(r.timezone);
    expect(p.endExclusive.getTime()).toBe(r.startInclusive.getTime());
    expect(p.startInclusive.getTime()).toBe(r.startInclusive.getTime() - DAY_MS);
    expect(rangeDurationMs(p)).toBe(rangeDurationMs(r));
  });

  it('works for multi-day ranges (LAST_7_DAYS)', () => {
    const r = resolveDateRange('LAST_7_DAYS', { now: NOW });
    const p = previousPeriod(r);
    expect(rangeDurationMs(p)).toBe(7 * DAY_MS);
    expect(p.endExclusive.getTime()).toBe(r.startInclusive.getTime());
    // Contiguous: no gap, no overlap
    expect(p.startInclusive.getTime()).toBe(r.startInclusive.getTime() - 7 * DAY_MS);
  });

  it('keeps DST-shortened durations equal (23h day → 23h previous day)', () => {
    const noon = new Date('2026-03-08T16:00:00.000Z');
    const r = resolveDateRange('TODAY', { timezone: 'America/New_York', now: noon });
    const p = previousPeriod(r);
    // 2026-03-07 was a normal 24h day; previousPeriod is wall-clock-equal by
    // instant math: exactly 23h before today's start, per the contract.
    expect(rangeDurationMs(p)).toBe(rangeDurationMs(r));
    expect(p.endExclusive.getTime()).toBe(r.startInclusive.getTime());
  });

  it('throws on an empty (zero-length) range', () => {
    const empty: DateRange = {
      preset: 'CUSTOM',
      timezone: 'Asia/Calcutta',
      startInclusive: NOW,
      endExclusive: NOW,
    };
    expect(() => previousPeriod(empty)).toThrow(/empty range/);
  });
});

describe('isInRange half-open semantics', () => {
  const r = resolveDateRange('TODAY', { now: NOW });

  it('includes the start instant', () => {
    expect(isInRange(r.startInclusive, r)).toBe(true);
  });

  it('excludes the end instant', () => {
    expect(isInRange(r.endExclusive, r)).toBe(false);
  });

  it('excludes instants before the start', () => {
    expect(isInRange(new Date(r.startInclusive.getTime() - 1), r)).toBe(false);
  });

  it('includes the last millisecond before the end', () => {
    expect(isInRange(new Date(r.endExclusive.getTime() - 1), r)).toBe(true);
  });
});
