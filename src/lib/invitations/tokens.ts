import { randomBytes } from 'node:crypto';

/**
 * Invitation token primitives.
 *
 * The token is a 256-bit random value, base64url-encoded (43 chars). What the database
 * holds is its SHA-256 hex digest — the same "mailbox holds the secret, database holds
 * the shadow" split as the bootstrap setup token. The digest comparison is by equality
 * against a unique index, not a string compare in application code, so there is no
 * timing side-channel worth defending beyond that.
 *
 * The token's shape (INVITATION_TOKEN_PATTERN) and its stored digest (hashInvitationToken) live in
 * src/lib/auth/invitation-contract.ts, which the pre-login accept flow shares (ADR-010, Step 4);
 * this module keeps generation and the acceptance link.
 */

/** A fresh single-use invitation token. Returned to the caller exactly once. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The acceptance link. The token travels in the URL FRAGMENT (#token=…), so it never
 * appears in a request line, an access log or a Referer header — the invite page reads
 * the fragment client-side and posts it in request bodies from there on.
 */
export function buildInviteUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, '')}/invite#token=${token}`;
}
