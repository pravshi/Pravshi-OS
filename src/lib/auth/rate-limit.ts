import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import { authDb } from '@/lib/db/auth-client';
import { clientIp } from './login-events';

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

/** Key builder: one bucket per route per client (see rateLimitSubject). */
export function ipRateLimitKey(route: string, ip: string | null): string {
  return `${route}:${rateLimitSubject(ip)}`;
}

/**
 * Who a bucket belongs to. An IPv4 address as itself; an IPv4-mapped IPv6 address
 * as its IPv4 address; any other IPv6 address as its /64 — one subscriber's
 * allocation, as Better Auth's own limiter groups it — so rotating through a /64
 * buys no fresh buckets. An absent or invalid address shares 'unknown'.
 */
export function rateLimitSubject(ip: string | null): string {
  if (ip === null) return 'unknown';
  const family = isIP(ip);
  if (family === 4) return ip;
  if (family !== 6) return 'unknown';
  const g = ipv6Groups(ip);
  if (g === null) return 'unknown';
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const [hi, lo] = [g[6] as number, g[7] as number];
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
}

/** The eight 16-bit groups of an address isIP() already accepted as IPv6. */
function ipv6Groups(ip: string): number[] | null {
  let h = ip.split('%')[0] as string;
  if (h.includes('.')) {
    const at = h.lastIndexOf(':');
    const quad = h
      .slice(at + 1)
      .split('.')
      .map(Number);
    if (quad.length !== 4 || quad.some((n) => !(n >= 0 && n <= 255))) return null;
    const [a, b, c, d] = quad as [number, number, number, number];
    h = `${h.slice(0, at + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parse = (s: string): number[] => (s === '' ? [] : s.split(':').map((x) => parseInt(x, 16)));
  const halves = h.split('::');
  const head = parse(halves[0] as string);
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parse(halves[1] as string);
  const missing = 8 - head.length - tail.length;
  return missing >= 1 ? [...head, ...new Array<number>(missing).fill(0), ...tail] : null;
}

/**
 * checkIpRateLimit for the request's client address (Vercel's x-forwarded-for, via
 * clientIp, validated). A route throttles with this without handling the address
 * itself — the login route must hold nothing that could record an attempt (auth
 * choke point). Throws when the limiter cannot answer; the caller decides how to
 * fail closed.
 */
export function checkRequestRateLimit(
  req: Request,
  route: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  return checkIpRateLimit(ipRateLimitKey(route, clientIp(req)), max, windowSeconds);
}
