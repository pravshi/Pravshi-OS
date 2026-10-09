import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from './server';
import { authDb } from '@/lib/db/auth-client';
import { env } from '@/env';
import { sqlstateOf } from './invitations';
import { isCommonPassword } from './common-passwords';
import { buildResetEmailContent } from './password-reset-email';
import { recordLoginEvent, resolveLoginOrg } from './login-events';
import { clearLoginLockout } from './login-lockout';
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
 * login actually exists, so the response carries no enumeration signal in its
 * body, its status, or its timing (F-11-06: no branch awaits an external call —
 * the email is enqueued, not sent; see enqueueResetEmail).
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

  // No login for this email: stop here, answer generic success. No event, no email.
  if (!resetId) return { ok: true };

  const resetUrl = buildResetUrl(env.APP_URL, token);
  // The send is DECOUPLED from this response (F-11-06): the email goes onto the
  // job plane as an `email` job and the worker delivers it, instead of this
  // request awaiting Resend. The invariant this flow now keeps: NO branch of it
  // awaits an external call. Both branches perform the same shape of work —
  // token generation and local database round-trips — so response time carries
  // no signal about whether the email holds a login. (Awaiting the send here
  // was exactly that signal: an external HTTPS round-trip on the exists-branch
  // only, an order of magnitude above a local round-trip.) Delivery failure is
  // the queue's concern now — retry and dead-letter — and the password_resets
  // row stays the source of truth: the user can simply request again.
  await enqueueResetEmail(resetId, resetUrl);

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
 * Enqueue the reset email on the job plane (F-11-06) — the only delivery path
 * the pre-auth request flow uses. The job is an ordinary `email` job
 * (EmailPayloadSchema: to / subject / html), so the worker's Phase 10 Resend
 * adapter delivers it with the platform's retry, dead-letter and
 * provider-idempotency behaviour.
 *
 * The insert goes through public.enqueue_password_reset_email() (migration
 * 0061), a narrow SECURITY DEFINER on the scheduler_tick_fire pattern. It has
 * to: this caller is pre-authentication — it holds no identity, so there is
 * no Authorization for enqueueJob() and the jobs_insert policy (a live person
 * holding jobs.create) can never admit it — and the definer is capability-
 * shaped so the exception stays narrow: it takes the reset id plus the email
 * CONTENT (only this caller knows the plaintext token the link must carry),
 * derives the recipient and the org FROM THE RESET ROW, and returns null for
 * any reset row that is not live. The job's enqueued_by stays NULL — a
 * system-enqueued job, like the scheduler's; `email` jobs never resolve an
 * execution principal from it.
 *
 * Dedup: the dedup key is `pwreset:<reset id>`, one job per issued token —
 * a repeated request mints a NEW token row (superseding the old), so each
 * live token gets exactly one job and retries of the insert itself are
 * idempotent.
 *
 * Best-effort, mirroring the mailer contract it replaces: a failure is logged
 * by error name only and never thrown, because the response must stay uniform
 * (and the login event below must still be recorded). The token row remains
 * the source of truth; if no job was created the user can simply request again.
 */
async function enqueueResetEmail(resetId: string, resetUrl: string): Promise<boolean> {
  const { subject, html } = buildResetEmailContent(resetUrl);
  try {
    const res = await authDb.execute<{ job_id: string | null }>(sql`
      select public.enqueue_password_reset_email(${resetId}::uuid, ${subject}, ${html}) as job_id
    `);
    if (!res.rows[0]?.job_id) {
      console.error('[auth] reset email enqueue declined: reset row is not live');
      return false;
    }
    return true;
  } catch (e) {
    console.error('[auth] reset email enqueue failed', {
      name: e instanceof Error ? e.name : typeof e,
    });
    return false;
  }
}

/**
 * Complete a reset: validate the new password, consume the single-use token,
 * rotate the credential hash, kill every existing session, clear the login
 * lockout, and record the security-event evidence (login event + audit entry).
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

  // A completed reset also clears the login lockout (AUD-21): mailbox control
  // is proven and the credential is new, so the failures the old password
  // accumulated must not keep the account locked. clear_login_lockout deletes
  // the ledger row — counter and locked_until together — and the helper is
  // never-throw, so a bookkeeping failure cannot un-happen the reset.
  if (email) await clearLoginLockout(email);
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
