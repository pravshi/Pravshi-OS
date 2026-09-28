import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from './server';
import { authDb } from '@/lib/db/auth-client';
import { env } from '@/env';
import { sqlstateOf } from './invitations';
import { isCommonPassword } from './common-passwords';
import { sendResetEmail } from './password-reset-email';
import { recordLoginEvent, resolveLoginOrg } from './login-events';
import { revokeSessionsFor } from './session';

/**
 * Password reset — the pre-authentication half of the reset flow.
 *
 * Same posture as the invitation flow: the requester has no session yet, so this
 * reaches the database through authDb and the SECURITY DEFINER functions migration
 * 0024 installed, the sanctioned pre-auth exception. Business data still goes
 * through withAuthorizedDb(); this half rotates a credential and nothing else.
 *
 * ── TOKEN SHAPE ───────────────────────────────────────────────────────────────
 *
 * The reset token is 32 random bytes, hex-encoded (64 chars) for the email link —
 * hex, not base64url, so the token can travel in a query string without encoding
 * surprises. What the database holds is its SHA-256 hex digest (also 64 chars),
 * the same "mailbox holds the secret, database holds the shadow" split as the
 * invitation tokens. Deliberately separate primitives from the invitation module:
 * the two token kinds must never be interchangeable.
 */

export const RESET_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** A fresh single-use reset token. Returned to the caller exactly once, in the email link. */
export function generateResetToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * The value stored in auth.password_resets.token_hash and passed to
 * authz.request_password_reset() / authz.consume_password_reset().
 * The plaintext token never reaches the database.
 */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function buildResetUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, '')}/reset-password?token=${token}`;
}

export class PasswordResetError extends Error {
  constructor(
    readonly code: 'RATE_LIMITED' | 'INVALID_TOKEN' | 'WEAK_PASSWORD' | 'RESET_CANNOT_COMPLETE',
    readonly reason: 'TOO_SHORT' | 'TOO_LONG' | 'TOO_COMMON' | 'BREACHED' | null,
    message: string,
  ) {
    super(message);
    this.name = 'PasswordResetError';
  }
}

const EmailSchema = z.string().trim().email().max(254);

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * The shared new-password policy: Better Auth's configured min/max length, the
 * local common-password list, then the HIBP k-anonymity breach check (which
 * fails open with a warning — availability over strictness, the local list is
 * the backstop). The change-password flow reuses this; the policy must never
 * drift between the two entry points.
 */
export async function validateNewPasswordPolicy(password: string): Promise<void> {
  const context = await auth.$context;
  const { minPasswordLength, maxPasswordLength } = context.password.config;
  if (password.length < minPasswordLength) {
    throw new PasswordResetError(
      'WEAK_PASSWORD',
      'TOO_SHORT',
      `Password must be at least ${minPasswordLength} characters.`,
    );
  }
  if (password.length > maxPasswordLength) {
    throw new PasswordResetError(
      'WEAK_PASSWORD',
      'TOO_LONG',
      `Password must be at most ${maxPasswordLength} characters.`,
    );
  }
  if (isCommonPassword(password)) {
    throw new PasswordResetError(
      'WEAK_PASSWORD',
      'TOO_COMMON',
      'That password is too common. Choose a less predictable one.',
    );
  }
  // The expensive hash is computed only after every cheap check passed, so
  // unauthenticated callers cannot use this endpoint as a CPU sink.
  if (await isBreachedPassword(password)) {
    throw new PasswordResetError(
      'WEAK_PASSWORD',
      'BREACHED',
      'That password has appeared in a data breach. Choose a different one.',
    );
  }
}

/** Fixed-window check via authz.check_rate_limit(); false means the caller is over allowance. */
async function underRateLimit(key: string): Promise<boolean> {
  const res = await authDb.execute<{ allowed: boolean }>(sql`
    select authz.check_rate_limit(${key}, ${RATE_LIMIT_MAX}, ${RATE_LIMIT_WINDOW_SECONDS}) as allowed
  `);
  return res.rows[0]?.allowed ?? false;
}

/**
 * Request a reset link. ALWAYS answers { ok: true } — whether the email holds a
 * login is never revealed, and the login event is emitted only server-side when a
 * login actually exists, so the response carries no enumeration signal at all.
 */
export async function requestPasswordReset(
  email: string,
  ip: string | null,
): Promise<{ ok: true }> {
  const parsed = EmailSchema.safeParse(email);
  if (!parsed.success) {
    // Malformed input answers the same generic success: even the shape of the
    // email must not become an oracle. (The route still validates for 400s on
    // structurally broken bodies; this is the service-level backstop.)
    return { ok: true };
  }
  const cleanEmail = parsed.data;

  if (!(await underRateLimit(`pwreset:req:${ip ?? 'unknown'}`))) {
    throw new PasswordResetError(
      'RATE_LIMITED',
      null,
      'Too many requests. Please try again later.',
    );
  }

  const token = generateResetToken();
  const digest = hashResetToken(token);

  const res = await authDb.execute<{ reset_id: string | null }>(sql`
    select authz.request_password_reset(${cleanEmail}, ${digest}) as reset_id
  `);
  const resetId = res.rows[0]?.reset_id ?? null;

  // No login for this email: stop here, answer generic success. No event, no email,
  // and no timing oracle worth defending — the digest round-trip dominates anyway.
  if (!resetId) return { ok: true };

  const resetUrl = buildResetUrl(env.APP_URL, token);
  // Awaited like the invitation mailer: the email is the deliverable here, and a
  // fire-and-forget send risks the serverless function freezing before Resend is
  // reached. A false return is logged inside sendResetEmail; the row stays the
  // source of truth and the user can simply request again.
  await sendResetEmail(cleanEmail, resetUrl);

  await recordLoginEvent({
    orgId: await resolveLoginOrg(cleanEmail),
    eventType: 'PASSWORD_RESET_REQUESTED',
    email: cleanEmail,
    authUserId: null,
    ip,
    userAgent: null,
  });

  return { ok: true };
}

/**
 * Complete a reset: validate the new password, consume the single-use token,
 * rotate the credential hash, kill every existing session, and record the
 * security-event evidence (login event + audit entry).
 */
export async function resetPassword(
  token: string,
  password: string,
  ip: string | null,
): Promise<{ ok: true }> {
  if (!(await underRateLimit(`pwreset:complete:${ip ?? 'unknown'}`))) {
    throw new PasswordResetError(
      'RATE_LIMITED',
      null,
      'Too many requests. Please try again later.',
    );
  }

  if (typeof token !== 'string' || !RESET_TOKEN_PATTERN.test(token)) {
    throw new PasswordResetError(
      'INVALID_TOKEN',
      null,
      'This reset link is invalid, expired, or already used.',
    );
  }

  const context = await auth.$context;
  // Shared policy (length, common-password list, HIBP) — identical for reset
  // and change; see validateNewPasswordPolicy.
  await validateNewPasswordPolicy(password);

  const digest = hashResetToken(token);

  let authUserId: string;
  try {
    const res = await authDb.execute<{ auth_user_id: string }>(sql`
      select authz.consume_password_reset(${digest}) as auth_user_id
    `);
    const row = res.rows[0];
    if (!row)
      throw new PasswordResetError(
        'INVALID_TOKEN',
        null,
        'This reset link is invalid, expired, or already used.',
      );
    authUserId = row.auth_user_id;
  } catch (e) {
    // 28000: unknown, expired or already-used token — deliberately indistinguishable.
    if (sqlstateOf(e) === '28000') {
      throw new PasswordResetError(
        'INVALID_TOKEN',
        null,
        'This reset link is invalid, expired, or already used.',
      );
    }
    throw e instanceof Error ? e : new Error(String(e));
  }

  const passwordHash = await context.password.hash(password);
  try {
    await authDb.execute(sql`
      select authz.update_credential_password(${authUserId}::uuid, ${passwordHash})
    `);
  } catch (e) {
    // 55000: the login has no credential account — fail closed, never create one.
    if (sqlstateOf(e) === '55000') {
      throw new PasswordResetError(
        'RESET_CANNOT_COMPLETE',
        null,
        'This account cannot reset its password this way.',
      );
    }
    throw e instanceof Error ? e : new Error(String(e));
  }

  // The new credential must be the only live one: every session minted under the
  // old password dies now, via both halves of revokeSessionsFor().
  await revokeSessionsFor(authUserId);

  const email = await lookupLoginEmail(authUserId);
  await recordLoginEvent({
    orgId: email ? await resolveLoginOrg(email) : null,
    eventType: 'PASSWORD_RESET_COMPLETED',
    email,
    authUserId,
    ip,
    userAgent: null,
  });

  // Audit entry, attributed to the person being reset. Best-effort like every
  // login-event write: the reset already happened, and a missing audit row must
  // never un-happen it.
  try {
    await authDb.execute(sql`
      select authz.record_password_reset_audit(${authUserId}::uuid, ${ip}::inet, ${null}::text)
    `);
  } catch (e) {
    console.error('[auth] password-reset audit recording failed', {
      name: e instanceof Error ? e.name : typeof e,
    });
  }

  return { ok: true };
}

/** app_user holds a SELECT grant on auth.auth_users (no RLS-sensitive people lookup needed). */
async function lookupLoginEmail(authUserId: string): Promise<string | null> {
  try {
    const res = await authDb.execute<{ email: string }>(sql`
      select email from auth.auth_users where id = ${authUserId}::uuid
    `);
    return res.rows[0]?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * HIBP k-anonymity check: only the first 5 hex chars of the password's SHA-1 ever
 * leave the server, and the full hash is never transmitted. A network failure
 * fails OPEN (logged) — the local common-password list is the half that always
 * applies, and a downed breach API must not lock users out of resetting.
 */
async function isBreachedPassword(password: string): Promise<boolean> {
  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Pravshi-OS password breach check' },
    });
    if (!res.ok) {
      console.warn('[auth] HIBP breach check failed open', { status: res.status });
      return false;
    }
    const body = await res.text();
    return body.split('\n').some((line) => line.split(':')[0]?.trim().toUpperCase() === suffix);
  } catch (e) {
    console.warn('[auth] HIBP breach check failed open', {
      name: e instanceof Error ? e.name : typeof e,
    });
    return false;
  }
}
