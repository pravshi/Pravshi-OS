import { sql } from 'drizzle-orm';
import { auth } from './server';
import { authDb } from '@/lib/db/auth-client';
import { PasswordResetError, validateNewPasswordPolicy } from './password-reset';
import { hashInvitationToken } from '@/lib/invitations/tokens';
import type { AcceptInvitationInput } from '@/lib/invitations/schema';
import { InvitationError } from '@/lib/invitations/service';

/**
 * Invitation acceptance — the pre-authentication half of the invitation flow.
 *
 * This lives in the auth module because the invitee has no session yet: it reaches
 * the database through authDb and the SECURITY DEFINER functions migration 0019
 * installed, exactly the sanctioned exception tests/guards/single-db-path.test.ts
 * documents ("a request cannot present an identity while it is being established").
 * Business data still goes through withAuthorizedDb(); this half creates the login
 * and nothing else.
 */

export interface InvitationPreview {
  email: string;
  orgName: string;
  valid: boolean;
}

/** Pre-authentication: what the accept page may show to the token holder. */
export async function previewInvitation(token: string): Promise<InvitationPreview | null> {
  const digest = hashInvitationToken(token);
  const res = await authDb.execute<{
    email: string;
    org_name: string;
    valid: boolean;
  }>(sql`select email, org_name, valid from public.invitation_preview(${digest})`);
  const row = res.rows[0];
  if (!row || row.email === null) return null;
  return { email: row.email, orgName: row.org_name, valid: row.valid };
}

export interface AcceptedInvitation {
  personId: string;
  orgId: string;
}

/** The shared policy's reasons, in this flow's error vocabulary. */
const WEAK_PASSWORD_CODES = {
  TOO_SHORT: 'PASSWORD_TOO_SHORT',
  TOO_LONG: 'PASSWORD_TOO_LONG',
  TOO_COMMON: 'PASSWORD_TOO_COMMON',
  BREACHED: 'PASSWORD_BREACHED',
} as const;

/**
 * Pre-authentication: consume the invitation and create the login. The password policy
 * and the scrypt hash come from Better Auth's own configuration — this function never
 * invents password rules — and the expensive hash is computed only after the cheap
 * preview says the token is live, so unauthenticated callers cannot use this as a CPU sink.
 *
 * The policy is the FULL shared one — validateNewPasswordPolicy: length, the
 * common-password list, and the HIBP breach check (F-11-07). This flow is the
 * product's primary account-creation path; until Phase 11 it enforced length
 * only, so a known-breached password could be installed at account creation
 * even though reset/change refused it. The check runs before the preview,
 * the reset flow's order (policy before the token is consumed): a weak
 * password is refused without the token being consulted at all, and the
 * scrypt hash still waits for a live preview.
 */
export async function acceptInvitation(input: AcceptInvitationInput): Promise<AcceptedInvitation> {
  const context = await auth.$context;
  try {
    await validateNewPasswordPolicy(input.password);
  } catch (e) {
    if (e instanceof PasswordResetError && e.code === 'WEAK_PASSWORD' && e.reason) {
      // The policy's authored messages are reused verbatim, so the wording a
      // user sees for a weak password is identical on every flow.
      throw new InvitationError(WEAK_PASSWORD_CODES[e.reason], e.message);
    }
    throw e;
  }

  const preview = await previewInvitation(input.token);
  if (!preview || !preview.valid) {
    throw new InvitationError(
      'INVITATION_INVALID',
      'This invitation link is invalid, expired, or already used.',
    );
  }

  const digest = hashInvitationToken(input.token);
  const passwordHash = await context.password.hash(input.password);

  try {
    const res = await authDb.execute<{
      person_id: string;
      auth_user_id: string;
      org_id: string;
    }>(sql`
      select person_id, auth_user_id, org_id
      from public.accept_invitation(${digest}, ${input.fullName}, ${passwordHash})
    `);
    const row = res.rows[0];
    if (!row)
      throw new InvitationError(
        'INVITATION_CANNOT_COMPLETE',
        'The invitation could not be accepted.',
      );
    return { personId: row.person_id, orgId: row.org_id };
  } catch (e) {
    const code = sqlstateOf(e);
    // 28000: unknown, expired, accepted or revoked — deliberately indistinguishable.
    if (code === '28000') {
      throw new InvitationError(
        'INVITATION_INVALID',
        'This invitation link is invalid, expired, or already used.',
      );
    }
    // 55000: the person cannot receive a login, or the email already has one.
    // 23505: a concurrent accept for the same email won the race.
    if (code === '55000' || code === '23505') {
      throw new InvitationError(
        'INVITATION_CANNOT_COMPLETE',
        'This invitation cannot be completed.',
      );
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** drizzle wraps the driver error, so the SQLSTATE may be on the error or on its cause. */
export function sqlstateOf(e: unknown): string | null {
  for (const candidate of [e, (e as { cause?: unknown } | null)?.cause]) {
    const code = (candidate as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}
