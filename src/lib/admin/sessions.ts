import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { authDb } from '@/lib/db/auth-client';
import { revokeSessionsFor } from '@/lib/auth/session';
import type { Authorization } from '@/lib/authz/require-permission';

/**
 * Admin session inspection and revocation. Every function takes the Authorization
 * that requirePermission() issued — the Server Action authorized first (with the
 * sessions.revoke permission), the service never re-decides.
 *
 * The person lookup is org-scoped through withAuthorizedDb(), so an admin can only
 * reach people in their own tenant. Session rows live in auth.auth_sessions, a
 * Better Auth-owned table with RLS disabled, so they are read and deleted through
 * authDb — the same sanctioned auth-schema path the password-reset module uses.
 */

export type AdminSession = {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
};

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
  const res = await authDb.execute<AdminSession>(sql`
    select
      s.id,
      s.created_at as "createdAt",
      s.expires_at as "expiresAt",
      s.ip_address as "ipAddress",
      s.user_agent as "userAgent"
    from auth.auth_sessions s
    where s.user_id = ${authUserId}::uuid
      and s.expires_at > now()
    order by s.created_at desc
  `);
  return res.rows;
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
  const res = await authDb.execute<{ id: string }>(sql`
    delete from auth.auth_sessions
    where id = ${sessionId}::uuid
      and user_id = ${authUserId}::uuid
    returning id
  `);
  if (!res.rows[0]) throw new Error('Session not found.');
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
