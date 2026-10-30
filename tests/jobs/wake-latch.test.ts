/**
 * WP-W — WakeLatch: the worker's interruptible sleep. DB-free.
 */
import { describe, expect, it } from 'vitest';
import { WakeLatch } from '@/worker/wake-latch';

describe('WakeLatch', () => {
  it('times out when nobody rings', async () => {
    const latch = new WakeLatch();
    const started = Date.now();
    expect(await latch.sleep(40)).toBe('timeout');
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });

  it('a ring during the sleep wakes it at once', async () => {
    const latch = new WakeLatch();
    const started = Date.now();
    const sleeping = latch.sleep(10_000);
    setTimeout(() => latch.ring(), 20);
    expect(await sleeping).toBe('woken');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('a ring while busy is remembered: the next sleep returns immediately', async () => {
    const latch = new WakeLatch();
    latch.ring();
    expect(await latch.sleep(10_000)).toBe('woken');
    // ...and consumed: the sleep after that waits normally.
    expect(await latch.sleep(20)).toBe('timeout');
  });

  it('duplicate rings coalesce into one wake, never a backlog', async () => {
    const latch = new WakeLatch();
    for (let i = 0; i < 50; i++) latch.ring();
    expect(await latch.sleep(10_000)).toBe('woken');
    expect(await latch.sleep(20)).toBe('timeout');
    expect(latch.rings).toBe(50);
  });

  it('rings during a sleep beyond the first are also coalesced', async () => {
    const latch = new WakeLatch();
    const sleeping = latch.sleep(10_000);
    latch.ring();
    latch.ring();
    latch.ring();
    expect(await sleeping).toBe('woken');
    // One remembered ring from the duplicates, then quiet.
    expect(await latch.sleep(10_000)).toBe('woken');
    expect(await latch.sleep(20)).toBe('timeout');
  });
});
