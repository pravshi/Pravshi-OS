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
const INBOUND = read('src/app/api/integrations/inbound/[endpointKey]/route.ts');
const SEARCH = read('src/app/api/search/route.ts');
const AUDIT_EXPORT = read('src/app/api/admin/audit-logs/export/route.ts');

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

  it('sets a Permissions-Policy denying capabilities the app never uses (Phase 11, F-11-12)', () => {
    expect(CONFIG).toMatch(/Permissions-Policy/);
    expect(CONFIG).toMatch(/camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\)/);
  });

  it('lets the browser Sentry SDK reach its ingest hosts (Phase 11, F-11-12)', () => {
    expect(CONFIG).toMatch(/connect-src 'self' https:\/\/\*\.ingest\.sentry\.io/);
    expect(CONFIG).toMatch(/https:\/\/\*\.ingest\.us\.sentry\.io/);
    expect(CONFIG).toMatch(/https:\/\/\*\.ingest\.de\.sentry\.io/);
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

describe('rate limiting: Phase 11 Wave D surfaces (F-11-08, F-11-09)', () => {
  it('inbound ingress is throttled per IP (300/min) and per endpoint digest (60/min)', () => {
    expect(INBOUND).toMatch(/RATE_LIMIT_PER_IP_PER_MINUTE = 300/);
    expect(INBOUND).toMatch(/RATE_LIMIT_PER_ENDPOINT_PER_MINUTE = 60/);
    expect(INBOUND).toMatch(/`inbound:ip:\$\{clientIp\(req\) \?\? 'unknown'\}`/);
    expect(INBOUND).toMatch(/`inbound:ep:\$\{hashEndpointKey\(endpointKey\)\}`/);
    expect(INBOUND).toMatch(/RATE_LIMIT_PER_IP_PER_MINUTE,\s*RATE_LIMIT_WINDOW_SECONDS/);
    expect(INBOUND).toMatch(/RATE_LIMIT_PER_ENDPOINT_PER_MINUTE,\s*RATE_LIMIT_WINDOW_SECONDS/);
  });

  it('inbound over-limit answers the uniform rejection body under a 429', () => {
    // The body comes from rejectionResult() itself, so a throttled sender
    // sees exactly what any other rejected sender sees — status aside.
    expect(INBOUND).toMatch(/httpStatus: 429,\s*body: rejectionResult\(\)\.body/);
  });

  it('the inbound throttle runs before the body is read or the service is called', () => {
    const throttleAt = INBOUND.indexOf('await checkIpRateLimit(');
    const bodyAt = INBOUND.indexOf('await req.text()');
    const serviceAt = INBOUND.indexOf('await receiveInbound(');
    expect(throttleAt).toBeGreaterThanOrEqual(0);
    expect(bodyAt).toBeGreaterThan(throttleAt);
    expect(serviceAt).toBeGreaterThan(throttleAt);
  });

  it('search is throttled per user at 120/min and answers 429 in its envelope', () => {
    expect(SEARCH).toMatch(/SEARCH_RATE_LIMIT_PER_MINUTE = 120/);
    expect(SEARCH).toMatch(/`search:user:\$\{authorization\.ctx\.personId\}`/);
    expect(SEARCH).toMatch(/error: 'RATE_LIMITED'/);
    expect(SEARCH).toMatch(/status: 429/);
    const throttleAt = SEARCH.indexOf('await checkIpRateLimit(');
    const serviceAt = SEARCH.indexOf('await searchGlobal(');
    expect(throttleAt).toBeGreaterThanOrEqual(0);
    expect(serviceAt).toBeGreaterThan(throttleAt);
  });

  it('audit-log export is throttled per user at 5/min and answers 429 in its envelope', () => {
    expect(AUDIT_EXPORT).toMatch(/AUDIT_EXPORT_RATE_LIMIT_PER_MINUTE = 5/);
    expect(AUDIT_EXPORT).toMatch(/`audit-export:user:\$\{authorization\.ctx\.personId\}`/);
    expect(AUDIT_EXPORT).toMatch(/error: 'RATE_LIMITED'/);
    expect(AUDIT_EXPORT).toMatch(/status: 429/);
    const throttleAt = AUDIT_EXPORT.indexOf('await checkIpRateLimit(');
    const countAt = AUDIT_EXPORT.indexOf('await countAuditExportRows(');
    expect(throttleAt).toBeGreaterThanOrEqual(0);
    expect(countAt).toBeGreaterThan(throttleAt);
  });
});
