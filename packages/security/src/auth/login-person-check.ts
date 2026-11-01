import { sql } from 'drizzle-orm';
import { authDb } from '@/lib/db/auth-client';

/**
 * BUG-002 fix — the pre-auth liveness gate for session minting.
 *
 * suspendUser() sets person_status='INACTIVE', and resolve_auth_identity() already
 * refuses such people on every request, so existing sessions die on next use. But
 * nothing stopped a suspended person from minting a FRESH session: the login and
 * MFA-verify routes delegated to Better Auth, which knows nothing about people.
 *
 * The gate lives in databaseHooks.session.create.before (src/lib/auth/server.ts),
 * the single choke point every session creation passes through — the mediated
 * routes AND the raw [...all] endpoints. A refused creation returns false from the
 * hook, which the library turns into 401 UNAUTHORIZED (FAILED_TO_CREATE_SESSION);
 * the mediated routes then record their normal failure events and answer the
 * deliberately generic 401, so suspension is indistinguishable from bad credentials.
 *
 * The question itself goes through authz.login_person_active() (migration 0032), a
 * narrow SECURITY DEFINER function — the same pattern as resolve_login_org() and
 * authz.mfa_enrollment_required() — because the pre-auth app_user cannot read
 * public.people under RLS.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True unless the login maps to a deleted or non-ACTIVE person.
 * A login with no person row (unprovisioned) returns true — resolve_auth_identity()
 * handles the null case, and blocking here would break provisioning flows that
 * mint sessions before the person exists. Fail closed: an unknown user id format,
 * or a database error, refuses the session.
 */
export async function loginPersonActive(authUserId: string): Promise<boolean> {
  if (!UUID.test(authUserId)) return false;
  try {
    const res = await authDb.execute<{ active: boolean }>(sql`
      select authz.login_person_active(${authUserId}::uuid) as active
    `);
    return res.rows[0]?.active === true;
  } catch (e) {
    // Fail closed: a session must never be minted when the liveness check itself
    // cannot be answered. A database outage already fails logins upstream.
    console.error('[auth] login person-active check failed', {
      name: e instanceof Error ? e.name : typeof e,
    });
    return false;
  }
}
