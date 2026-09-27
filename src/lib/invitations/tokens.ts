import { createHash, randomBytes } from 'node:crypto';

/**
 * Invitation token primitives.
 *
 * The token is a 256-bit random value, base64url-encoded (43 chars). What the database
 * holds is its SHA-256 hex digest — the same "mailbox holds the secret, database holds
 * the shadow" split as the bootstrap setup token. The digest comparison is by equality
 * against a unique index, not a string compare in application code, so there is no
 * timing side-channel worth defending beyond that.
 */

export const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A fresh single-use invitation token. Returned to the caller exactly once. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The value stored in invitations.token_hash. The plaintext never reaches the database. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * The acceptance link. The token travels in the URL FRAGMENT (#token=…), so it never
 * appears in a request line, an access log or a Referer header — the invite page reads
 * the fragment client-side and posts it in request bodies from there on.
 */
export function buildInviteUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, '')}/invite#token=${token}`;
}
