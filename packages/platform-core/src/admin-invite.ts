import { recordPlatformFailure, type PlatformRequest } from './guard';
import { platformSetupLink } from './http';
import { requireEmail, type SetupDelivery } from './org-admin-setup';
import { inviteAdmin, reissueAdminSetup } from './service';
import { sendPlatformAdminSetupEmail } from './setup-email';

/**
 * A platform administrator's setup link, end to end (founder decision 2026-10-29: email only,
 * as for an organization's first administrator). The token is made in service.ts, turned into a
 * link here and handed to the mailer — and goes nowhere else: not into a response, a log line,
 * the console or the audit. The caller learns whether the email was accepted, to whom it went,
 * and when the link expires.
 *
 *   - Not configured (no RESEND_API_KEY / EMAIL_FROM): refused BEFORE anything is created
 *     (503 EMAIL_NOT_CONFIGURED).
 *   - Not accepted by the provider: the invitation / new link stands, the failure is audited
 *     (ERROR, EMAIL_DELIVERY_FAILED — never the token); re-issue to send a fresh link.
 *   - A replayed invitation (same idempotency key) sends nothing.
 *   - Single use and 72-hour expiry are the database's (0083); revoking the administrator ends
 *     the link. The operator CLI (first administrator, break-glass recovery) is unchanged: it
 *     runs before any mail path exists and prints to the operator's own terminal.
 */
export type InviteDelivery =
  ({ replayed: false; adminId: string } & SetupDelivery) | { replayed: true; adminId: string };

async function deliver(
  req: PlatformRequest,
  operation: 'platform.admin.invite' | 'platform.admin.setup_reissue',
  m: { to: string; fullName: string; token: string; expiresAt: string },
): Promise<SetupDelivery> {
  const emailed = await sendPlatformAdminSetupEmail({
    to: m.to,
    fullName: m.fullName,
    link: platformSetupLink(m.token),
    expiresAt: new Date(m.expiresAt),
  });
  if (!emailed) {
    await recordPlatformFailure(
      req.actor,
      operation,
      'ERROR',
      'EMAIL_DELIVERY_FAILED',
      req.requestId,
    );
  }
  return { emailed, recipient: m.to, setupExpiresAt: m.expiresAt };
}

export async function inviteAndEmail(
  req: PlatformRequest,
  input: { idempotencyKey: string; email: string; fullName: string; permissions: string[] },
): Promise<InviteDelivery> {
  requireEmail();
  const r = await inviteAdmin(req, input);
  if (r.replayed) return { replayed: true, adminId: r.adminId };
  const d = await deliver(req, 'platform.admin.invite', {
    to: input.email,
    fullName: input.fullName,
    token: r.setupToken,
    expiresAt: r.setupExpiresAt,
  });
  return { replayed: false, adminId: r.adminId, ...d };
}

export async function reissueAdminAndEmail(
  req: PlatformRequest,
  adminId: string,
): Promise<SetupDelivery> {
  requireEmail();
  // The recipient is the invitation's own address, read with the new hash (service.ts).
  const r = await reissueAdminSetup(req, adminId);
  return deliver(req, 'platform.admin.setup_reissue', {
    to: r.recipient.email,
    fullName: r.recipient.fullName,
    token: r.setupToken,
    expiresAt: r.setupExpiresAt,
  });
}
