/**
 * Invitation-accept error copy — AUD-02.
 *
 * POST /api/invitations/accept answers a machine code (InvitationError.code in
 * src/lib/auth/invitations.ts, shaped by src/app/api/invitations/accept/route.ts).
 * The page used to map only PASSWORD_TOO_SHORT and report EVERYTHING else —
 * including a breached or common password — as "this invitation link is
 * invalid, expired, or already used": a false statement about the invitation
 * when the actual problem was the password, and one that sent users to ask for
 * a new link that would fail the same way.
 *
 * Every code the server can return maps here to an accurate, distinct message.
 * The weak-password wording matches the shared policy's own messages
 * (validateNewPasswordPolicy in src/lib/auth/password-reset.ts): minimum 12
 * characters (MIN_PASSWORD_LENGTH, src/lib/auth/server.ts), maximum 128 (the
 * library default the context config derives), the common-password list, and
 * the breach check.
 *
 * Deliberately NOT finer-grained for INVITATION_INVALID: unknown, expired,
 * accepted and revoked invitations stay indistinguishable, so the page learns
 * nothing a token prober could use.
 */
export function inviteAcceptErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case 'PASSWORD_TOO_SHORT':
      return 'Your password is too short — it must be at least 12 characters.';
    case 'PASSWORD_TOO_LONG':
      return 'Your password is too long — it must be at most 128 characters.';
    case 'PASSWORD_TOO_COMMON':
      return 'That password is too common. Choose a less predictable one.';
    case 'PASSWORD_BREACHED':
      return 'That password has appeared in a data breach. Choose a different one.';
    case 'INVITATION_CANNOT_COMPLETE':
      return 'This invitation cannot be completed. Ask your administrator to send a new one.';
    case 'INVITATION_INVALID':
      return 'This invitation link is invalid, expired, or already used.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'INVALID_REQUEST':
      return 'That request could not be processed. Check the form and try again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

/** Upfront password guidance shown on the acceptance form (same policy as above). */
export const INVITE_PASSWORD_GUIDANCE =
  'At least 12 characters. Avoid common passwords — a password that has appeared in a data breach will be refused.';
