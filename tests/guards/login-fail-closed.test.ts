import { readFileSync } from 'node:fs';
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

describe('A1 review: every client address the auth plane uses is validated', () => {
  it('clientIp and the hooks read the forwarded address through forwardedIp', () => {
    expect(EVENTS).toMatch(/export function forwardedIp[\s\S]*?isIP\(first\) !== 0/);
    expect(EVENTS).toMatch(/return forwardedIp\(req\.headers\.get\('x-forwarded-for'\)\)/);
    const ipOfHeaders = SERVER.slice(SERVER.indexOf('function ipOfHeaders'));
    expect(ipOfHeaders.slice(0, 200)).toMatch(
      /return forwardedIp\(headers\?\.get\('x-forwarded-for'\)\)/,
    );
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
