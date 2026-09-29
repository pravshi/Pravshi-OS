import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { auth } from './server';
import { authDb } from '@/lib/db/auth-client';

/**
 * MFA enrollment enforcement for privileged roles.
 *
 * A person holding users.manage or roles.manage (any scope) must have a verified
 * TOTP factor. This is enrollment, not session assurance: the existing mandatory
 * MFA in require-permission.ts already demands aal2 for sensitive operations, but
 * a privileged user with no factor at all would otherwise meet only a bare 403.
 * This module steers them to enroll instead.
 *
 * The privilege/enrollment question lives in authz.mfa_enrollment_required()
 * (migration 0027), which takes the login id directly — scope_for() cannot be
 * used because it reads the transaction identity, which does not exist pre-auth.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the login's person is privileged and has no verified TOTP factor. */
export async function mfaEnrollmentRequired(authUserId: string): Promise<boolean> {
  if (!UUID.test(authUserId)) return false;
  try {
    const res = await authDb.execute<{ required: boolean }>(sql`
      select authz.mfa_enrollment_required(${authUserId}::uuid) as required
    `);
    return res.rows[0]?.required ?? false;
  } catch (e) {
    // Fail closed on the check itself: a database error must not silently lift
    // the enrollment gate. The admin layout redirects to enrollment; the login
    // route treats a failed check as "no requirement" only for the redirect hint
    // (the gate itself still applies on the next page load).
    console.error('[auth] mfa enrollment check failed', {
      name: e instanceof Error ? e.name : typeof e,
    });
    return true;
  }
}

/**
 * For layouts and pages: redirects to /login when there is no session, and to
 * /me/security (with the enrollment notice) when the signed-in user must enroll
 * in TOTP and hasn't. The (app)/admin layout calls this; /me/security itself
 * must not, or enrollment would be unreachable.
 */
export async function requireMfaEnrolled(): Promise<void> {
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (!session?.user?.id) redirect('/login');
  if (await mfaEnrollmentRequired(session.user.id)) {
    redirect('/me/security?enrollment=required');
  }
}
