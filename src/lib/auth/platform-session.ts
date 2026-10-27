import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { auth } from './server';
import { authDb } from '@/lib/db/auth-client';

/**
 * The Better Auth half of a platform administrator's request (ADR-008, design §3.3): which
 * login is asking, on which session, how assured, and whether that session is still within the
 * platform's own limits. The platform half — whether that login is a platform administrator —
 * is src/lib/platform/identity.ts, on the app_platform login.
 *
 * Limits stricter than a tenant's (src/lib/auth/server.ts), enforced here from the session row
 * itself, never from a cached copy:
 *   - 12 hours from the session's creation (absolute);
 *   - 30 minutes since the last platform request on it (idle). Each platform request stamps the
 *     session's updated_at; a session found idle or too old is deleted, not merely refused.
 * The assurance level is the one stamped on the session at creation (aal1 / aal2): a session
 * does not gain assurance after the fact. "Fresh" — created within the last 10 minutes — is the
 * step-up the design requires for sensitive actions: the administrator signs in again (password
 * and second factor) to perform them.
 */
export const PLATFORM_SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const PLATFORM_SESSION_IDLE_MS = 30 * 60 * 1000;
export const PLATFORM_STEP_UP_MS = 10 * 60 * 1000;

export interface PlatformSession {
  authUserId: string;
  sessionId: string;
  /**
   * Hex SHA-256 of the session's bearer token. The database binds the platform actor to it
   * (0086): an id alone is not a credential — Better Auth shows session ids to the browser.
   */
  tokenSha256: string;
  aal: 'aal1' | 'aal2';
  /** Created within PLATFORM_STEP_UP_MS, with a second factor: may perform sensitive actions. */
  fresh: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a request counts as the administrator's own activity, extending the idle clock
 * (S-CONSOLE-9). A state change does: its Origin was verified before it got here. A read does
 * only when the browser says it came from this site or from the user directly
 * (Sec-Fetch-Site: same-origin or none) — never a cross-site navigation (a SameSite=Lax cookie
 * still rides on one) and never a request without that header.
 */
export function countsAsActivity(headers: Headers, method: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return true;
  const site = headers.get('sec-fetch-site');
  return site === 'same-origin' || site === 'none';
}

/** The request's live Better Auth session, before any platform question is asked. */
export async function readRequestSession(
  headers: Headers,
): Promise<{ authUserId: string; sessionId: string; tokenSha256: string } | null> {
  const session = await auth.api.getSession({ headers });
  const userId = session?.user?.id;
  const sessionId = session?.session?.id;
  const token = session?.session?.token;
  if (
    typeof userId !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof token !== 'string' ||
    token.length === 0 ||
    !UUID.test(userId)
  ) {
    return null;
  }
  const tokenSha256 = createHash('sha256').update(token, 'utf8').digest('hex');
  return { authUserId: userId, sessionId, tokenSha256 };
}

/**
 * The platform's limits applied to a session ALREADY KNOWN to belong to a platform
 * administrator's login (src/lib/platform/identity.ts asks first). Never call it for any other
 * session: a tenant user's session has its own, longer limits and must not be deleted or
 * stamped by a request that merely reached a platform path. null: past a limit, and deleted.
 * Database errors propagate, so a caller fails closed.
 */
export async function enforcePlatformSessionLimits(
  current: {
    authUserId: string;
    sessionId: string;
    tokenSha256: string;
  },
  opts: { activity: boolean },
): Promise<PlatformSession | null> {
  const { authUserId: userId, sessionId, tokenSha256 } = current;

  const rows = await authDb.execute<{
    created_at: Date;
    updated_at: Date;
    aal: string | null;
    now: Date;
  }>(sql`
    select s.created_at, s.updated_at, s.aal, now() as now
    from auth.auth_sessions s
    where s.id = ${sessionId} and s.user_id = ${userId}::uuid and s.expires_at > now()
  `);
  const row = rows.rows[0];
  if (!row) return null;

  const now = new Date(row.now).getTime();
  const created = new Date(row.created_at).getTime();
  const lastSeen = new Date(row.updated_at).getTime();
  if (now - created > PLATFORM_SESSION_ABSOLUTE_MS || now - lastSeen > PLATFORM_SESSION_IDLE_MS) {
    await authDb.execute(sql`
      delete from auth.auth_sessions where id = ${sessionId} and user_id = ${userId}::uuid
    `);
    return null;
  }

  // Only the administrator's own activity extends the idle clock (S-CONSOLE-9): not a
  // cross-site navigation, not a request without browser provenance.
  if (opts.activity) {
    await authDb.execute(sql`
      update auth.auth_sessions set updated_at = now()
      where id = ${sessionId} and user_id = ${userId}::uuid
    `);
  }

  const aal = row.aal === 'aal2' ? 'aal2' : 'aal1';
  return {
    authUserId: userId,
    sessionId,
    tokenSha256,
    aal,
    fresh: aal === 'aal2' && now - created <= PLATFORM_STEP_UP_MS,
  };
}
