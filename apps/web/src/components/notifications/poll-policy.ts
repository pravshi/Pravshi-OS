/**
 * When the notification bell may poll the unread count (Phase 12 F-12-08, WP-W).
 *
 * Every poll is a database query. A tab left open and visible on an unattended screen used
 * to poll every 60 s all night, which on Neon Free keeps compute from ever suspending and
 * spends the project's monthly CU-hours. So the bell polls only while the tab is visible AND
 * someone has used the page within IDLE_AFTER_MS; activity after an idle spell refreshes at
 * once, so a returning user sees a current count immediately.
 */
export const POLL_INTERVAL_MS = 60_000;
export const IDLE_AFTER_MS = 10 * 60_000;

export function shouldPollUnread(state: {
  visible: boolean;
  lastActivityAt: number;
  now: number;
  idleAfterMs?: number;
}): boolean {
  return state.visible && state.now - state.lastActivityAt < (state.idleAfterMs ?? IDLE_AFTER_MS);
}
