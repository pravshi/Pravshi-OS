import { sql } from 'drizzle-orm';
import { authDb } from '@/lib/db/auth-client';

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
 * Every helper is fail-open and never throws: lockout bookkeeping must never
 * break authentication itself. The route (src/app/api/auth/login/route.ts)
 * answers with generic credentials errors regardless of what happens here.
 */

/** True when the account is inside a 15-minute lockout. Never throws. */
export async function isLockedOut(email: string): Promise<boolean> {
  try {
    const res = await authDb.execute<{ locked: boolean }>(sql`
      select authz.check_login_lockout(${email}) as locked
    `);
    return res.rows[0]?.locked ?? false;
  } catch (e) {
    console.error('[auth/login] lockout check failed', {
      name: e instanceof Error ? e.name : typeof e,
    });
    return false;
  }
}

/**
 * Records one failed password attempt. The HIGH audit entry on lockout is written
 * inside the function. Never throws and never changes the generic client response.
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
    console.error('[auth/login] failure recording failed', {
      name: e instanceof Error ? e.name : typeof e,
    });
  }
}

/** Clears the failure counter after a successful login. Never throws. */
export async function noteLoginSuccess(email: string): Promise<void> {
  try {
    await authDb.execute(sql`
      select authz.clear_login_lockout(${email})
    `);
  } catch (e) {
    console.error('[auth/login] lockout clear failed', {
      name: e instanceof Error ? e.name : typeof e,
    });
  }
}
