import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Security-headers + route rate-limit guards.
 *
 * Two Phase 1 gaps closed together: (1) the app shipped with no security
 * headers at all, and (2) the invitation-accept, invitation-preview, bootstrap,
 * and invitation-admin routes had no IP rate limiting, unlike the auth routes.
 * Static/source-level like the other guards — no database needed.
 */

const root = (...p: string[]) => join(process.cwd(), ...p);
const read = (p: string) => readFileSync(root(...p.split('/')), 'utf8');

const CONFIG = read('next.config.ts');
const HELPER = read('src/lib/auth/rate-limit.ts');
const ACCEPT = read('src/app/api/invitations/accept/route.ts');
const PREVIEW = read('src/app/api/invitations/preview/route.ts');
const BOOTSTRAP = read('src/app/api/bootstrap/complete/route.ts');
const INVITE_CREATE = read('src/app/api/invitations/route.ts');
const INVITE_REVOKE = read('src/app/api/invitations/[id]/revoke/route.ts');

describe('security headers: next.config.ts ships a complete set', () => {
  it('defines headers() applying to every route', () => {
    expect(CONFIG).toMatch(/async headers\(\)/);
    expect(CONFIG).toMatch(/source:\s*'\/:path\*'/);
  });

  it('sets HSTS with a two-year max-age, includeSubDomains and preload', () => {
    expect(CONFIG).toMatch(/Strict-Transport-Security/);
    expect(CONFIG).toMatch(/max-age=63072000; includeSubDomains; preload/);
  });

  it('sets a Content-Security-Policy locked to self with frame-ancestors none', () => {
    expect(CONFIG).toMatch(/Content-Security-Policy/);
    expect(CONFIG).toMatch(/default-src 'self'/);
    expect(CONFIG).toMatch(/script-src 'self' 'unsafe-inline'/);
    expect(CONFIG).toMatch(/style-src 'self' 'unsafe-inline'/);
    expect(CONFIG).toMatch(/frame-ancestors 'none'/);
    expect(CONFIG).toMatch(/object-src 'none'/);
  });

  it('sets X-Frame-Options DENY, nosniff, and a conservative referrer policy', () => {
    expect(CONFIG).toMatch(/X-Frame-Options/);
    expect(CONFIG).toMatch(/value:\s*'DENY'/);
    expect(CONFIG).toMatch(/X-Content-Type-Options/);
    expect(CONFIG).toMatch(/value:\s*'nosniff'/);
    expect(CONFIG).toMatch(/Referrer-Policy/);
    expect(CONFIG).toMatch(/strict-origin-when-cross-origin/);
  });
});

describe('rate-limit helper: one shared IP-bucket check', () => {
  it('exists and calls authz.check_rate_limit', () => {
    expect(existsSync(root('src/lib/auth/rate-limit.ts'))).toBe(true);
    expect(HELPER).toMatch(/export async function checkIpRateLimit/);
    expect(HELPER).toMatch(/authz\.check_rate_limit\(\$\{key\}, \$\{max\}, \$\{windowSeconds\}\)/);
  });

  it('namespaces buckets per route with an unknown-IP fallback', () => {
    expect(HELPER).toMatch(/export function ipRateLimitKey/);
    expect(HELPER).toMatch(/ip \?\? 'unknown'/);
  });
});

describe('rate limiting: pre-auth token routes are throttled per IP', () => {
  it('invitation accept checks invite:accept at 10/min and answers 429', () => {
    expect(ACCEPT).toMatch(
      /checkIpRateLimit\(ipRateLimitKey\('invite:accept', clientIp\(req\)\), 10, 60\)/,
    );
    expect(ACCEPT).toMatch(/reply\(429, \{ error: 'RATE_LIMITED' \}\)/);
  });

  it('invitation preview checks invite:preview at 10/min and answers 429', () => {
    expect(PREVIEW).toMatch(
      /checkIpRateLimit\(ipRateLimitKey\('invite:preview', clientIp\(req\)\), 10, 60\)/,
    );
    expect(PREVIEW).toMatch(/reply\(429, \{ error: 'RATE_LIMITED' \}\)/);
  });

  it('bootstrap complete checks bootstrap:complete at 5/min and answers 429', () => {
    expect(BOOTSTRAP).toMatch(
      /checkIpRateLimit\(ipRateLimitKey\('bootstrap:complete', clientIp\(req\)\), 5, 60\)/,
    );
    expect(BOOTSTRAP).toMatch(/reply\(429, \{ error: 'RATE_LIMITED' \}\)/);
  });

  it('the throttle runs before the token is consulted on every pre-auth route', () => {
    for (const [name, src] of [
      ['accept', ACCEPT],
      ['preview', PREVIEW],
      ['bootstrap', BOOTSTRAP],
    ] as const) {
      const throttleAt = src.indexOf('checkIpRateLimit');
      const tokenAt = Math.min(
        ...['acceptInvitation(', 'previewInvitation(', 'completeBootstrapSetup(']
          .map((s) => src.indexOf(s))
          .filter((i) => i >= 0),
      );
      expect(throttleAt, `${name}: rate-limit check present`).toBeGreaterThanOrEqual(0);
      expect(tokenAt, `${name}: token call present`).toBeGreaterThanOrEqual(0);
      expect(throttleAt, `${name}: throttle precedes token use`).toBeLessThan(tokenAt);
    }
  });
});

describe('rate limiting: invitation admin routes are throttled per IP', () => {
  it('invitation create checks invite:create at 30/min and answers 429', () => {
    expect(INVITE_CREATE).toMatch(
      /checkIpRateLimit\(ipRateLimitKey\('invite:create', clientIp\(request\)\), 30, 60\)/,
    );
    expect(INVITE_CREATE).toMatch(/status: 429/);
  });

  it('invitation revoke checks invite:revoke at 30/min and answers 429', () => {
    expect(INVITE_REVOKE).toMatch(
      /checkIpRateLimit\(ipRateLimitKey\('invite:revoke', clientIp\(request\)\), 30, 60\)/,
    );
    expect(INVITE_REVOKE).toMatch(/status: 429/);
  });
});
