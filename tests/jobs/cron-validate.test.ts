import { describe, expect, it } from 'vitest';
import {
  CRON_REGEX,
  cronWindowStart,
  isValidCron,
  isValidTimezone,
  nextRunAt,
} from '@/lib/jobs/cron';

describe('CRON_REGEX', () => {
  it('accepts canonical 5-field expressions', () => {
    for (const expr of [
      '* * * * *',
      '*/15 * * * *',
      '0 9 * * 1',
      '0 0 1,15 * *',
      '30 2-4 * * *',
      '59 23 31 12 6',
      '5/20 1-12/2 1-28 1,6,12 0-5',
      '  0   9 * * *  ', // extra whitespace is structural noise, still 5 fields
    ]) {
      expect(CRON_REGEX.test(expr), expr).toBe(true);
    }
  });

  it('rejects 6-field expressions, @-aliases, names and junk', () => {
    for (const expr of [
      '* * * * *', // placeholder replaced below
      '* * * * * *',
      '0 * * * * *',
      '@daily',
      '@hourly',
      'MON * * * *',
      '* * * JAN *',
      '',
      '   ',
      'not a cron',
      '1,2,3',
      '* * * *',
    ]) {
      if (expr === '* * * * *') continue; // valid; tested above
      expect(CRON_REGEX.test(expr), JSON.stringify(expr)).toBe(false);
    }
  });
});

describe('isValidCron', () => {
  it('accepts valid expressions', () => {
    const valid = [
      '* * * * *',
      '*/15 * * * *',
      '0 9 * * 1',
      '0 0 1,15 * *',
      '30 2-4 * * *',
      '59 23 31 12 6',
      '0 0 * * 0',
      '0 12 1 */3 *',
      '15 10 1-7 * 1',
      '0 0 29 2 *', // Feb 29: structurally valid, resolved by nextRunAt
    ];
    for (const expr of valid) expect(isValidCron(expr), expr).toBe(true);
  });

  it('rejects malformed structure', () => {
    const invalid = [
      '',
      '* * * *',
      '* * * * * *',
      '@daily',
      '@reboot',
      '*/15 * * *',
      'MON * * * *',
      '1-2-3 * * * *',
      '*//15 * * * *',
      '*, * * * *',
      '* * * * *,',
    ];
    for (const expr of invalid) expect(isValidCron(expr), JSON.stringify(expr)).toBe(false);
  });

  it('rejects out-of-range values', () => {
    const invalid = [
      '60 * * * *', // minute > 59
      '* 24 * * *', // hour > 23
      '* * 0 * *', // dom < 1
      '* * 32 * *', // dom > 31
      '* * * 0 *', // month < 1
      '* * * 13 *', // month > 12
      '* * * * 7', // dow > 6
      '* * * * -1',
      '61-70 * * * *',
    ];
    for (const expr of invalid) expect(isValidCron(expr), expr).toBe(false);
  });

  it('rejects bad steps and reversed ranges', () => {
    const invalid = [
      '*/0 * * * *', // zero step
      '5-2 * * * *', // reversed range
      '* * 10-1 * *',
      '0/0 * * * *',
    ];
    for (const expr of invalid) expect(isValidCron(expr), expr).toBe(false);
  });

  it('accepts steps and start/step forms', () => {
    expect(isValidCron('*/15 * * * *')).toBe(true);
    expect(isValidCron('5/15 * * * *')).toBe(true); // 5,20,35,50
    expect(isValidCron('0-30/10 * * * *')).toBe(true);
    expect(isValidCron('1,15,30 * * * *')).toBe(true);
  });

  it('rejects non-strings', () => {
    expect(isValidCron(undefined as unknown as string)).toBe(false);
    expect(isValidCron(null as unknown as string)).toBe(false);
    expect(isValidCron(42 as unknown as string)).toBe(false);
  });
});

describe('isValidTimezone', () => {
  it('accepts real IANA zones', () => {
    for (const tz of [
      'UTC',
      'Etc/UTC',
      'Asia/Calcutta',
      'America/New_York',
      'Europe/London',
      'Australia/Sydney',
      'EST', // genuine IANA zone (fixed UTC-5, no DST)
    ]) {
      expect(isValidTimezone(tz), tz).toBe(true);
    }
  });

  it('rejects bogus zones', () => {
    for (const tz of ['', 'Mars/Olympus', 'UTC+5', 'Asia Calcutta', 'GMT+0530', 'US/Easternx']) {
      expect(isValidTimezone(tz), JSON.stringify(tz)).toBe(false);
    }
  });
});

describe('nextRunAt (UTC)', () => {
  it('finds the next minute for * * * * *', () => {
    const from = new Date('2026-10-06T05:38:22.123Z');
    expect(nextRunAt('* * * * *', 'UTC', from).toISOString()).toBe('2026-10-06T05:39:00.000Z');
  });

  it('is strictly after `from`, even on an exact boundary', () => {
    const from = new Date('2026-10-06T05:38:00.000Z');
    expect(nextRunAt('* * * * *', 'UTC', from).toISOString()).toBe('2026-10-06T05:39:00.000Z');
  });

  it('resolves step and list expressions', () => {
    expect(nextRunAt('*/15 * * * *', 'UTC', new Date('2026-10-06T05:38:00Z')).toISOString()).toBe(
      '2026-10-06T05:45:00.000Z',
    );
    expect(nextRunAt('15,45 * * * *', 'UTC', new Date('2026-10-06T05:38:00Z')).toISOString()).toBe(
      '2026-10-06T05:45:00.000Z',
    );
    expect(nextRunAt('0 9-17 * * *', 'UTC', new Date('2026-10-06T18:00:00Z')).toISOString()).toBe(
      '2026-10-07T09:00:00.000Z',
    );
  });

  it('honours day-of-month OR day-of-week semantics', () => {
    // 2026-10-06 is a Tuesday. Next Monday 00:00 UTC:
    const next = nextRunAt('0 0 * * 1', 'UTC', new Date('2026-10-06T00:00:01Z'));
    expect(next.toISOString()).toBe('2026-10-12T00:00:00.000Z');
    // dom=13 OR dow=Friday
    const fri = nextRunAt('0 0 13 * 5', 'UTC', new Date('2026-10-06T00:00:01Z'));
    expect(fri.toISOString()).toBe('2026-10-09T00:00:00.000Z'); // Friday comes before the 13th
    // dom only (dow wildcard)
    const dom = nextRunAt('0 0 15 * *', 'UTC', new Date('2026-10-06T00:00:01Z'));
    expect(dom.toISOString()).toBe('2026-10-15T00:00:00.000Z');
  });

  it('finds Feb 29 across a leap boundary', () => {
    const next = nextRunAt('0 0 29 2 *', 'UTC', new Date('2026-10-06T00:00:00Z'));
    expect(next.toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('throws for an unsatisfiable schedule (Feb 30)', () => {
    expect(() => nextRunAt('0 0 30 2 *', 'UTC', new Date('2026-10-06T00:00:00Z'))).toThrow(
      /No occurrence|unsatisfiable/i,
    );
  });

  it('throws on invalid cron / timezone / from', () => {
    expect(() => nextRunAt('not a cron', 'UTC')).toThrow(/Invalid cron/);
    expect(() => nextRunAt('* * * * *', 'Mars/Olympus')).toThrow(/Invalid IANA timezone/);
    expect(() => nextRunAt('* * * * *', 'UTC', new Date('garbage'))).toThrow(/Invalid `from`/);
  });
});

describe('cronWindowStart', () => {
  it('truncates to minute-precision UTC ISO', () => {
    expect(cronWindowStart(new Date('2026-10-06T05:38:22.999Z'))).toBe('2026-10-06T05:38:00.000Z');
    expect(cronWindowStart(new Date('2026-10-06T05:38:00.000Z'))).toBe('2026-10-06T05:38:00.000Z');
  });

  it('throws on invalid dates', () => {
    expect(() => cronWindowStart(new Date('garbage'))).toThrow(/Invalid date/);
  });
});
