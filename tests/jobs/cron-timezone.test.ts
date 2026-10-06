import { describe, expect, it } from 'vitest';
import { nextRunAt } from '@/lib/jobs/cron';

describe('nextRunAt timezone conversion', () => {
  it('interprets the cron in the given IANA timezone (Asia/Calcutta, UTC+5:30)', () => {
    // 09:00 IST = 03:30 UTC
    const next = nextRunAt('0 9 * * *', 'Asia/Calcutta', new Date('2026-10-06T00:00:00Z'));
    expect(next.toISOString()).toBe('2026-10-06T03:30:00.000Z');
  });

  it('advances past a run that already happened in the target timezone', () => {
    // After 09:00 IST on Oct 6, the next 09:00 IST is Oct 7.
    const next = nextRunAt('0 9 * * *', 'Asia/Calcutta', new Date('2026-10-06T04:00:00Z'));
    expect(next.toISOString()).toBe('2026-10-07T03:30:00.000Z');
  });

  it('handles a negative-offset zone (America/New_York, EDT = UTC-4 in Oct)', () => {
    // 2026-10-06 09:00 EDT = 13:00 UTC
    const next = nextRunAt('0 9 * * *', 'America/New_York', new Date('2026-10-06T00:00:00Z'));
    expect(next.toISOString()).toBe('2026-10-06T13:00:00.000Z');
  });

  it('applies the correct offset after a zone changes offset (EST = UTC-5)', () => {
    // 2026-12-06 09:00 EST = 14:00 UTC (DST has ended)
    const next = nextRunAt('0 9 * * *', 'America/New_York', new Date('2026-12-06T00:00:00Z'));
    expect(next.toISOString()).toBe('2026-12-06T14:00:00.000Z');
  });
});

describe('nextRunAt DST boundaries (America/New_York)', () => {
  // US DST 2026: springs forward 2026-03-08 02:00 -> 03:00,
  // falls back 2026-11-01 02:00 -> 01:00.

  it('skips a nonexistent local time (spring-forward gap)', () => {
    // 02:30 does not exist on 2026-03-08 in New York; the run is skipped that day.
    const next = nextRunAt(
      '30 2 * * *',
      'America/New_York',
      new Date('2026-03-07T07:31:00Z'), // just after the 03-07 02:30 EST run (07:30 UTC)
    );
    // 2026-03-09 02:30 EDT = 06:30 UTC
    expect(next.toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  it('still runs adjacent wall times on the spring-forward day', () => {
    // 03:30 exists on 2026-03-08 (EDT) = 07:30 UTC
    const next = nextRunAt('30 3 * * *', 'America/New_York', new Date('2026-03-08T00:00:00Z'));
    expect(next.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('resolves an ambiguous local time to the FIRST occurrence (fall-back)', () => {
    // 01:30 occurs twice on 2026-11-01; first occurrence is 01:30 EDT = 05:30 UTC.
    // (from is after the unambiguous 2026-10-31 01:30 EDT run.)
    const next = nextRunAt('30 1 * * *', 'America/New_York', new Date('2026-10-31T06:00:00Z'));
    expect(next.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('day-of-week matching uses the timezone-local weekday', () => {
    // 2026-10-06 00:30 UTC is still Monday 2026-10-05 20:30 EDT in New York.
    // "0 9 * * 2" (Tuesdays) at 09:00 EDT: next Tuesday is 2026-10-06 13:00 UTC.
    const next = nextRunAt('0 9 * * 2', 'America/New_York', new Date('2026-10-06T00:30:00Z'));
    expect(next.toISOString()).toBe('2026-10-06T13:00:00.000Z');
  });
});
