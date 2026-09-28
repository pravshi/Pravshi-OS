import { sql } from 'drizzle-orm';
import { authDb } from '@/lib/db/auth-client';
import { generateResetToken, hashResetToken } from './password-reset';

/**
 * The auth layer's surface for administrator-initiated credential and session
 * operations: listing and revoking a login's sessions, resolving a login's
 * email address, and issuing a password-reset token at an administrator's
 * request.
 *
 * Every auth-schema read/write the admin UI needs lives here — inside the
 * sanctioned auth module — instead of in src/lib/admin/*. Session rows and
 * login credentials live in auth.auth_sessions / auth.auth_users, Better
 * Auth-owned tables with RLS disabled, so they are reached through authDb, the
 * same sanctioned path the password-reset module uses. Business data (the
 * person lookup that scopes everything to the admin's org) still goes through
 * withAuthorizedDb() in the admin service layer.
 * tests/guards/single-db-path.test.ts pins this boundary: authDb and the
 * auth.auth_* tables are referenced from src/lib/auth/* and src/lib/db/* only.
 */

export type AdminSessionSummary = {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
};

/** Every live session row for a login, newest first. */
export async function listSessionsForLogin(authUserId: string): Promise<AdminSessionSummary[]> {
  const res = await authDb.execute<AdminSessionSummary>(sql`
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
 * End one session. The delete is keyed on (session id, login id) so a session
 * id can never be used to kill another login's session. Throws when the row is
 * absent.
 */
export async function revokeSessionForLogin(authUserId: string, sessionId: string): Promise<void> {
  const res = await authDb.execute<{ id: string }>(sql`
    delete from auth.auth_sessions
    where id = ${sessionId}::uuid
      and user_id = ${authUserId}::uuid
    returning id
  `);
  if (!res.rows[0]) throw new Error('Session not found.');
}

/** The login's email address — the address the reset link is sent to. */
export async function loginEmailFor(authUserId: string): Promise<string | null> {
  const res = await authDb.execute<{ email: string }>(sql`
    select u.email from auth.auth_users u where u.id = ${authUserId}::uuid
  `);
  return res.rows[0]?.email ?? null;
}

const RESET_RATE_LIMIT_MAX = 5;
const RESET_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * Issue a password-reset token for a login, at an administrator's request.
 * Returns the plaintext token — the caller delivers it exactly once.
 *
 * Same guarantees as the self-service path: the database holds only the
 * SHA-256 digest (32 random bytes, hex), single-use, one-hour expiry, prior
 * unused tokens retired, and the admin's IP is rate-limited to the same 5/min
 * window. Unlike the self-service path this answers honestly when the login
 * does not exist — the admin already looked the person up.
 */
export async function issueAdminPasswordReset(
  loginEmail: string,
  ip: string | null,
): Promise<string> {
  const rl = await authDb.execute<{ allowed: boolean }>(sql`
    select authz.check_rate_limit(
      ${`pwreset:req:${ip ?? 'unknown'}`},
      ${RESET_RATE_LIMIT_MAX},
      ${RESET_RATE_LIMIT_WINDOW_SECONDS}
    ) as allowed
  `);
  if (!rl.rows[0]?.allowed) {
    throw new Error('Too many reset requests. Please try again later.');
  }

  const token = generateResetToken();
  const digest = hashResetToken(token);

  const issued = await authDb.execute<{ reset_id: string | null }>(sql`
    select authz.request_password_reset(${loginEmail}, ${digest}) as reset_id
  `);
  if (!issued.rows[0]?.reset_id) {
    throw new Error('Could not issue a reset for this login.');
  }

  return token;
}
