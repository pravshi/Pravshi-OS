import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The invitation contract the pre-login accept flow (src/lib/auth/invitations.ts) and the
 * authorised invitation service (src/lib/invitations) share: the token's shape and its stored
 * digest, the accept-input schema, and the typed error both halves throw. It lives in auth, the
 * lower layer (ADR-010), so the auth plane never imports the invitations module; invitations
 * imports these from here.
 */

export const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The value stored in invitations.token_hash. The plaintext never reaches the database. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export const AcceptInvitationSchema = z.strictObject({
  token: z.string().regex(INVITATION_TOKEN_PATTERN),
  fullName: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(256),
});

export type AcceptInvitationInput = z.infer<typeof AcceptInvitationSchema>;

export class InvitationError extends Error {
  constructor(
    readonly code:
      | 'EMAIL_HAS_LOGIN'
      | 'INVITATION_ALREADY_LIVE'
      | 'PERSON_NOT_FOUND'
      | 'PERSON_NOT_INVITABLE'
      | 'PERSON_EMAIL_MISMATCH'
      | 'ENGAGEMENT_REQUIRED'
      | 'DEPARTMENT_NOT_FOUND'
      | 'ROLE_NOT_FOUND'
      | 'ROLE_PROTECTED'
      | 'INVITATION_NOT_FOUND'
      | 'INVITATION_INVALID'
      | 'INVITATION_ALREADY_ACCEPTED'
      | 'INVITATION_CANNOT_COMPLETE'
      | 'PASSWORD_TOO_SHORT'
      | 'PASSWORD_TOO_LONG'
      // F-11-07: the full shared password policy (common list + HIBP breach
      // check) runs on invitation accept, not length alone — see
      // src/lib/auth/invitations.ts.
      | 'PASSWORD_TOO_COMMON'
      | 'PASSWORD_BREACHED',
    message: string,
  ) {
    super(message);
    this.name = 'InvitationError';
  }
}
