import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Phase 3, F-B1-7 guard: the second-factor route throttles per address before it
 * delegates the factor check, and fails closed when the limiter cannot answer.
 * Behaviour is tested in tests/auth/mfa-verify-rate-limit.test.ts.
 */
const ROUTE = readFileSync('src/app/api/auth/mfa/verify/route.ts', 'utf8');
const LIMIT_CALL = 'await checkIpRateLimit(';
const FIRST_FACTOR_CALL = 'await auth.api.verify';

describe('F-B1-7: /api/auth/mfa/verify is rate limited per address', () => {
  it('ten attempts a minute, in its own bucket namespace', () => {
    expect(ROUTE).toMatch(/MFA_RATE_LIMIT = \{ max: 10, windowSeconds: 60 \}/);
    expect(ROUTE).toMatch(/ipRateLimitKey\('mfa:verify', ip\)/);
    expect(ROUTE).toMatch(/reply\(429, \{ error: 'RATE_LIMITED' \}\)/);
  });

  it('takes the address from the shared validated clientIp(), never the raw header', () => {
    // clientIp() -> forwardedIp() and ipRateLimitKey() -> rateLimitSubject() are the one
    // normalisation every per-IP bucket uses (B1); the route must not parse the header itself.
    expect(ROUTE).toMatch(/const ip = clientIp\(req\);/);
    expect(ROUTE).not.toMatch(/x-forwarded-for/i);
  });

  it('checks the limit before either factor check', () => {
    const limitAt = ROUTE.indexOf(LIMIT_CALL);
    expect(limitAt).toBeGreaterThan(0);
    expect(ROUTE.indexOf(FIRST_FACTOR_CALL)).toBeGreaterThan(limitAt);
  });

  it('a limiter failure answers the generic INVALID_CODE and alerts', () => {
    const block = ROUTE.slice(ROUTE.indexOf(LIMIT_CALL), ROUTE.indexOf(FIRST_FACTOR_CALL));
    expect(block).toMatch(/reportAuthFailure\('auth\.mfa\.rate_limit_check_failed'/);
    expect(block).toMatch(/reply\(401, \{ error: 'INVALID_CODE' \}\)/);
  });
});
