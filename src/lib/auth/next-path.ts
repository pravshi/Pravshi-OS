/**
 * The post-login return path ("next") — AUD-21.
 *
 * When an unauthenticated request hits an application page, requireAuthenticated()
 * (src/lib/authz/page.ts) redirects to /login carrying the intended path as a
 * `next` query parameter, and the login flow sends the user there after sign-in.
 * That convenience is an open-redirect vulnerability the moment the value is
 * trusted: /login?next=https://evil.example would bounce a freshly signed-in
 * user — session cookie freshly minted — to an attacker site.
 *
 * So `next` is honoured ONLY when it is unambiguously a path on this origin:
 *
 *   - it must start with exactly one '/' (a second slash — '//evil.example' —
 *     is a protocol-relative URL, not a path);
 *   - it must contain no backslash ('/\evil.example' and '\/evil.example' are
 *     treated as host separators by some URL parsers);
 *   - it must contain no whitespace or control characters (which parsers may
 *     strip, changing the meaning after validation);
 *   - it must not point back at the authentication surface itself (/login,
 *     /mfa, /forgot-password, /invite, /reset-password, /access-denied) —
 *     returning there after sign-in is a loop, not a destination.
 *
 * Anything else yields null and the caller falls back to the default
 * destination. This module is pure and shared: the server builds the redirect
 * with it, the client validates with it again before navigating.
 */

const AUTH_SURFACE_PREFIXES = [
  '/login',
  '/mfa',
  '/forgot-password',
  '/reset-password',
  '/invite',
  '/access-denied',
] as const;

/** True when `path` is a same-origin relative path safe to return to after sign-in. */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  if (raw[0] !== '/') return null;
  if (raw.startsWith('//')) return null;
  if (raw.includes('\\')) return null;
  // Whitespace and control characters (incl. DEL) anywhere in the value.
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return null;
  const pathname = raw.split(/[?#]/, 1)[0]!;
  for (const prefix of AUTH_SURFACE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return null;
  }
  return raw;
}

/**
 * The /login URL for an unauthenticated request to `pathname`: carries the
 * intended path as `next` when it is a safe return target distinct from the
 * default destination, and is the bare /login otherwise.
 */
export function loginPathForNext(pathname: string | null | undefined): string {
  const next = safeNextPath(pathname);
  if (next === null || next === '/') return '/login';
  return `/login?next=${encodeURIComponent(next)}`;
}
