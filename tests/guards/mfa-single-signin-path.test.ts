import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * FU-2 guard: /api/auth/mfa/verify is the only HTTP path that completes a sign-in second
 * factor. Behaviour is tested in tests/auth/mfa-single-signin-path.test.ts; this pins the
 * source facts that behaviour rests on.
 */
const SERVER = readFileSync('src/lib/auth/server.ts', 'utf8');
const ROUTE = readFileSync('src/app/api/auth/mfa/verify/route.ts', 'utf8');

describe('FU-2: one HTTP path for the sign-in second factor', () => {
  it('the mediated route never hands auth.api a request', () => {
    // The HTTP-only refusal tells a routed request from an auth.api call by ctx.request,
    // which only the library's router sets. A `request:` passed here would make the
    // route's own verification look routed and refuse it.
    expect(ROUTE).not.toMatch(/\brequest\s*:/);
    expect(ROUTE).toMatch(
      /await auth\.api\.verifyBackupCode\(\{\s*body: \{ code: body\.code \},\s*headers: req\.headers,/,
    );
    expect(ROUTE).toMatch(
      /await auth\.api\.verifyTOTP\(\{\s*body: \{ code: body\.code \},\s*headers: req\.headers,/,
    );
  });

  it('disables backup-code and OTP verification for HTTP only, via disabledPaths', () => {
    expect(SERVER).toMatch(/disabledPaths: \[\.\.\.HTTP_DISABLED_AUTH_PATHS\],/);
    // A path refusal in the before-hook would reach auth.api calls too (same ctx.path).
    expect(SERVER).not.toMatch(/ctx\.path === '\/two-factor\/verify-backup-code'/);
    expect(SERVER).not.toMatch(/ctx\.path === '\/two-factor\/verify-totp'/);
  });

  it('the routed-challenge refusal keys on the request and the challenge cookie, not the path alone', () => {
    const fn = SERVER.slice(SERVER.indexOf('export function isRoutedSignInChallengeVerification'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/ctx\.request === undefined \|\| ctx\.request === null\) return false/);
    expect(body).toMatch(/createAuthCookie\(TWO_FACTOR_CHALLENGE_COOKIE\)\.name/);
    expect(body).toMatch(/ctx\.getCookie\(challenge\) !== null/);
  });

  it('the before-hook refuses before the sign-in lockout check runs', () => {
    const hook = SERVER.slice(SERVER.indexOf('before: createAuthMiddleware('));
    const refusal = hook.indexOf('if (isRoutedSignInChallengeVerification(ctx))');
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(hook.indexOf("if (ctx.path === '/sign-in/email')"));
  });
});
