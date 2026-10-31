/**
 * WP-W — WakeLedger, the worker's own estimate of the Neon compute it causes. DB-free.
 */
import { describe, expect, it, vi } from 'vitest';
import { NEON_SUSPEND_DELAY_MS, WakeLedger } from '@/worker/usage-estimate';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 12, 9, 0, 0); // 2026-10-12 09:00 UTC

const quietLog = () => ({ log: vi.fn(), error: vi.fn() });

describe('WakeLedger', () => {
  it('counts each active period plus the 5-minute suspend delay after it', () => {
    const ledger = new WakeLedger({ computeUnits: 0.25, log: quietLog() });
    ledger.active(T0);
    ledger.deepSleep(T0 + 2 * MIN); // 2 min active
    ledger.active(T0 + 60 * MIN); // the 5 min tail after the sleep is counted on wake
    ledger.deepSleep(T0 + 61 * MIN); // 1 min active
    // 2 + 5 + 1 = 8 minutes awake (the second tail is not closed yet).
    expect(ledger.monthCuHours()).toBeCloseTo((8 / 60) * 0.25, 6);
  });

  it('a wake sooner than the suspend delay counts only the gap (compute never slept)', () => {
    const ledger = new WakeLedger({ log: quietLog() });
    ledger.active(T0);
    ledger.deepSleep(T0 + 1 * MIN);
    ledger.active(T0 + 3 * MIN); // 2 min later: compute was still awake
    ledger.deepSleep(T0 + 4 * MIN);
    // 1 + 2 + 1 = 4 minutes
    expect(ledger.monthCuHours()).toBeCloseTo((4 / 60) * 0.25, 6);
    expect(NEON_SUSPEND_DELAY_MS).toBe(5 * MIN);
  });

  it('warns once each at 70% and 90% of the budget', () => {
    const log = quietLog();
    // Budget 0.1 CU-h at 1 CU = 6 minutes awake.
    const ledger = new WakeLedger({ computeUnits: 1, budgetCuHours: 0.1, log });
    ledger.active(T0);
    ledger.deepSleep(T0 + 4.5 * MIN); // 75%
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]![1]).toMatchObject({ thresholdPercent: 70 });
    ledger.active(T0 + 4.6 * MIN);
    ledger.deepSleep(T0 + 5.6 * MIN); // past 90%
    ledger.active(T0 + 5.7 * MIN);
    ledger.deepSleep(T0 + 6.5 * MIN);
    const thresholds = log.error.mock.calls.map(
      (c) => (c[1] as { thresholdPercent: number }).thresholdPercent,
    );
    expect(thresholds).toEqual([70, 90]);
  });

  it('logs one summary per UTC day and restarts the month total in a new month', () => {
    const log = quietLog();
    const ledger = new WakeLedger({ log });
    const lastDay = Date.UTC(2026, 9, 31, 23, 0, 0);
    ledger.active(lastDay);
    ledger.deepSleep(lastDay + 10 * MIN);
    expect(ledger.monthCuHours()).toBeGreaterThan(0);
    const nextMonth = Date.UTC(2026, 10, 1, 1, 0, 0);
    ledger.active(nextMonth);
    expect(log.log).toHaveBeenCalledWith(
      '[jobs] worker db-wake estimate',
      expect.objectContaining({ day: '2026-10-31', wakes: 1 }),
    );
    ledger.deepSleep(nextMonth + 1 * MIN);
    // Only November's minute (the October tail was booked to October).
    expect(ledger.monthCuHours()).toBeCloseTo((1 / 60) * 0.25, 6);
  });
});
