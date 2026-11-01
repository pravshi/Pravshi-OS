import { issueAdminPasswordReset } from '@/lib/auth/admin-credentials';
import { buildResetUrl } from '@/lib/auth/password-reset';
import { sendResetEmail } from '@/lib/auth/password-reset-email';
import { writeAuditEntry, type RequestMetadata } from '@/lib/audit/log';
import type { Authorization } from '@/lib/authz/require-permission';
import { env } from '@/env';

/**
 * Admin-triggered credential reset. The Server Action authorizes first (requirePermission with
 * users.edit) and hands over its Authorization and the administrator's own session token.
 *
 * The decision is the database's (authz.admin_issue_credential_reset, migration 0072): it proves
 * the administrator from that session token — not from the Authorization's identity, which on
 * the business connection is only a setting — re-checks users.edit and the MFA rule, finds the
 * target only inside the administrator's own organization, and applies ADR-001: a reset on a
 * protected-role holder is refused unless the administrator holds roles.manage at GLOBAL scope.
 * That refusal is audited in the database (result DENIED) before it is answered, so the evidence
 * survives the refusal.
 *
 * Unlike the self-service flow this one is admin-initiated, so the one-time link is returned to
 * the administrator exactly once (the same "shown once" contract as the invitation link) AND
 * emailed when delivery is configured. The reset is minted by authz.request_password_reset(), so
 * it carries the same guarantees: 32 random bytes, only the SHA-256 digest stored, single-use,
 * one-hour expiry, prior unused tokens retired. The admin's IP-keyed rate limit is the same 5/min
 * window as the self-service request path.
 *
 * The success entry (action admin.credential_reset, HIGH) is written after the send, so it can
 * record whether the email went out; it is attributed to the administrator who triggered it —
 * not to the person being reset.
 */

export type AdminCredentialReset = {
  resetUrl: string;
  email: string;
  emailSent: boolean;
};

export async function adminResetCredential(
  auth: Authorization,
  actorSessionToken: string,
  personId: string,
  meta: RequestMetadata,
): Promise<AdminCredentialReset> {
  const issued = await issueAdminPasswordReset(actorSessionToken, personId, {
    requestId: meta.requestId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  if (issued.outcome === 'DENIED') {
    throw new Error(
      'This person holds a protected role. Only an administrator who may manage protected roles can reset their credential.',
    );
  }

  const resetUrl = buildResetUrl(env.APP_URL, issued.token);
  const emailSent = await sendResetEmail(issued.loginEmail, resetUrl);

  await writeAuditEntry(
    auth.ctx,
    {
      action: 'admin.credential_reset',
      entityType: 'person',
      entityId: personId,
      result: 'SUCCESS',
      severity: 'HIGH',
      metadata: { email: issued.loginEmail, email_sent: emailSent },
    },
    meta,
  );

  return { resetUrl, email: issued.loginEmail, emailSent };
}
