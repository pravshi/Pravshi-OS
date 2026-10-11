/**
 * WakeLatch — how the worker sleeps without polling, and how a wake signal cuts the sleep
 * short (WP-W, low-cost worker mode).
 *
 * The worker loop awaits latch.sleep(ms). A ring() while it sleeps resolves the sleep at
 * once with 'woken'; a ring() while it is busy is remembered (one pending flag, not a count),
 * so the next sleep returns immediately and the loop looks at the queue again. Any number of
 * rings between two sleeps therefore costs exactly one extra look — duplicate signals
 * coalesce instead of queueing up work.
 *
 * Nothing here touches the database. A ring is only "look now"; the queue in Postgres stays
 * the single source of truth, so a lost ring delays work until the next scheduled wake but
 * can never lose it.
 */
export type WakeOutcome = 'woken' | 'timeout';

export class WakeLatch {
  private pending = false;
  private waiter: (() => void) | null = null;
  /** Rings accepted since construction. Observability and tests only. */
  rings = 0;

  ring(): void {
    this.rings += 1;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter();
    } else {
      this.pending = true;
    }
  }

  /** Resolves 'woken' on a ring (or one already pending), 'timeout' after `ms`. */
  sleep(ms: number): Promise<WakeOutcome> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve('woken');
    }
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.waiter = null;
          resolve('timeout');
        },
        Math.max(0, ms),
      );
      this.waiter = () => {
        clearTimeout(timer);
        resolve('woken');
      };
    });
  }
}
