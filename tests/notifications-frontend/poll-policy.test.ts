/**
 * WP-W — the notification bell's polling rule: visible AND used within 10 minutes.
 */
import { describe, expect, it } from 'vitest';
import {
  IDLE_AFTER_MS,
  POLL_INTERVAL_MS,
  shouldPollUnread,
} from '@/components/notifications/poll-policy';

const NOW = 1_000_000_000;

describe('shouldPollUnread', () => {
  it('polls a visible tab someone used recently', () => {
    expect(shouldPollUnread({ visible: true, lastActivityAt: NOW - 60_000, now: NOW })).toBe(true);
  });

  it('never polls a hidden tab', () => {
    expect(shouldPollUnread({ visible: false, lastActivityAt: NOW, now: NOW })).toBe(false);
  });

  it('stops polling a visible tab nobody has used for 10 minutes', () => {
    expect(IDLE_AFTER_MS).toBe(10 * 60_000);
    expect(shouldPollUnread({ visible: true, lastActivityAt: NOW - IDLE_AFTER_MS, now: NOW })).toBe(
      false,
    );
    expect(
      shouldPollUnread({ visible: true, lastActivityAt: NOW - IDLE_AFTER_MS + 1, now: NOW }),
    ).toBe(true);
  });

  it('keeps the 60 s interval', () => {
    expect(POLL_INTERVAL_MS).toBe(60_000);
  });
});
