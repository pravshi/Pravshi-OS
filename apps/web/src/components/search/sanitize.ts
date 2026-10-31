/**
 * Safe navigation URLs for search results (Phase 8, Workstream D).
 *
 * RISK (contract): XSS via result titles/URLs. Titles are rendered as React
 * text (auto-escaped — dangerouslySetInnerHTML is never used for search
 * output). URLs get an allowlist check here: only same-origin app paths are
 * navigable. Anything else renders as a non-interactive card instead of a
 * link, so a compromised or malformed `url` can never become a
 * `javascript:` / external navigation.
 */

/**
 * Returns the URL when it is a safe same-origin app path, otherwise null.
 * Rejects absolute URLs, protocol-relative URLs, and backslash tricks that
 * browsers normalize to `/`.
 */
export function sanitizeResultUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (url === '') return null;
  if (!url.startsWith('/')) return null;
  if (url.startsWith('//')) return null;
  if (url.includes('\\')) return null;
  return url;
}

/**
 * Person results (contract note from Workstream B): there is no person detail
 * page — the users list at /admin/users is the surface, and the API emits
 * `/admin/users/<personId>` URLs that resolve to nothing.
 *
 * Graceful handling: viewers WITH `users.view` link to the users list;
 * viewers WITHOUT it get no link at all (linking would just bounce them to
 * /access-denied).
 */
export function personResultUrl(canViewUsers: boolean): string | null {
  return canViewUsers ? '/admin/users' : null;
}
