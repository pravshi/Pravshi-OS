/**
 * WP-W — the minimum gap between runs of one schedule. DB-free.
 * minIntervalMinutes() measures a cron's shortest gap; assertScheduleInterval() refuses a
 * schedule that fires more often than SCHEDULE_MIN_INTERVAL_MINUTES (default 60).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/authorized', () => ({ withAuthorizedDb: vi.fn() }));

import { env } from '@/env';
import { minIntervalMinutes } from '@/lib/jobs/cron';
import {
  assertScheduleInterval,
  DEFAULT_SCHEDULE_MIN_INTERVAL_MINUTES,
} from '@/lib/jobs/schedule-policy';

const FROM = new Date('2026-10-12T08:30:00Z');
const saved = env.SCHEDULE_MIN_INTERVAL_MINUTES;
afterEach(() => {
  env.SCHEDULE_MIN_INTERVAL_MINUTES = saved;
});

describe('minIntervalMinutes', () => {
  it.each([
    ['*/15 * * * *', 15],
    ['0 * * * *', 60],
    ['0 */6 * * *', 360],
    ['0 9 * * 1-5', 1440], // weekdays: shortest gap Mon→Tue
    ['0 9,9 * * *', 1440],
    // Weekly: one run inside the 8-day horizon — too rare for its gap to matter.
    ['0 9 * * 1', Infinity],
  ])('%s → %i minutes', (cron, minutes) => {
    expect(minIntervalMinutes(cron, 'Asia/Kolkata', FROM)).toBe(minutes);
  });

  it('a schedule firing less than twice in the horizon has no measurable gap', () => {
    expect(minIntervalMinutes('0 0 1 * *', 'UTC', FROM)).toBe(Infinity);
  });

  it('catches an uneven cron by its shortest gap, not its average', () => {
    // 09:00 and 09:10 every day: 10 minutes apart once a day.
    expect(minIntervalMinutes('0,10 9 * * *', 'UTC', FROM)).toBe(10);
  });
});

describe('assertScheduleInterval', () => {
  it('defaults to a 60-minute minimum', () => {
    env.SCHEDULE_MIN_INTERVAL_MINUTES = undefined;
    expect(DEFAULT_SCHEDULE_MIN_INTERVAL_MINUTES).toBe(60);
    expect(() => assertScheduleInterval('*/15 * * * *', 'UTC')).toThrow(
      /INVALID_REQUEST: this schedule runs every 15 minutes; the minimum on this deployment is 60 minutes/,
    );
    expect(() => assertScheduleInterval('0 * * * *', 'UTC')).not.toThrow();
    expect(() => assertScheduleInterval('0 9 * * 1-5', 'Asia/Kolkata')).not.toThrow();
  });

  it('honours a configured minimum, and 0 disables the check', () => {
    env.SCHEDULE_MIN_INTERVAL_MINUTES = '360';
    expect(() => assertScheduleInterval('0 * * * *', 'UTC')).toThrow(
      /minimum on this deployment is 360/,
    );
    env.SCHEDULE_MIN_INTERVAL_MINUTES = '0';
    expect(() => assertScheduleInterval('*/5 * * * *', 'UTC')).not.toThrow();
  });
});
