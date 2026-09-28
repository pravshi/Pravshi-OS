import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import {
  listSessionsForLogin,
  revokeSessionForLogin,
  type AdminSessionSummary,
} from '@/lib/auth/admin-credentials';
import { revokeSessionsFor } from '@/lib/auth/session';
import type { Authorization } from '@/lib/authz/require-permission';

/**
 * Admin session inspection and revocation. Every function takes the Authorization
 * that requirePermission() issued — the Server Action authorized first (with the
 * sessions.revoke permission), the service never re-decides.
 *
 * The person lookup is org-scoped through withAuthorizedDb(), so an admin can only
 * reach people in their own tenant. Session rows and login credentials live in the
 * Better Auth-owned tables (no RLS), so they are reached through the auth module
 * (src/lib/auth/admin-credentials.ts) — the only sanctioned auth-schema path.
 * Feature code never touches authDb or those tables directly;
 * tests/guards/single-db-path.test.ts pins that boundary.
 */

export type AdminSession = AdminSessionSummary;

/**
 * Resolve the target person's login id, scoped to the admin's org. Throws when the
 * person does not exist here, or holds no login at all.
 */
async function resolveTargetLogin(auth: Authorization, personId: string): Promise<string> {
  const rows = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<{ auth_user_id: string | null }>(sql`
      select p.auth_user_id
      from public.people p
      where p.id = ${personId}::uuid
        and p.org_id = ${auth.ctx.orgId}::uuid
        and p.deleted_at is null
    `);
    return res.rows;
  });
  const row = rows[0];
  if (!row) throw new Error('Person not found.');
  if (!row.auth_user_id) throw new Error('This person has no login.');
  return row.auth_user_id;
}

/** Every live session row for the target login, newest first. */
export async function listUserSessions(
  auth: Authorization,
  personId: string,
): Promise<AdminSession[]> {
  const authUserId = await resolveTargetLogin(auth, personId);
  return listSessionsForLogin(authUserId);
}

/**
 * End one session. The delete is keyed on (session id, target login id) so a
 * session id can never be used to kill another login's session.
 */
export async function revokeUserSession(
  auth: Authorization,
  personId: string,
  sessionId: string,
): Promise<void> {
  const authUserId = await resolveTargetLogin(auth, personId);
  await revokeSessionForLogin(authUserId, sessionId);
}

/**
 * End every session for the target login, now. Reuses revokeSessionsFor(): the
 * rows are deleted AND people.sessions_revoked_at is stamped, so a session that
 * somehow survives the delete (race, restore) still fails its next resolution.
 */
export async function revokeAllUserSessions(auth: Authorization, personId: string): Promise<void> {
  const authUserId = await resolveTargetLogin(auth, personId);
  await revokeSessionsFor(authUserId);
}
