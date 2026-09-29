import { sql } from 'drizzle-orm';
import { auth } from './server';
import { authDb } from '@/lib/db/auth-client';
import { sqlstateOf } from './invitations';
import { validateNewPasswordPolicy, PasswordResetError } from './password-reset';
import { writeAuditEntry, type RequestMetadata } from '@/lib/audit/log';
import type { AuthContext } from '@/lib/db/context';

/**
 * Authenticated password change — the signed-in user's own credential rotation.
 *
 * Unlike the reset flow this path has a session, so it goes further:
 *
 *   1. The current password must verify. Without this, a briefly-unattended
 *      signed-in browser is a password change away from a takeover.
 *   2. The new password runs the same policy as the reset flow
 *      (validateNewPasswordPolicy) — the two entry points must never drift.
 *   3. Every OTHER session dies; the session making the change survives, so the
 *      user is not signed out from under their own change.
 *   4. The change is written to the audit log, attributed to the person.
 *
 * Rate limiting is per login (5/min): the current-password check is the only
 * oracle here, and it must not be guessable at speed.
 *
 * Plaintext passwords are never logged and never reach the database — only the
 * scrypt hash travels past this module.
 */

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60;

export class ChangePasswordError extends Error {
  constructor(
    readonly code: 'RATE_LIMITED' | 'WRONG_CURRENT_PASSWORD' | 'WEAK_PASSWORD' | 'CANNOT_COMPLETE',
    readonly reason: 'TOO_SHORT' | 'TOO_LONG' | 'TOO_COMMON' | 'BREACHED' | null,
    message: string,
  ) {
    super(message);
    this.name = 'ChangePasswordError';
  }
}

export async function changePassword(opts: {
  ctx: AuthContext;
  authUserId: string;
  currentSessionToken: string;
  currentPassword: string;
  newPassword: string;
  meta: RequestMetadata;
}): Promise<{ ok: true }> {
  const { ctx, authUserId, currentSessionToken, currentPassword, newPassword, meta } = opts;

  const rate = await authDb.execute<{ allowed: boolean }>(sql`
    select authz.check_rate_limit(
      ${`pwchange:${authUserId}`},
      ${RATE_LIMIT_MAX},
      ${RATE_LIMIT_WINDOW_SECONDS}
    ) as allowed
  `);
  if (!rate.rows[0]?.allowed) {
    throw new ChangePasswordError(
      'RATE_LIMITED',
      null,
      'Too many attempts. Please try again later.',
    );
  }

  const context = await auth.$context;

  // Verify the current password against the stored credential hash. The hash
  // lives in auth.auth_accounts; app_user holds SELECT there.
  const hashRows = await authDb.execute<{ password: string | null }>(sql`
    select password
    from auth.auth_accounts
    where user_id = ${authUserId}::uuid
      and provider_id = 'credential'
  `);
  const storedHash = hashRows.rows[0]?.password ?? null;
  const currentOk =
    storedHash !== null &&
    (await context.password.verify({ password: currentPassword, hash: storedHash }));
  if (!currentOk) {
    throw new ChangePasswordError(
      'WRONG_CURRENT_PASSWORD',
      null,
      'Your current password is incorrect.',
    );
  }

  // Same policy as the reset flow — never a second, drifting copy.
  try {
    await validateNewPasswordPolicy(newPassword);
  } catch (e) {
    if (e instanceof PasswordResetError) {
      throw new ChangePasswordError('WEAK_PASSWORD', e.reason, e.message);
    }
    throw e;
  }

  const newHash = await context.password.hash(newPassword);
  try {
    await authDb.execute(sql`
      select authz.update_credential_password(${authUserId}::uuid, ${newHash})
    `);
  } catch (e) {
    // 55000: the login has no credential account — fail closed, never create one.
    if (sqlstateOf(e) === '55000') {
      throw new ChangePasswordError(
        'CANNOT_COMPLETE',
        null,
        'This account cannot change its password this way.',
      );
    }
    throw e instanceof Error ? e : new Error(String(e));
  }

  // Every other session dies now. The current one survives — deliberately no
  // sessions_revoked_at stamp, which would invalidate the session this very
  // request is running under.
  await authDb.execute(sql`
    delete from auth.auth_sessions
    where user_id = ${authUserId}::uuid
      and token != ${currentSessionToken}
  `);

  // Audit, attributed to the person by write_audit_log via the ctx identity.
  await writeAuditEntry(
    ctx,
    {
      action: 'auth.password_change',
      entityType: 'auth_user',
      entityId: authUserId,
      result: 'SUCCESS',
      severity: 'HIGH',
      metadata: {},
    },
    meta,
  );

  return { ok: true };
}
