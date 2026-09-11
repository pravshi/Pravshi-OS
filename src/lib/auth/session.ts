import { sql } from 'drizzle-orm';
import { auth } from './server';
import { authDb } from '@/lib/db/auth-client';
import type { AuthContext } from '@/lib/db/context';

/**
 * Session → PRAVSHI OS identity.
 *
 * This is the seam between authentication and everything else. Above it, Better Auth knows
 * a cookie belongs to a login. Below it, the entire authorization model — engagements,
 * roles, permissions, scope_for(), RLS — takes over and this layer has no further say.
 *
 * ── WHAT IT RETURNS, AND WHAT null MEANS ─────────────────────────────────────────
 *
 * An AuthContext, or null. null means "no PRAVSHI OS identity", and it is returned for a
 * valid, signed-in Better Auth session just as readily as for no session at all:
 *
 *   no session cookie                    nobody is asking
 *   session, but no people row points     authenticated, and not anybody here. THIS IS THE
 *     at that login                       IMPORTANT ONE — see below.
 *   person soft-deleted or not ACTIVE     identity-level liveness, the same condition
 *                                         authz.person_id() applies
 *   session older than                    bulk revocation
 *     people.sessions_revoked_at
 *
 * ── AN AUTHENTICATED STRANGER GETS NOTHING ───────────────────────────────────────
 *
 * Threat T-01 is that someone becomes a company user by authenticating. They cannot. A
 * login is linked to a person by an administrator writing public.people.auth_user_id; there
 * is no code path here that creates a person, an engagement, an organization, a role or a
 * permission, and resolve_auth_identity() has no parameter that could suggest one. An
 * auth_user nothing points at resolves to null and reaches nothing.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DECIDE ─────────────────────────────────────────
 *
 * Whether the engagement is ACTIVE, whether the organization is ACTIVE, and anything about
 * roles or permissions. Blueprint 7.4 orders the questions — authenticated (401), engaged
 * (403), assured (403), permitted (403), in scope (404) — and this function answers only
 * the first. The rest are already enforced by authz.is_active() and the policies, re-read
 * from the tables on every query, which is what makes offboarding take effect on the very
 * next request rather than at the next login.
 *
 * A person whose engagement ended therefore still resolves here and then reaches nothing.
 * That is step 2 working, not step 1 failing.
 */
export async function resolveAuthContext(headers: Headers): Promise<AuthContext | null> {
  const session = await auth.api.getSession({ headers });
  if (!session?.user?.id) return null;

  // The library already refuses an expired session; this is the PRAVSHI OS half.
  const rows = await authDb.execute<{ person_id: string; org_id: string }>(sql`
    select person_id, org_id
    from public.resolve_auth_identity(
      ${session.user.id}::uuid,
      ${session.session.createdAt.toISOString()}::timestamptz
    )
  `);

  const identity = rows.rows[0];
  if (!identity) return null;

  return {
    personId: identity.person_id,
    // From the person row, never from the session. A cookie cannot propose a tenant.
    orgId: identity.org_id,
    /**
     * Read from the session row, where it was stamped at creation. Not derived from the
     * person's enrolment status: a session minted before the person enrolled, or by any
     * path that did not verify a second factor, carries aal1 and keeps it.
     *
     * authz.aal() will refuse this claim anyway if the person holds no verified factor, so
     * the two layers have to agree before anything reaches aal2.
     */
    aal: session.session.aal === 'aal2' ? 'aal2' : 'aal1',
  };
}

/**
 * Ends every session belonging to a person, immediately.
 *
 * Two halves, and both are needed. Deleting the rows kills the sessions that exist now;
 * stamping sessions_revoked_at means any session that somehow survives — issued in a race,
 * or restored from a backup — fails its next resolution. Blueprint section 25 calls the
 * stamp "simpler and exact" compared with a token epoch, and this is where it is written.
 *
 * Offboarding, suspension and `sessions.revoke` all end up here. The engagement-driven half
 * of revocation needs no help: authz.is_active() re-reads the tables on every query.
 */
export async function revokeSessionsFor(authUserId: string): Promise<void> {
  await authDb.execute(sql`
    delete from auth.auth_sessions where user_id = ${authUserId}::uuid
  `);
}
