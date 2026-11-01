import { sql } from 'drizzle-orm';
import { recordPlatformFailure, type PlatformRequest } from './guard';
import { orgAdminSetupLink } from './http';
import {
  PlatformError,
  provisionOrganization,
  reissueOrgAdminSetup,
  runPlatformOperation,
  type ProvisionInput,
} from './service';
import { isSetupEmailConfigured, sendOrgAdminSetupEmail } from './setup-email';

/**
 * A provisioned organization's first-administrator setup link, end to end (founder policy
 * 2026-10-29: email only). The token is made in service.ts, turned into a link here and handed
 * to the mailer — and goes nowhere else: not into a response, a log line or the audit. What the
 * caller learns is whether the email was accepted, to whom it went, and when the link expires.
 *
 *   - Not configured (no RESEND_API_KEY / EMAIL_FROM): refused BEFORE anything is created
 *     (503 EMAIL_NOT_CONFIGURED) — no link may exist that nobody can receive.
 *   - Not accepted by the provider: the organization / new link stands (the transaction
 *     committed), the failure is audited (ERROR, EMAIL_DELIVERY_FAILED — never the token), and
 *     the console says so: re-issue to send a fresh link.
 *   - Revocable: revokeOrgAdminSetup ends a pending link without issuing another.
 */
export type SetupDelivery = { emailed: boolean; recipient: string; setupExpiresAt: string };

export function requireEmail(): void {
  if (!isSetupEmailConfigured()) {
    throw new PlatformError(
      503,
      'EMAIL_NOT_CONFIGURED',
      'Setup links are sent by email only, and email delivery is not configured. Nothing was created.',
    );
  }
}

async function deliver(
  req: PlatformRequest,
  operation: 'platform.organization.provision' | 'platform.organization.admin_setup_reissue',
  orgId: string,
  m: { to: string; fullName: string; orgName: string; token: string; expiresAt: string },
): Promise<SetupDelivery> {
  const emailed = await sendOrgAdminSetupEmail({
    to: m.to,
    fullName: m.fullName,
    orgName: m.orgName,
    link: orgAdminSetupLink(m.token),
    expiresAt: new Date(m.expiresAt),
  });
  if (!emailed) {
    await recordPlatformFailure(
      req.actor,
      operation,
      'ERROR',
      'EMAIL_DELIVERY_FAILED',
      req.requestId,
      orgId,
    );
  }
  return { emailed, recipient: m.to, setupExpiresAt: m.expiresAt };
}

export type ProvisionDelivery =
  | ({ replayed: false; orgId: string } & SetupDelivery)
  /** The same request was already completed: nothing new is sent (re-issue to send again). */
  | { replayed: true; orgId: string };

export async function provisionAndEmail(
  req: PlatformRequest,
  input: ProvisionInput,
): Promise<ProvisionDelivery> {
  requireEmail();
  const r = await provisionOrganization(req, input);
  if (r.replayed) return { replayed: true, orgId: r.orgId };
  const d = await deliver(req, 'platform.organization.provision', r.orgId, {
    to: input.adminEmail,
    fullName: input.adminFullName,
    orgName: input.name,
    token: r.setupToken,
    expiresAt: r.setupExpiresAt,
  });
  return { replayed: false, orgId: r.orgId, ...d };
}

export async function reissueAndEmail(req: PlatformRequest, orgId: string): Promise<SetupDelivery> {
  requireEmail();
  // The recipient is the database's — the pending person's work email, fixed until setup
  // completes — read in the same transaction as the new hash.
  const r = await reissueOrgAdminSetup(req, orgId);
  return deliver(req, 'platform.organization.admin_setup_reissue', orgId, {
    to: r.recipient.email,
    fullName: r.recipient.fullName,
    orgName: r.recipient.orgName,
    token: r.setupToken,
    expiresAt: r.setupExpiresAt,
  });
}

/** Ends a pending link without issuing another; audited with the reason. */
export async function revokeOrgAdminSetup(
  req: PlatformRequest,
  orgId: string,
  reason: string,
): Promise<{ revokedAt: string }> {
  const rows = await runPlatformOperation(
    req,
    'platform.organization.admin_setup_revoke',
    {
      '22023': {
        status: 400,
        code: 'INVALID_INPUT',
        message: 'A reason of 3-500 characters is required.',
      },
      '55000': {
        status: 409,
        code: 'CANNOT_REVOKE',
        message: 'The first administrator has already completed setup.',
      },
    },
    (tx) =>
      tx.execute<{ at: Date | string }>(
        sql`select platform.revoke_org_admin_setup(${orgId}::uuid, ${reason}, ${req.requestId}::uuid) as at`,
      ),
    { targetOrgId: orgId, permission: 'platform.organizations.assign_initial_admin' },
  );
  const at = rows.rows[0]?.at;
  if (!at) throw new PlatformError(500, 'INTERNAL', 'Something went wrong. Nothing was changed.');
  return { revokedAt: new Date(at).toISOString() };
}
