/**
 * Worker-side estimate of the Neon compute the worker is responsible for (WP-W).
 *
 * Neon Free gives 100 CU-hours per project per month; spending them suspends every compute
 * in the project — production included — until the next billing period. Neon bills nothing
 * extra on Free, so the risk is an outage, not a charge, and the only defence is noticing
 * early. Reading Neon's own consumption figures needs a Neon API key, which can administer
 * the project; the worker deliberately holds none. Instead it estimates its own share from
 * what it knows for certain — when it was active and when it went to deep sleep:
 *
 *   awake time = every active period + Neon's 5-minute suspend delay after each one
 *                (or the gap to the next wake, if shorter)
 *   CU-hours   = awake hours × compute size (WORKER_COMPUTE_CU, default 0.25 — set the
 *                Neon compute to a fixed size for the estimate to hold)
 *
 * It is an ESTIMATE of the worker's share only: web traffic wakes the database too, and
 * time the two overlap is counted here in full (so it errs high). The totals live in
 * memory and restart from zero with the process. The Neon console remains the source of
 * truth; this exists so a runaway pattern shows up in the logs within a day, not at the end
 * of the month.
 *
 * Logged: one '[jobs] worker db-wake estimate' line per UTC day, and an error line the first
 * time the month-to-date estimate crosses 70% and 90% of WORKER_DB_BUDGET_CU_HOURS.
 */

export const NEON_SUSPEND_DELAY_MS = 5 * 60 * 1000;
export const WARN_FRACTIONS = [0.7, 0.9] as const;

export interface WakeLedgerOptions {
  computeUnits?: number;
  budgetCuHours?: number;
  suspendDelayMs?: number;
  log?: Pick<Console, 'log' | 'error'>;
}

const monthOf = (at: number) => new Date(at).toISOString().slice(0, 7);
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

export class WakeLedger {
  private readonly computeUnits: number;
  private readonly budgetCuHours: number;
  private readonly suspendDelayMs: number;
  private readonly log: Pick<Console, 'log' | 'error'>;

  private activeSince: number | null = null;
  private sleepingSince: number | null = null;
  private month = '';
  private day = '';
  private monthAwakeMs = 0;
  private dayAwakeMs = 0;
  private wakesToday = 0;
  private warned = new Set<number>();

  constructor(options: WakeLedgerOptions = {}) {
    this.computeUnits = options.computeUnits ?? 0.25;
    this.budgetCuHours = options.budgetCuHours ?? 30;
    this.suspendDelayMs = options.suspendDelayMs ?? NEON_SUSPEND_DELAY_MS;
    this.log = options.log ?? console;
  }

  private add(at: number, ms: number): void {
    this.roll(at);
    this.monthAwakeMs += ms;
    this.dayAwakeMs += ms;
    this.checkThresholds();
  }

  private roll(at: number): void {
    const month = monthOf(at);
    const day = dayOf(at);
    if (this.day !== '' && day !== this.day) this.logDay();
    if (month !== this.month) {
      this.month = month;
      this.monthAwakeMs = 0;
      this.warned.clear();
    }
    if (day !== this.day) {
      this.day = day;
      this.dayAwakeMs = 0;
      this.wakesToday = 0;
    }
  }

  /** The worker became active (start-up or a wake). */
  active(at: number): void {
    if (this.activeSince !== null) return;
    if (this.sleepingSince !== null) {
      // The database stayed awake for the suspend delay after the worker slept — or until
      // this wake, if that came sooner.
      // Booked when it happened (right after the sleep began), not at the wake: across a
      // day or month boundary the tail belongs to the earlier period.
      this.add(
        this.sleepingSince,
        Math.min(this.suspendDelayMs, Math.max(0, at - this.sleepingSince)),
      );
      this.sleepingSince = null;
    }
    this.roll(at);
    this.wakesToday += 1;
    this.activeSince = at;
  }

  /** The worker went to deep sleep. */
  deepSleep(at: number): void {
    if (this.activeSince === null) return;
    this.add(at, Math.max(0, at - this.activeSince));
    this.activeSince = null;
    this.sleepingSince = at;
  }

  /** Month-to-date estimate in CU-hours (closed periods only). */
  monthCuHours(): number {
    return (this.monthAwakeMs / 3_600_000) * this.computeUnits;
  }

  private checkThresholds(): void {
    const used = this.monthCuHours();
    for (const fraction of WARN_FRACTIONS) {
      if (!this.warned.has(fraction) && used >= fraction * this.budgetCuHours) {
        this.warned.add(fraction);
        this.log.error('[jobs] worker db-wake estimate passed budget threshold', {
          month: this.month,
          thresholdPercent: Math.round(fraction * 100),
          estimatedCuHours: Number(used.toFixed(2)),
          budgetCuHours: this.budgetCuHours,
        });
      }
    }
  }

  private logDay(): void {
    this.log.log('[jobs] worker db-wake estimate', {
      day: this.day,
      wakes: this.wakesToday,
      awakeMinutes: Math.round(this.dayAwakeMs / 60_000),
      monthToDateCuHours: Number(this.monthCuHours().toFixed(2)),
      budgetCuHours: this.budgetCuHours,
    });
  }
}
