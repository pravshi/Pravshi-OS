import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { authDb } from '@/lib/db/auth-client';
import { env } from '@/env';
import { generateResetToken, hashResetToken, buildResetUrl } from '@/lib/auth/password-reset';
import { sendResetEmail } from '@/lib/auth/password-reset-email';
import { writeAuditEntry, type RequestMetadata } from '@/lib/audit/log';
import type { Authorization } from '@/lib/authz/require-permission';

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

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60;

export async function adminResetCredential(
  auth: Authorization,
  personId: string,
  meta: RequestMetadata,
): Promise<AdminCredentialReset> {
  // The person must exist in the admin's org and hold a login.
  const target = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<{ auth_user_id: string | null }>(sql`
      select p.auth_user_id
      from public.people p
      where p.id = ${personId}::uuid
        and p.org_id = ${auth.ctx.orgId}::uuid
        and p.deleted_at is null
    `);
    return res.rows[0] ?? null;
  });
  if (!target) throw new Error('Person not found.');
  if (!target.auth_user_id) throw new Error('This person has no login.');

  // The credential lives on the login, so the login's own email addresses the token.
  const login = await authDb.execute<{ email: string }>(sql`
    select u.email from auth.auth_users u where u.id = ${target.auth_user_id}::uuid
  `);
  const loginEmail = login.rows[0]?.email;
  if (!loginEmail) throw new Error('Login not found.');

  const rl = await authDb.execute<{ allowed: boolean }>(sql`
    select authz.check_rate_limit(
      ${`pwreset:req:${meta.ip ?? 'unknown'}`},
      ${RATE_LIMIT_MAX},
      ${RATE_LIMIT_WINDOW_SECONDS}
    ) as allowed
  `);
  if (!rl.rows[0]?.allowed) {
    throw new Error('Too many reset requests. Please try again later.');
  }

  const token = generateResetToken();
  const digest = hashResetToken(token);
  const issued = await authDb.execute<{ reset_id: string | null }>(sql`
    select authz.request_password_reset(${loginEmail}, ${digest}) as reset_id
  `);
  if (!issued.rows[0]?.reset_id) {
    throw new Error('Could not issue a reset for this login.');
  }

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
