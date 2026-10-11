/**
 * The minimum gap between two runs of one schedule (WP-W).
 *
 * Every scheduled run wakes the database — on Neon Free for at least five minutes — so a
 * schedule firing every 15 minutes alone would keep compute awake about a third of the day.
 * SCHEDULE_MIN_INTERVAL_MINUTES (default 60; '0' disables, for paid plans) caps how often a
 * schedule may fire. The rule is checked wherever a schedule becomes able to fire on a new
 * cadence: on create, when its cron or timezone changes, and when a paused schedule is
 * enabled again — including with its cron unchanged, so a frequent schedule paused before
 * the rule existed cannot come back through reactivation. Writes that leave the firing plan
 * alone (renaming, pausing) are not checked.
 *
 * Enforced in the API store (create and update — the paths the app uses), which throws
 * `INVALID_REQUEST: …` errors (assertScheduleInterval), and in the scheduler library's
 * resumeSchedule, which raises its own typed error from the message
 * (scheduleIntervalViolation). The library's createSchedule has no caller in the app and is
 * deliberately left unchecked: tests/jobs/scheduler-tick.test.ts drives the tick through it
 * with every-minute schedules.
 */
import { env } from '@/env';
import { minIntervalMinutes } from './cron';

export const DEFAULT_SCHEDULE_MIN_INTERVAL_MINUTES = 60;

/** The configured minimum in minutes; 0 means the check is off. */
export function scheduleMinIntervalMinutes(): number {
  const configured = env.SCHEDULE_MIN_INTERVAL_MINUTES;
  return configured === undefined ? DEFAULT_SCHEDULE_MIN_INTERVAL_MINUTES : Number(configured);
}

/** null when the cron respects the minimum; otherwise the reason, for the caller to raise. */
export function scheduleIntervalViolation(cron: string, timezone: string): string | null {
  const minimum = scheduleMinIntervalMinutes();
  if (minimum <= 0) return null;
  const gap = minIntervalMinutes(cron, timezone);
  return gap < minimum
    ? `this schedule runs every ${gap} minutes; the minimum on this deployment is ${minimum} minutes`
    : null;
}

/** Throws `INVALID_REQUEST: …` when the cron fires more often than the minimum. */
export function assertScheduleInterval(cron: string, timezone: string): void {
  const violation = scheduleIntervalViolation(cron, timezone);
  if (violation) throw new Error(`INVALID_REQUEST: ${violation}`);
}
