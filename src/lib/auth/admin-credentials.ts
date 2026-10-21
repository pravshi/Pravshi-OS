import { sql } from 'drizzle-orm';
import { authDb } from '@/lib/db/auth-client';
import { generateResetToken, hashResetToken } from './password-reset';
import { sqlstateOf } from './invitations';
import { ipRateLimitKey } from './rate-limit';

/**
 * The auth layer's surface for administrator-initiated session and credential operations:
 * listing and revoking another person's sessions, and issuing a password reset for them.
 *
 * AUTHORITY COMES FROM THE ADMINISTRATOR'S OWN SESSION (migration 0072). Each operation is one
 * call to a SECURITY DEFINER function on the app_auth connection that takes the administrator's
 * session token — the bearer value Better Auth returns to the server from getSession() — and
 * decides everything from it in the database: the session is live, the person behind it is an
 * active administrator of a live organization with the permission at the required scope and a
 * verified second factor where the MFA rule demands one, and the target person is in that same
 * organization and visible to the administrator under people.view (people_select, 0074 — the
 * reach the business-role lookup had before 0072; a person out of reach is "not found").
 * Nothing here, and nothing a caller writes into app.person_id / app.org_id /
 * app.aal, can widen that. The Server Actions still call requirePermission() first, for clear
 * errors; the database decides again.
 *
 * THE TOKEN IS A BEARER CREDENTIAL. It goes to the database as a bind parameter and nowhere
 * else: never logged, never audited, never returned. A failed query's DrizzleQueryError carries
 * its parameters in its message, so every failure here is replaced by a fixed message chosen
 * from the SQL state alone; the original error is dropped, not chained (an Error `cause` is
 * printed by console.error and captured by error reporting).
 *
 * tests/guards/single-db-path.test.ts pins the boundary: authDb and the auth.auth_* tables are
 * referenced from src/lib/auth/* and src/lib/db/* only.
 */

export type AdminSessionSummary = {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
};

/** Request metadata recorded on the audit entry. Descriptive only — never used to authorize. */
export type AdminActionMeta = {
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
};

export type AdminAuthErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'FORBIDDEN'
  | 'STEP_UP_REQUIRED'
  | 'NOT_FOUND'
  | 'NO_LOGIN'
  | 'SESSION_NOT_FOUND'
  | 'FAILED';

export class AdminAuthActionError extends Error {
  constructor(
    readonly code: AdminAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdminAuthActionError';
  }
}

/**
 * Turn any failure of an administrator definer into a fixed, token-free error. The definers'
 * own RAISE texts are fixed strings (they never interpolate the token); they are matched here
 * only to pick a message, never passed on.
 */
function sanitized(e: unknown): AdminAuthActionError {
  const state = sqlstateOf(e);
  const raised = (e as { cause?: { message?: unknown } } | null)?.cause?.message;
  const text = typeof raised === 'string' ? raised : '';
  if (state === '28000') {
    return new AdminAuthActionError('NOT_AUTHENTICATED', 'Your session is no longer valid.');
  }
  if (state === '42501') {
    if (text.includes('person not found')) {
      return new AdminAuthActionError('NOT_FOUND', 'Person not found.');
    }
    if (text.includes('second factor')) {
      return new AdminAuthActionError(
        'STEP_UP_REQUIRED',
        'A verified second factor is required for this action.',
      );
    }
    return new AdminAuthActionError('FORBIDDEN', 'You are not permitted to do this.');
  }
  if (state === '22023') {
    if (text.includes('has no login')) {
      return new AdminAuthActionError('NO_LOGIN', 'This person has no login.');
    }
    if (text.includes('session not found')) {
      return new AdminAuthActionError('SESSION_NOT_FOUND', 'Session not found.');
    }
  }
  return new AdminAuthActionError('FAILED', 'The request could not be completed.');
}

type SessionActionRow = {
  session_id: string | null;
  created_at: Date | string | null;
  expires_at: Date | string | null;
  ip_address: string | null;
  user_agent: string | null;
  affected: number | null;
};

async function adminSessionAction(
  actorSessionToken: string,
  personId: string,
  action: 'list' | 'revoke_one' | 'revoke_all',
  sessionId: string | null,
  meta: AdminActionMeta,
): Promise<SessionActionRow[]> {
  try {
    const res = await authDb.execute<SessionActionRow>(sql`
      select session_id, created_at, expires_at, ip_address, user_agent, affected
      from authz.admin_session_action(
        ${actorSessionToken}, ${personId}::uuid, ${action}, ${sessionId}::uuid,
        ${meta.requestId}::uuid, ${meta.ip}::inet, ${meta.userAgent}
      )
    `);
    return res.rows;
  } catch (e) {
    throw sanitized(e);
  }
}

const asDate = (v: Date | string | null): Date => (v instanceof Date ? v : new Date(String(v)));

/** Every live session of a same-organization person, newest first. No token is ever returned. */
export async function listSessionsAsAdmin(
  actorSessionToken: string,
  personId: string,
  meta: AdminActionMeta,
): Promise<AdminSessionSummary[]> {
  const rows = await adminSessionAction(actorSessionToken, personId, 'list', null, meta);
  return rows.map((r) => ({
    id: String(r.session_id),
    createdAt: asDate(r.created_at),
    expiresAt: asDate(r.expires_at),
    ipAddress: r.ip_address,
    userAgent: r.user_agent,
  }));
}

/**
 * End one session (keyed on session id AND the target's login, so a session id can never end
 * another login's session) or every session of the person. Deletion, the revocation stamp (for
 * "all") and the audit entry commit together, in the database.
 */
export async function revokeSessionsAsAdmin(
  actorSessionToken: string,
  personId: string,
  sessionId: string | null,
  meta: AdminActionMeta,
): Promise<number> {
  const rows = await adminSessionAction(
    actorSessionToken,
    personId,
    sessionId ? 'revoke_one' : 'revoke_all',
    sessionId,
    meta,
  );
  return Number(rows[0]?.affected ?? 0);
}

const RESET_RATE_LIMIT_MAX = 5;
const RESET_RATE_LIMIT_WINDOW_SECONDS = 60;

export type AdminResetIssue =
  { outcome: 'DENIED' } | { outcome: 'ISSUED'; token: string; loginEmail: string };

/**
 * Issue a password reset for a same-organization person, at an administrator's request. The
 * database decides who may (users.edit, the MFA rule, a target the administrator can see under
 * people.view — 0074 — and ADR-001: a protected-role holder only by an administrator holding
 * roles.manage at GLOBAL scope) and mints the reset for the target's
 * own login: digest only, single use, one-hour expiry, prior unused tokens retired. An ADR-001
 * refusal is audited there and answered as DENIED. Returns the plaintext token — the caller
 * delivers it exactly once. The administrator's IP is rate-limited to the self-service window.
 */
export async function issueAdminPasswordReset(
  actorSessionToken: string,
  personId: string,
  meta: AdminActionMeta,
): Promise<AdminResetIssue> {
  // The same bucket as self-service reset requests (password-reset.ts), built by
  // the same key builder so both keep landing in it (Phase 3, F-SEC-B1-1).
  const rl = await authDb.execute<{ allowed: boolean }>(sql`
    select authz.check_rate_limit(
      ${ipRateLimitKey('pwreset:req', meta.ip)},
      ${RESET_RATE_LIMIT_MAX},
      ${RESET_RATE_LIMIT_WINDOW_SECONDS}
    ) as allowed
  `);
  if (!rl.rows[0]?.allowed) {
    throw new Error('Too many reset requests. Please try again later.');
  }

  const token = generateResetToken();
  const digest = hashResetToken(token);

  let row: { outcome: string; login_email: string | null } | undefined;
  try {
    const res = await authDb.execute<{ outcome: string; login_email: string | null }>(sql`
      select outcome, login_email
      from authz.admin_issue_credential_reset(
        ${actorSessionToken}, ${personId}::uuid, ${digest},
        ${meta.requestId}::uuid, ${meta.ip}::inet, ${meta.userAgent}
      )
    `);
    row = res.rows[0];
  } catch (e) {
    throw sanitized(e);
  }
  if (row?.outcome === 'DENIED') return { outcome: 'DENIED' };
  if (row?.outcome !== 'ISSUED' || !row.login_email) {
    throw new AdminAuthActionError('FAILED', 'Could not issue a reset for this login.');
  }
  return { outcome: 'ISSUED', token, loginEmail: row.login_email };
}
