/**
 * Waking the worker after new work is committed (WP-W, low-cost worker mode).
 *
 * In low-cost mode the worker sleeps without polling so Neon Free compute can suspend. Code
 * that commits new or rescheduled work calls requestWorkerWake() afterwards — enqueueJob,
 * job retry, reminder and schedule writes, and the forgot-password route — so the worker
 * looks at the queue within seconds instead of at its next scheduled wake.
 *
 * Contract:
 *   - Called only AFTER the work's transaction committed: the worker must find the row.
 *   - Never throws and never fails the caller. A wake that does not arrive is a delay, not
 *     a loss: the job is already durable in Postgres, and the worker's scheduled wakes
 *     (next-due time, capped by WORKER_MAX_SLEEP_MS) pick it up regardless.
 *   - Bounded: one POST, no body, 1 s timeout, redirects refused (the token must never be
 *     replayed to another host). Plain http is refused in production for the same reason.
 *   - Coalesced: after a delivered wake, further calls within WAKE_DEBOUNCE_MS from the same
 *     instance are skipped — the worker stays awake for its active window anyway.
 *   - Backs off: after a failed wake (worker down, refused, rate-limited) further calls
 *     within WAKE_FAILURE_BACKOFF_MS are skipped, so a worker outage costs the web app one
 *     1 s timeout per instance per 30 s, not one per request.
 *   - Inside the worker process it does nothing: the worker is already awake.
 */
import { env } from '@/env';
import { WAKE_TOKEN_HEADER } from './wake-token';
import { isWorkerProcess, markWorkerProcess } from '@/lib/observability/process-context';

export { isWorkerProcess, markWorkerProcess };

export type WakeResult = 'sent' | 'disabled' | 'skipped' | 'debounced' | 'backoff' | 'failed';

export const WAKE_TIMEOUT_MS = 1_000;
export const WAKE_DEBOUNCE_MS = 2_000;
export const WAKE_FAILURE_BACKOFF_MS = 30_000;

let lastSentAt = Number.NEGATIVE_INFINITY;
let lastFailedAt = Number.NEGATIVE_INFINITY;
let warnedInsecure = false;

/** Test hook: forget the last delivered and the last failed wake. */
export function resetWakeDebounce(): void {
  lastSentAt = Number.NEGATIVE_INFINITY;
  lastFailedAt = Number.NEGATIVE_INFINITY;
}

export async function requestWorkerWake(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<WakeResult> {
  const url = env.WORKER_WAKE_URL;
  const token = env.WORKER_WAKE_TOKEN;
  if (!url || !token) return 'disabled';
  if (isWorkerProcess()) return 'skipped';
  if (env.NODE_ENV === 'production' && !url.startsWith('https://')) {
    if (!warnedInsecure) {
      warnedInsecure = true;
      console.error('[jobs] WORKER_WAKE_URL must be https in production; wake disabled');
    }
    return 'disabled';
  }
  if (Date.now() - lastSentAt < WAKE_DEBOUNCE_MS) return 'debounced';
  if (Date.now() - lastFailedAt < WAKE_FAILURE_BACKOFF_MS) return 'backoff';

  const doFetch = options.fetchImpl ?? fetch;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { [WAKE_TOKEN_HEADER]: token },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(options.timeoutMs ?? WAKE_TIMEOUT_MS),
    });
    if (res.status === 202) {
      lastSentAt = Date.now();
      lastFailedAt = Number.NEGATIVE_INFINITY;
      return 'sent';
    }
    lastFailedAt = Date.now();
    console.warn('[jobs] worker wake not accepted', { status: res.status });
    return 'failed';
  } catch (error) {
    lastFailedAt = Date.now();
    const name = (error as { name?: unknown } | null)?.name;
    console.warn('[jobs] worker wake failed', {
      reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
    });
    return 'failed';
  }
}
