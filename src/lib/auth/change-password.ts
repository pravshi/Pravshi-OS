import { sql } from 'drizzle-orm';
import { auth } from './server';
import { authDb } from '@/lib/db/auth-client';
import { sqlstateOf } from './invitations';
import { validateNewPasswordPolicy, PasswordResetError } from './password-reset';
import { writeAuditEntry, type RequestMetadata } from '@/lib/audit/log';
import type { AuthContext } from '@/lib/db/context';
import { logAuthFailure } from './safe-log';

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
 *
 * NO DATABASE ERROR LEAVES THIS MODULE. A failed query surfaces as drizzle's
 * DrizzleQueryError, whose message lists its bound parameters — here the new
 * credential hash and the current session's bearer token — and an error the
 * Server Action rethrows is logged by Next.js. So every database step below
 * answers a failure with a fixed ChangePasswordError and one safe log line (the
 * error's class and codes, src/lib/auth/safe-log.ts); the original is never
 * chained as a cause.
 *
 * The credential update and the session deletion (step 3) are ONE
 * transaction: a failed session deletion rolls the new
 * credential back too, so a failure never leaves a changed password with the
 * other sessions — the ones a password change exists to end — still signed in.
 * The audit entry (step 4) is written afterwards on the business connection; if
 * only it fails, the change stands and the answer says exactly that.
 */

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60;

export class ChangePasswordError extends Error {
  constructor(
    readonly code:
      | 'RATE_LIMITED'
      | 'WRONG_CURRENT_PASSWORD'
      | 'WEAK_PASSWORD'
      | 'CANNOT_COMPLETE'
      | 'UNAVAILABLE'
      | 'NOT_RECORDED',
    readonly reason: 'TOO_SHORT' | 'TOO_LONG' | 'TOO_COMMON' | 'BREACHED' | null,
    message: string,
  ) {
    super(message);
    this.name = 'ChangePasswordError';
  }
}

/** A database failure before or during the change: logged safely, answered fixed. */
function unavailable(step: string, e: unknown): ChangePasswordError {
  logAuthFailure(`auth.password_change.${step}_failed`, e);
  return new ChangePasswordError(
    'UNAVAILABLE',
    null,
    'Your password could not be changed right now. Please try again.',
  );
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

  let allowed: boolean;
  try {
    const rate = await authDb.execute<{ allowed: boolean }>(sql`
      select authz.check_rate_limit(
        ${`pwchange:${authUserId}`},
        ${RATE_LIMIT_MAX},
        ${RATE_LIMIT_WINDOW_SECONDS}
      ) as allowed
    `);
    allowed = rate.rows[0]?.allowed === true;
  } catch (e) {
    throw unavailable('rate_limit', e);
  }
  if (!allowed) {
    throw new ChangePasswordError(
      'RATE_LIMITED',
      null,
      'Too many attempts. Please try again later.',
    );
  }

  const context = await auth.$context;

  // Verify the current password against the stored credential hash. The hash
  // lives in auth.auth_accounts, which only the authentication login reads.
  let storedHash: string | null;
  try {
    const hashRows = await authDb.execute<{ password: string | null }>(sql`
      select password
      from auth.auth_accounts
      where user_id = ${authUserId}::uuid
        and provider_id = 'credential'
    `);
    storedHash = hashRows.rows[0]?.password ?? null;
  } catch (e) {
    throw unavailable('credential_read', e);
  }
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
    await authDb.transaction(async (tx) => {
      await tx.execute(sql`
        select authz.update_credential_password(${authUserId}::uuid, ${newHash})
      `);
      // Every other session dies now. The current one survives — deliberately no
      // sessions_revoked_at stamp, which would invalidate the session this very
      // request is running under.
      await tx.execute(sql`
        delete from auth.auth_sessions
        where user_id = ${authUserId}::uuid
          and token != ${currentSessionToken}
      `);
    });
  } catch (e) {
    // 55000: the login has no credential account — fail closed, never create one.
    if (sqlstateOf(e) === '55000') {
      throw new ChangePasswordError(
        'CANNOT_COMPLETE',
        null,
        'This account cannot change its password this way.',
      );
    }
    throw unavailable('update', e);
  }

  // Audit, attributed to the person by write_audit_log via the ctx identity. The
  // change above has committed: if only this fails, say so — truthfully.
  try {
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
  } catch (e) {
    logAuthFailure('auth.password_change.audit_failed', e);
    throw new ChangePasswordError(
      'NOT_RECORDED',
      null,
      'Your password was changed and your other sessions were signed out, but the change could not be recorded. Please tell your administrator.',
    );
  }

  return { ok: true };
}
