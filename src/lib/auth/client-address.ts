import { isIP } from 'node:net';
import { env } from '@/env';

/**
 * Which request header carries the client's address — decided by where the code runs, never by
 * the request (D1). The address feeds rate limiting, login records and audit metadata; it never
 * grants access. A header a client can set itself must never be the one we read where a proxy
 * that overwrites it is not guaranteed.
 *
 *   vercel       VERCEL=1 (every Vercel deployment, production and preview). Vercel sets
 *                x-vercel-forwarded-for to the client's public address itself; unlike
 *                x-forwarded-for it is not replaced by a proxy placed in front of Vercel, and
 *                no client value survives (Vercel docs, request headers). Read only that.
 *   development  not production (local development, CI, tests): x-forwarded-for, as the test
 *                suites and local tooling send it. No real client exists to spoof anything.
 *   none         production anywhere else (an unsupported web host): no header is trusted;
 *                every request is "unknown" and shares the tighter unknown bucket.
 *
 * The worker host (Railway) serves no user request: its one HTTP route (/wake) is authorised
 * by a shared token and reads no client address.
 */
export type ClientAddressSource = 'vercel' | 'development' | 'none';

export const CLIENT_ADDRESS_HEADER: Record<ClientAddressSource, string | null> = {
  vercel: 'x-vercel-forwarded-for',
  development: 'x-forwarded-for',
  none: null,
};

export function clientAddressSource(
  e: { VERCEL?: string; NODE_ENV?: string } = env,
): ClientAddressSource {
  if (e.VERCEL === '1') return 'vercel';
  if (e.NODE_ENV !== 'production') return 'development';
  return 'none';
}

/**
 * The first entry of a forwarded-address value, only when it is a valid IPv4 or IPv6 address
 * (no zone id); anything else is null. A garbage value must never reach an `::inet` cast — the
 * cast throws, and the lockout recorder would silently stop counting — nor become a rate-limit
 * key a client can rotate at will.
 */
export function forwardedIp(header: string | null | undefined): string | null {
  const first = header?.split(',')[0]?.trim() ?? '';
  return isIP(first) !== 0 && !first.includes('%') ? first : null;
}

/** The client address from the trusted header for this deployment, or null. */
export function clientAddressFromHeaders(
  headers: Headers | null | undefined,
  source: ClientAddressSource = clientAddressSource(),
): string | null {
  const name = CLIENT_ADDRESS_HEADER[source];
  return name ? forwardedIp(headers?.get(name)) : null;
}

/** Better Auth's own address resolution, made to agree with the application's. */
export function betterAuthIpAddressOptions(source: ClientAddressSource = clientAddressSource()) {
  const name = CLIENT_ADDRESS_HEADER[source];
  return name ? { ipAddressHeaders: [name] } : { disableIpTracking: true };
}
