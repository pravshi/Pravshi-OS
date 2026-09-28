import { sql } from 'drizzle-orm';
import { authDb } from '@/lib/db/auth-client';

/**
 * Shared IP-based rate limiting for routes the per-flow services don't cover.
 *
 * Fixed-window check via authz.check_rate_limit() (migration 0024); false means
 * the caller is over allowance. Keys are namespaced per route (e.g.
 * `invite:accept:{ip}`) so one route's traffic never starves another's.
 *
 * The password-reset service keeps its own private copy of this exact call with
 * constants pinned by tests/guards/password-reset.test.ts — don't "simplify" it
 * into this helper without updating those guards.
 */
export async function checkIpRateLimit(
  key: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  const res = await authDb.execute<{ allowed: boolean }>(sql`
    select authz.check_rate_limit(${key}, ${max}, ${windowSeconds}) as allowed
  `);
  return res.rows[0]?.allowed ?? false;
}

/** Key builder: one bucket per route per client IP. */
export function ipRateLimitKey(route: string, ip: string | null): string {
  return `${route}:${ip ?? 'unknown'}`;
}
