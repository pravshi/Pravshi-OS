import {
  listSessionsAsAdmin,
  revokeSessionsAsAdmin,
  type AdminActionMeta,
  type AdminSessionSummary,
} from '@/lib/auth/admin-credentials';
import type { Authorization } from '@/lib/authz/require-permission';

/**
 * Admin session inspection and revocation. The Server Action authorizes first
 * (requirePermission with sessions.revoke at GLOBAL scope) and hands over its Authorization and
 * the administrator's own session token.
 *
 * The decision is the database's (authz.admin_session_action, migration 0072): it proves the
 * administrator from that session token — not from the Authorization's identity, which on the
 * business connection is only a setting — re-checks sessions.revoke at GLOBAL scope and the MFA
 * rule, and finds the target person only inside the administrator's own organization. Session
 * rows live in the Better Auth-owned tables, reached through the auth module
 * (src/lib/auth/admin-credentials.ts) only; tests/guards/single-db-path.test.ts pins that.
 */

export type AdminSession = AdminSessionSummary;

const metaOf = (auth: Authorization): AdminActionMeta => ({
  requestId: auth.meta.requestId,
  ip: auth.meta.ip,
  userAgent: auth.meta.userAgent,
});

/** Every live session of the target person, newest first. */
export async function listUserSessions(
  auth: Authorization,
  actorSessionToken: string,
  personId: string,
): Promise<AdminSession[]> {
  return listSessionsAsAdmin(actorSessionToken, personId, metaOf(auth));
}

/**
 * End one session. Keyed on (session id, target login) in the database, so a session id can
 * never be used to end another login's session. Revocation and its audit entry commit together.
 */
export async function revokeUserSession(
  auth: Authorization,
  actorSessionToken: string,
  personId: string,
  sessionId: string,
): Promise<void> {
  await revokeSessionsAsAdmin(actorSessionToken, personId, sessionId, metaOf(auth));
}

/**
 * End every session of the target person, now: the rows are deleted AND
 * people.sessions_revoked_at is stamped, so a session that somehow survives the delete (race,
 * restore) still fails its next resolution — one transaction with the audit entry.
 */
export async function revokeAllUserSessions(
  auth: Authorization,
  actorSessionToken: string,
  personId: string,
): Promise<void> {
  await revokeSessionsAsAdmin(actorSessionToken, personId, null, metaOf(auth));
}
