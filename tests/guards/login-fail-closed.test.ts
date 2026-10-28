import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Phase 3 guards for S-6 and A1, in the style of the other auth guards: they pin
 * the shape that makes the behaviour hold, so a later edit cannot quietly turn
 * the lockout check back into fail-open or move the login route's rate limit
 * behind the credential check. The behaviour itself is tested in tests/auth.
 */
const read = (p: string) => readFileSync(`src/${p}`, 'utf8');
const LOCKOUT = read('lib/auth/login-lockout.ts');
const ROUTE = read('app/api/auth/login/route.ts');
const SERVER = read('lib/auth/server.ts');
const EVENTS = read('lib/auth/login-events.ts');
const ADDRESS = read('lib/auth/client-address.ts');

describe('A1 review: every client address the auth plane uses is validated', () => {
  it('clientIp and the hooks read the trusted header (D1) through forwardedIp', () => {
    // One validator, in the D1 module; the trusted header's value always passes through it.
    expect(ADDRESS).toMatch(/export function forwardedIp[\s\S]*?isIP\(first\) !== 0/);
    expect(ADDRESS).toMatch(/return name \? forwardedIp\(headers\?\.get\(name\)\) : null;/);
    expect(EVENTS).toMatch(/return clientAddressFromHeaders\(req\.headers\);/);
    const ipOfHeaders = SERVER.slice(SERVER.indexOf('function ipOfHeaders'));
    expect(ipOfHeaders.slice(0, 200)).toMatch(/return clientAddressFromHeaders\(headers\);/);
  });

  it("Better Auth's own limiter resolves the address from the same trusted header", () => {
    // Without this line Better Auth falls back to its default x-forwarded-for (D1-3).
    // Inside Better Auth's `advanced` block — elsewhere it would be ignored.
    const start = SERVER.indexOf('\n  advanced: {');
    expect(start).toBeGreaterThan(0);
    const advanced = SERVER.slice(start, SERVER.indexOf('\n  },', start));
    expect(advanced).toContain('ipAddress: betterAuthIpAddressOptions(),');
    expect(SERVER).not.toMatch(/disableIpTracking/);
  });

  it('no code outside the D1 module names a client-address header (review F-D1-3)', () => {
    // Every file under src/, however it spells the name: a route or helper that read one of
    // these directly would bypass the deployment's trusted-header choice.
    const ADDRESS_HEADER = /x-(vercel-)?forwarded-for|x-real-ip|cf-connecting-ip|true-client-ip/i;
    const files = (readdirSync('src', { recursive: true }) as string[])
      .map((f) => f.replace(/\\/g, '/'))
      .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f) && f !== 'lib/auth/client-address.ts');
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((f) =>
      // Comments may name a header; code may not.
      ADDRESS_HEADER.test(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')),
    );
    expect(offenders).toEqual([]);
  });
});

/** The body of one exported async function, up to the next top-level declaration. */
function fnBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('S-6: the lockout check fails closed', () => {
  it('a failed or empty check answers locked, never unlocked', () => {
    const body = fnBody(LOCKOUT, 'isLockedOut');
    const catchBlock = body.slice(body.indexOf('} catch'));
    expect(catchBlock).toMatch(/return true;/);
    expect(catchBlock).not.toMatch(/return false/);
    expect(body).not.toMatch(/\?\? false/);
  });

  it('every lockout helper alerts through reportAuthFailure, not a bare console line', () => {
    for (const name of ['isLockedOut', 'noteLoginFailure', 'clearLoginLockout']) {
      const body = fnBody(LOCKOUT, name);
      expect(body, name).toMatch(/reportAuthFailure\('auth\.login\.[a-z_]+'/);
      expect(body, name).not.toMatch(/console\.error/);
    }
  });
});

describe('A1: the browser login route throttles before the credential check', () => {
  it('limits ten attempts a minute per client address', () => {
    expect(ROUTE).toMatch(/LOGIN_RATE_LIMIT = \{ max: 10, windowSeconds: 60 \}/);
    expect(ROUTE).toMatch(/checkRequestRateLimit\(\s*req,\s*'login',/);
    expect(ROUTE).toMatch(/reply\(429, \{ error: 'RATE_LIMITED' \}\)/);
  });

  // Anchored on the awaited call sites: the header comment names both functions too.
  const LIMIT_CALL = 'await checkRequestRateLimit(';
  const SIGN_IN_CALL = 'await auth.api.signInEmail(';

  it('consults the limiter before delegating the credential check', () => {
    const limitAt = ROUTE.indexOf(LIMIT_CALL);
    const signInAt = ROUTE.indexOf(SIGN_IN_CALL);
    expect(limitAt).toBeGreaterThan(0);
    expect(signInAt).toBeGreaterThan(limitAt);
  });

  it('a limiter failure is refused with the generic credentials error and alerts', () => {
    const block = ROUTE.slice(ROUTE.indexOf(LIMIT_CALL), ROUTE.indexOf(SIGN_IN_CALL));
    expect(block).toMatch(/reportAuthFailure\('auth\.login\.rate_limit_check_failed'/);
    expect(block).toMatch(/reply\(401, \{ error: 'INVALID_CREDENTIALS' \}\)/);
  });
});
