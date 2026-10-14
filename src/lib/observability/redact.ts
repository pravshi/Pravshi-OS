/**
 * ONE REDACTION POLICY FOR EVERYTHING THAT LEAVES THE PROCESS AS DIAGNOSTICS — server logs and
 * Sentry events, on the server, the edge and in the browser.
 *
 * WHY IT EXISTS. A failed database query surfaces as drizzle's DrizzleQueryError, whose message is
 * `Failed query: <sql>\nparams: <every bound value>`, and drizzle wraps EVERY failure that way —
 * a permission error, a statement timeout, a dropped or exhausted connection. The session lookup
 * binds the session's bearer token, so a failed lookup put the token in the error, Better Auth
 * logged the error whole, and anyone reading the logs could take over the session (WP-A1 audit,
 * HIGH). Credentials also travel in URLs (`/reset-password?token=…`, `/invite#token=…`,
 * `/setup#token=…`), which the browser SDK records on every event and navigation breadcrumb.
 *
 * THE POLICY, in order of strength:
 *   1. An error is never logged as itself. `errorSummary` keeps its class name and a short code
 *      (a SQLSTATE such as 42501, a Node errno such as ECONNREFUSED, or an API error code) and
 *      the same for its causes — never a message, a `params` array, a `detail` or a stack.
 *   2. A value under a credential-named key (token, password, cookie, authorization, secret,
 *      session…) is replaced whole, at any depth.
 *   3. Every remaining string goes through `redactText`, which removes the shapes credentials
 *      take in text: drizzle's `params:` tail, credential query and fragment parameters, bearer
 *      and basic credentials, auth cookie values, connection-string passwords, Postgres
 *      `Key (col)=(value)` details, and any long opaque token-shaped run (32+ characters of
 *      letters, digits, `_` or `-`, containing both a letter and a digit) — the shape of a session
 *      token, a reset or invitation token, or a signed cookie value.
 * Rule 3 is the backstop, not the mechanism: rules 1 and 2 keep the values out structurally, so
 * a credential in a shape rule 3 does not know still does not reach the output through an error.
 *
 * Pure TypeScript with no runtime dependency (the Sentry import is type-only), so the browser
 * bundle can import it.
 */

import type { Breadcrumb, Event } from '@sentry/nextjs';

export const REDACTED = '[redacted]';

/** Keys whose values are credentials wherever they appear (compared case-insensitively). */
const CREDENTIAL_KEY =
  /^(?:.*[-_.])?(?:token|tokens|password|passwd|pwd|secret|cookie|cookies|set-cookie|authorization|auth|session|session_token|sessiontoken|params|parameters|api[-_]?key|apikey|backup[-_]?codes?|otp|totp|credential|credentials|signature)$/i;

/**
 * `name=value` pairs that carry credentials — in a query string or fragment (`?token=…`,
 * `#token=…`) or anywhere in free text (`… token=…`).
 */
const CREDENTIAL_PARAM =
  /(?<=^|[?&#;\s,(\[{"'])((?:token|reset_token|resettoken|code|password|secret|api_key|apikey|access_token|refresh_token|id_token|session_token|sig|signature)=)(?!\[redacted\])[^&#\s"'<>,;)\]}]*/gi;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TEXT_RULES: [RegExp, string | ((match: string) => string)][] = [
  // drizzle: `Failed query: <sql>\nparams: <values>` — everything from `params:` on.
  [/\bparams:[\s\S]*$/i, `params: ${REDACTED}`],
  // pg-style details: Key (token)=(abc…) already exists.
  [/\(([^()]*)\)=\(([^()]*)\)/g, `($1)=(${REDACTED})`],
  [CREDENTIAL_PARAM, `$1${REDACTED}`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // Auth cookies, with or without the secure prefix, URL-encoded or not.
  [
    /\b((?:__Secure-|__Host-)?[A-Za-z0-9_-]*(?:session_token|session_data|dont_remember|two_factor)[A-Za-z0-9_-]*)=([^;\s"',]+)/gi,
    `$1=${REDACTED}`,
  ],
  // postgres://user:password@host — the password.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s]+@/gi, `$1${REDACTED}@`],
  // Long opaque token-shaped runs (letters AND digits, 32+ chars) — but not a UUID, which is an
  // identifier (request, person, record) the diagnostics need for correlation.
  [
    /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g,
    (m) => (UUID.test(m) ? m : REDACTED),
  ],
];

/** Remove credential-shaped content from free text. Idempotent. */
export function redactText(input: string): string {
  let out = input;
  for (const [pattern, replacement] of TEXT_RULES) {
    out =
      typeof replacement === 'string'
        ? out.replace(pattern, replacement)
        : out.replace(pattern, replacement);
  }
  return out;
}

/** A short, non-sensitive code from an error-like value, when it has one. */
function codeOf(e: Record<string, unknown>): string | undefined {
  for (const key of ['code', 'errno', 'sqlState', 'sqlstate']) {
    const v = e[key];
    if (typeof v === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(v)) return v;
  }
  const body = e.body as { code?: unknown } | undefined;
  if (body && typeof body.code === 'string' && /^[A-Z0-9_]{1,60}$/.test(body.code))
    return body.code;
  return undefined;
}

export type ErrorSummary = {
  error: string;
  code?: string;
  status?: string | number;
  cause?: ErrorSummary;
};

const isErrorLike = (v: unknown): v is Record<string, unknown> =>
  v instanceof Error ||
  (typeof v === 'object' && v !== null && 'name' in v && 'message' in v && 'stack' in v);

/**
 * What may be said about an error: its class and its code, and the same for its causes (three
 * levels). Never its message, parameters, detail, query or stack.
 */
export function errorSummary(e: unknown, depth = 0): ErrorSummary {
  if (!isErrorLike(e) && (typeof e !== 'object' || e === null)) {
    return { error: typeof e };
  }
  const obj = e as Record<string, unknown>;
  // The most specific safe class name: DrizzleQueryError and the driver's DatabaseError leave
  // `.name` as "Error"/"error", so the constructor's name is preferred when it says more.
  const ctorName = (obj.constructor as { name?: unknown } | undefined)?.name;
  const identifier = (v: unknown): v is string =>
    typeof v === 'string' && /^[A-Za-z_$][A-Za-z0-9_$.]{0,59}$/.test(v);
  const generic = (v: string) => ['error', 'object'].includes(v.toLowerCase()) || v.length < 3;
  const name =
    identifier(ctorName) && !generic(ctorName)
      ? ctorName
      : identifier(obj.name)
        ? obj.name
        : 'Error';
  const summary: ErrorSummary = { error: name };
  const code = codeOf(obj);
  if (code) summary.code = code;
  const status = obj.status ?? obj.statusCode;
  if (
    typeof status === 'number' ||
    (typeof status === 'string' && /^[A-Z_0-9]{1,40}$/.test(status))
  )
    summary.status = status;
  if (depth < 3 && obj.cause !== undefined && obj.cause !== null) {
    summary.cause = errorSummary(obj.cause, depth + 1);
  }
  return summary;
}

/**
 * Any value, made safe to log or send: errors become summaries, credential-named keys are
 * replaced, strings are redacted, and depth and breadth are bounded.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' ? '[function]' : value;
  }
  if (isErrorLike(value)) return errorSummary(value);
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (n++ >= 100) {
      out['…'] = '[truncated]';
      break;
    }
    out[key] = CREDENTIAL_KEY.test(key) ? REDACTED : redactValue(v, depth + 1);
  }
  return out;
}

// ── Sentry ────────────────────────────────────────────────────────────────────────────────
// Typed against the SDK's own Event and Breadcrumb. The import is type-only, so it is erased from
// every bundle, the browser's included.

const SENSITIVE_HEADER =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-[a-z0-9-]*(token|key|secret|signature)[a-z0-9-]*)$/i;

/** A breadcrumb, safe to keep: message redacted, data redacted (console arguments included). */
export function scrubBreadcrumb<T extends Breadcrumb>(crumb: T): T {
  if (typeof crumb.message === 'string') crumb.message = redactText(crumb.message);
  if (crumb.data) crumb.data = redactValue(crumb.data) as Record<string, unknown>;
  return crumb;
}

/**
 * An event (error or transaction), safe to send: no cookies, no credential headers, no request
 * body, and every message, exception value, URL, breadcrumb, span and structured field redacted.
 */
export function scrubEvent<T extends Event>(event: T): T {
  if (typeof event.message === 'string') event.message = redactText(event.message);
  if (event.logentry) {
    if (typeof event.logentry.message === 'string')
      event.logentry.message = redactText(event.logentry.message);
    if (Array.isArray(event.logentry.params))
      event.logentry.params = event.logentry.params.map((p: unknown) => redactValue(p));
  }
  if (typeof event.transaction === 'string') event.transaction = redactText(event.transaction);
  for (const ex of event.exception?.values ?? []) {
    if (typeof ex.value === 'string') ex.value = redactText(ex.value);
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map((b) => scrubBreadcrumb(b));
  const req = event.request;
  if (req) {
    delete req.cookies;
    delete req.data;
    if (typeof req.url === 'string') req.url = redactText(req.url);
    if (req.query_string !== undefined) {
      req.query_string =
        typeof req.query_string === 'string'
          ? redactText(`?${req.query_string}`).slice(1)
          : (redactValue(req.query_string) as typeof req.query_string);
    }
    if (req.headers) {
      for (const h of Object.keys(req.headers)) {
        if (SENSITIVE_HEADER.test(h)) delete req.headers[h];
        else if (typeof req.headers[h] === 'string') req.headers[h] = redactText(req.headers[h]);
      }
    }
  }
  if (event.extra) event.extra = redactValue(event.extra) as Record<string, unknown>;
  if (event.contexts) {
    // The trace context's identifiers (32/16 hex) link the event to its trace and carry no
    // credential; everything else in it — op, status, data attributes with URLs — is scrubbed.
    const { trace, ...rest } = event.contexts;
    const contexts = redactValue(rest) as Record<string, unknown>;
    if (trace && typeof trace === 'object') {
      const t = trace as unknown as Record<string, unknown>;
      const scrubbed = redactValue(t) as Record<string, unknown>;
      for (const id of ['trace_id', 'span_id', 'parent_span_id']) {
        const v = t[id];
        if (typeof v === 'string' && /^[0-9a-f]{16,32}$/.test(v)) scrubbed[id] = v;
      }
      contexts.trace = scrubbed;
    }
    event.contexts = contexts as typeof event.contexts;
  }
  if (event.tags) event.tags = redactValue(event.tags) as typeof event.tags;
  for (const span of event.spans ?? []) {
    if (typeof span.description === 'string') span.description = redactText(span.description);
    if (span.data) span.data = redactValue(span.data) as typeof span.data;
  }
  return event;
}
