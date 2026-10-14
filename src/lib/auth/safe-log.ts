import { errorSummary, redactText, redactValue } from '@/lib/observability/redact';

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
 * For an error the auth module catches itself and answers with a fixed response: one line with a
 * fixed event name and the error's summary, nothing else.
 */
export function logAuthFailure(event: string, error: unknown): void {
  console.error(`[auth] ${event}`, errorSummary(error));
}
