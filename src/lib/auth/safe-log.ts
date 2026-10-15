import * as Sentry from '@sentry/nextjs';
import {
  errorSummary,
  redactText,
  redactValue,
  type ErrorSummary,
} from '@/lib/observability/redact';

/**
 * THE AUTHENTICATION PLANE'S LOGGER — Better Auth's `logger.log` (better-auth 1.7: every log call
 * of the library's context logger is handed to it instead of the console) and the auth route's
 * last-resort handler both write through here.
 *
 * Why: Better Auth logs a failed endpoint's error object whole. A failed database query is a
 * drizzle DrizzleQueryError whose message carries every bound parameter, and the session lookup
 * binds the session's bearer token — so before this, a permission error, a timeout or an exhausted
 * auth pool during a session lookup printed the token to the server log (WP-A1 audit, HIGH).
 *
 * What is written: a fixed `[auth]` prefix, the library's message redacted (src/lib/observability/
 * redact.ts), and each argument made safe — an error reduced to its class and code (SQLSTATE,
 * errno or API code) and those of its causes, never its message, parameters, detail or stack; any
 * other value redacted by key and by shape. The level is kept, so errors stay errors: an operator
 * still sees `[auth] INTERNAL_SERVER_ERROR { error: 'DrizzleQueryError', cause: { code: '42501' } }`.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

export function authLog(level: Level, message: string, ...args: unknown[]): void {
  const line = `[auth] ${redactText(typeof message === 'string' ? message : String(message))}`;
  const safe = args.map((a) => redactValue(a));
  if (level === 'error') console.error(line, ...safe);
  else if (level === 'warn') console.warn(line, ...safe);
  else if (level === 'debug') console.debug(line, ...safe);
  else console.info(line, ...safe);
}

/**
 * Better Auth's `logger` option. `level: 'warn'` is the library's own default, kept: this changes
 * how lines are written, not which are.
 */
export const authLoggerOptions = { level: 'warn' as const, log: authLog };

/**
 * Who and which request a failure concerns, so an operator can reconcile it. Identifiers only:
 * a value is kept only when it is a UUID, so a token or other credential passed here by mistake
 * is dropped rather than logged or sent.
 */
export type AuthFailureContext = { authUserId?: string | null; requestId?: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeContext(context: AuthFailureContext | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['authUserId', 'requestId'] as const) {
    const v = context?.[key];
    if (typeof v === 'string' && UUID.test(v)) out[key] = v;
  }
  return out;
}

/**
 * For an error the auth module catches itself and answers with a fixed response: one line with a
 * fixed event name, the error's summary and the (UUID-only) correlation context, nothing else.
 */
export function logAuthFailure(event: string, error: unknown, context?: AuthFailureContext): void {
  console.error(`[auth] ${event}`, { ...errorSummary(error), ...safeContext(context) });
}

/** The first short code anywhere in a summary's cause chain (SQLSTATE, errno, API code). */
function firstCode(s: ErrorSummary | undefined): string | undefined {
  for (let cur = s; cur; cur = cur.cause) if (cur.code) return cur.code;
  return undefined;
}

/** The alert raised for a handled auth failure. Built from the summary — never the error itself. */
export class AuthFailureAlert extends Error {
  override name = 'AuthFailureAlert';
}

/**
 * ALERT VOLUME IS BOUNDED. A database outage makes every change-password attempt fail the same
 * way, and nothing upstream throttles attempts then (the rate limiter itself is a query). Sentry
 * offers no per-event-type limit in the SDK — `sampleRate` thins every error, and a fingerprint
 * only groups events after they are ingested — so the limit is here: at most ALERT_LIMIT alerts
 * per event name per ALERT_WINDOW_MS, per process. Past it, failures are still LOGGED in full
 * (with their login and request ids — the record to reconcile from) but not sent; the next alert
 * after the window reopens carries how many were suppressed, so a burst is never invisible.
 *
 * Bounded state, no timers: one small record per event name (the names are fixed strings in the
 * code; at most ALERT_MAX_KEYS are tracked, and an unknown name past that is suppressed and
 * counted under a shared key), and windows are computed lazily from the clock on each call.
 *
 * Per process: N serverless instances may each send up to ALERT_LIMIT per window — the bound is
 * N × ALERT_LIMIT, still finite and proportional to scale, not to failure count. Sentry's own
 * project rate limits and quotas apply on top.
 */
export const ALERT_LIMIT = 5;
export const ALERT_WINDOW_MS = 10 * 60_000;
const ALERT_MAX_KEYS = 32;
const OVERFLOW_KEY = '(other)';

type AlertWindow = { start: number; sent: number; suppressed: number };
const alertWindows = new Map<string, AlertWindow>();

/** Whether to send this alert now, and how many were suppressed since the last one sent. */
function admitAlert(event: string, now: number): { send: boolean; suppressed: number } {
  const key = alertWindows.has(event) || alertWindows.size < ALERT_MAX_KEYS ? event : OVERFLOW_KEY;
  let w = alertWindows.get(key);
  if (!w || now - w.start >= ALERT_WINDOW_MS) {
    // A new window: carry over what the last one suppressed, to report it with the next alert.
    w = { start: now, sent: 0, suppressed: w?.suppressed ?? 0 };
    alertWindows.set(key, w);
  }
  if (key === OVERFLOW_KEY || w.sent >= ALERT_LIMIT) {
    w.suppressed += 1;
    return { send: false, suppressed: 0 };
  }
  w.sent += 1;
  const suppressed = w.suppressed;
  w.suppressed = 0;
  return { send: true, suppressed };
}

/** Tests only: forget every alert window. */
export function resetAuthAlertLimiter(): void {
  alertWindows.clear();
}

/**
 * A handled failure that must not go unnoticed (a credential change that could not complete, or
 * one that completed but could not be audited): the safe log line above, plus — within the volume
 * bound above — a Sentry alert built only from the event name, the error's class and codes, and
 * the correlation context. The original error is never passed: its message can carry the query's
 * bound parameters.
 */
export function reportAuthFailure(
  event: string,
  error: unknown,
  context?: AuthFailureContext,
): void {
  const { send, suppressed } = admitAlert(event, Date.now());
  logAuthFailure(event, error, context);
  if (!send) return;
  const summary = errorSummary(error);
  const code = firstCode(summary);
  Sentry.captureException(
    new AuthFailureAlert(`${event} ${summary.error}${code ? ` ${code}` : ''}`),
    {
      tags: { auth_event: event, ...(code ? { error_code: code } : {}) },
      extra: {
        error: summary,
        ...safeContext(context),
        ...(suppressed > 0 ? { suppressed_since_last_alert: suppressed } : {}),
      },
    },
  );
}
