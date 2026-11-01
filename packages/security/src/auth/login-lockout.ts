import { sql } from 'drizzle-orm';
import { authDb } from '@/lib/db/auth-client';
import { reportAuthFailure } from './safe-log';

/**
 * LOGIN LOCKOUT (migration 0027).
 *
 * auth.login_lockouts counts consecutive failed password attempts per login: 5
 * failures within 15 minutes locks the account for 15 minutes. The lockout check
 * runs before the credential check; a locked account answers the same generic
 * 401 as a wrong password — the client never learns a lockout exists. The HIGH
 * audit entry (auth.login.lockout) is written inside authz.record_login_failure()
 * when the threshold is crossed. A successful login clears the counter.
 *
 * No helper throws. The CHECK fails closed (Phase 3, S-6): when it cannot answer,
 * the account is treated as locked, so a broken or unreachable check can never
 * silently switch brute-force protection off. The refusal is the locked
 * account's own — same generic 401, same timing parity (src/lib/auth/server.ts) —
 * and it is decided before any account lookup, so it reveals nothing about
 * whether the account exists. The bookkeeping helpers cannot change a response
 * that is already decided; their failures raise an alert (reportAuthFailure)
 * instead of a console line nobody watches.
 */

/** True when the account is inside a 15-minute lockout — or the check cannot tell. Never throws. */
export async function isLockedOut(email: string): Promise<boolean> {
  try {
    const res = await authDb.execute<{ locked: boolean }>(sql`
      select authz.check_login_lockout(${email}) as locked
    `);
    const locked = res.rows[0]?.locked;
    if (typeof locked === 'boolean') return locked;
    // The function always returns one boolean row; anything else is a broken check.
    reportAuthFailure(
      'auth.login.lockout_check_failed',
      new Error('lockout check returned no row'),
    );
    return true;
  } catch (e) {
    reportAuthFailure('auth.login.lockout_check_failed', e);
    return true;
  }
}

/**
 * Records one failed password attempt. The HIGH audit entry on lockout is written
 * inside the function. Never throws and never changes the generic client response.
 * A failure here means attempts stop counting toward a lockout, so it alerts.
 * Meanwhile the login route's rate limit still bounds guesses per client address
 * (IPv6 per /64) — as far as the client address can be trusted: on Vercel it is
 * x-vercel-forwarded-for, which the platform sets (client-address.ts). An invalid address is recorded as NULL rather than failing
 * the cast (forwardedIp), so a forged header cannot stop the counting.
 */
export async function noteLoginFailure(
  email: string,
  ip: string | null,
  userAgent: string | null,
): Promise<void> {
  try {
    await authDb.execute(sql`
      select authz.record_login_failure(${email}, ${ip}::inet, ${userAgent})
    `);
  } catch (e) {
    reportAuthFailure('auth.login.failure_record_failed', e);
  }
}

/**
 * Clears the failure counter AND any live lockout for the login — the definer
 * deletes the ledger row outright, so locked_until goes with the count.
 * Never throws.
 *
 * Two callers with the same intent: a successful login (noteLoginSuccess),
 * and a completed password reset (AUD-21) — a user who proved mailbox control
 * and installed a new credential must be able to sign in with it immediately,
 * not sit out the remainder of a lockout the old password's failures earned.
 */
export async function clearLoginLockout(email: string): Promise<void> {
  try {
    await authDb.execute(sql`
      select authz.clear_login_lockout(${email})
    `);
  } catch (e) {
    reportAuthFailure('auth.login.lockout_clear_failed', e);
  }
}

/** Clears the failure counter after a successful login. Never throws. */
export async function noteLoginSuccess(email: string): Promise<void> {
  await clearLoginLockout(email);
}
