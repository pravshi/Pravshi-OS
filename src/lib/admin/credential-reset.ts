import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { issueAdminPasswordReset, loginEmailFor } from '@/lib/auth/admin-credentials';
import { buildResetUrl } from '@/lib/auth/password-reset';
import { sendResetEmail } from '@/lib/auth/password-reset-email';
import { writeAuditEntry, type RequestMetadata } from '@/lib/audit/log';
import type { Authorization } from '@/lib/authz/require-permission';
import { env } from '@/env';

/**
 * Admin-triggered credential reset. Every function takes the Authorization that
 * requirePermission() issued — the Server Action authorized first (with the
 * users.edit permission), the service never re-decides.
 *
 * Unlike the self-service flow this one is admin-initiated, so the one-time link
 * is returned to the administrator exactly once (the same "shown once" contract
 * as the invitation link) AND emailed when delivery is configured. The token is
 * issued through authz.request_password_reset(), so it carries the same
 * guarantees: 32 random bytes, only the SHA-256 digest stored, single-use,
 * one-hour expiry, prior unused tokens retired. The admin's IP-keyed rate limit
 * is the same 5/min window as the self-service request path.
 *
 * The audit entry (action admin.credential_reset, HIGH) is attributed to the
 * administrator who triggered it — not to the person being reset.
 */

export type AdminCredentialReset = {
  resetUrl: string;
  email: string;
  emailSent: boolean;
};

export async function adminResetCredential(
  auth: Authorization,
  personId: string,
  meta: RequestMetadata,
): Promise<AdminCredentialReset> {
  // The person must exist in the admin's org and hold a login. The guard runs in
  // the same query: whether the target holds a protected role, and whether the
  // actor may manage protected roles.
  //
  // Target-side protection cannot be a plain join in the application: app_user's
  // RLS view of the role tables is self-only, so a join would see none of the
  // target's assignments and conclude "not protected" — failing OPEN. The truth
  // comes from public.person_holds_protected_role() (migration 0027), a
  // SECURITY DEFINER function that answers as the owner through
  // role_is_protected().
  //
  // The actor-side half is the application rendering of branch 1 of
  // public.may_manage_protected_roles(): the actor holds roles.manage at GLOBAL
  // scope in this org. authz.scope_for() is SECURITY DEFINER and already returns
  // NULL when the actor's engagement is not live, so a suspended administrator
  // cannot pass.
  const target = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<{
      auth_user_id: string | null;
      target_protected: boolean;
      actor_may_manage: boolean;
    }>(sql`
      select
        p.auth_user_id,
        public.person_holds_protected_role(p.id, p.org_id) as "target_protected",
        coalesce(authz.scope_for('roles.manage') = 'GLOBAL', false) as "actor_may_manage"
      from public.people p
      where p.id = ${personId}::uuid
        and p.org_id = ${auth.ctx.orgId}::uuid
        and p.deleted_at is null
    `);
    return res.rows[0] ?? null;
  });
  if (!target) throw new Error('Person not found.');
  if (!target.auth_user_id) throw new Error('This person has no login.');

  // Approved policy (ADR-001): a reset on a protected-role holder is refused
  // unless the caller may manage protected roles. The refusal is audited before
  // the throw — writeAuditEntry commits on its own, so the evidence survives
  // the refusal.
  if (target.target_protected && !target.actor_may_manage) {
    await writeAuditEntry(
      auth.ctx,
      {
        action: 'admin.credential_reset',
        entityType: 'person',
        entityId: personId,
        result: 'DENIED',
        severity: 'HIGH',
        metadata: { reason: 'PROTECTED_ROLE_TARGET' },
      },
      meta,
    );
    throw new Error(
      'This person holds a protected role. Only an administrator who may manage protected roles can reset their credential.',
    );
  }

  // The credential lives on the login, so the login's own email addresses the token.
  const loginEmail = await loginEmailFor(target.auth_user_id);
  if (!loginEmail) throw new Error('Login not found.');

  const token = await issueAdminPasswordReset(loginEmail, meta.ip);

  const resetUrl = buildResetUrl(env.APP_URL, token);
  const emailSent = await sendResetEmail(loginEmail, resetUrl);

  await writeAuditEntry(
    auth.ctx,
    {
      action: 'admin.credential_reset',
      entityType: 'person',
      entityId: personId,
      result: 'SUCCESS',
      severity: 'HIGH',
      metadata: { email: loginEmail, email_sent: emailSent },
    },
    meta,
  );

  return { resetUrl, email: loginEmail, emailSent };
}
