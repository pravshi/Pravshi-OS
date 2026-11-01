import { sql } from 'drizzle-orm';
import { authDb } from '@/lib/db/auth-client';

/**
 * The authentication plane's two questions about platform administrators' logins (0086),
 * asked from Better Auth's own hooks (server.ts) so that they hold on every path — the
 * mediated routes, the raw /api/auth/* endpoints and server-side getSession — not only on
 * platform paths:
 *
 *   loginMaySignIn         a REVOKED platform administrator's login never receives a session
 *                          (S-CONSOLE-3). Fail closed.
 *   endStaleAdminSession   a platform administrator's session past the platform's limits
 *                          (12 h, 30 min idle) is ended before Better Auth reads it, so its
 *                          self-service endpoints apply the console's policy (S-CONSOLE-6).
 *                          A tenant user's session is never touched.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loginMaySignIn(authUserId: string): Promise<boolean> {
  if (!UUID.test(authUserId)) return false;
  try {
    const r = await authDb.execute<{ ok: boolean }>(
      sql`select platform.login_may_sign_in(${authUserId}::uuid) as ok`,
    );
    return r.rows[0]?.ok === true;
  } catch (e) {
    console.error('[auth] platform sign-in check failed', {
      name: e instanceof Error ? e.name : typeof e,
    });
    return false;
  }
}

/**
 * True when the session was a platform administrator's past the limits, and is now ended.
 * Fails closed: if the question cannot be answered the request fails — but never with the
 * driver's error, whose message carries the query's parameters, here the bearer token itself
 * (review S2-2). Only the error's name and SQLSTATE are logged; a fresh error is thrown.
 */
export async function endStaleAdminSession(token: string): Promise<boolean> {
  if (token.length === 0 || token.length > 512) return false;
  try {
    const r = await authDb.execute<{ ended: boolean }>(
      sql`select platform.end_stale_admin_session(${token}) as ended`,
    );
    return r.rows[0]?.ended === true;
  } catch (e) {
    const sqlstate = sqlstateOf(e);
    console.error('[auth] platform session check failed', {
      name: e instanceof Error ? e.name : typeof e,
      sqlstate,
    });
    throw new PlatformSessionCheckError(sqlstate);
  }
}

/** Carries the SQLSTATE and nothing else, by design. */
export class PlatformSessionCheckError extends Error {
  constructor(readonly sqlstate: string | null) {
    super('the platform session check could not be completed');
    this.name = 'PlatformSessionCheckError';
  }
}

function sqlstateOf(e: unknown): string | null {
  for (const c of [e, (e as { cause?: unknown } | null)?.cause]) {
    const code = (c as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}
