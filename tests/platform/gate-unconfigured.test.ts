import { describe, expect, it, vi } from 'vitest';

/**
 * S-CONSOLE-7 — where the console is not configured (no DATABASE_URL_PLATFORM) it does not
 * exist: every request, a tenant user's or an administrator's, gets the same 404 a tenant user
 * gets where it is configured — never a 503 or a page that tells anyone the platform is there.
 * No database: the pool is replaced by one that is not configured.
 */
class PlatformUnavailableError extends Error {}

vi.mock('@/lib/db/platform-pool', () => ({
  PlatformUnavailableError,
  withPlatformTx: () => {
    throw new PlatformUnavailableError();
  },
}));
vi.mock('@/lib/platform/identity', () => ({
  resolvePlatformAccess: () => Promise.reject(new PlatformUnavailableError()),
}));
vi.mock('@/lib/auth/rate-limit', () => ({
  checkIpRateLimit: () => Promise.resolve(true),
  ipRateLimitKey: (r: string, ip: string | null) => `${r}:${ip}`,
}));
vi.mock('@/lib/auth/login-events', () => ({ clientIp: () => null }));
vi.mock('@/lib/auth/bootstrap-setup', () => ({ sqlstateOf: () => null }));

const { gatePlatformRequest } = await import('@/lib/platform/guard');

describe('an unconfigured platform console', () => {
  it('answers exactly what a tenant user gets: 404 NOT_FOUND', async () => {
    for (const method of ['GET', 'POST']) {
      const res = await gatePlatformRequest(
        new Request('https://os.pravshi.com/api/platform/organizations', {
          method,
          headers: { cookie: 'better-auth.session_token=x' },
        }),
        { operation: 'platform.organization.list', permission: 'platform.organizations.view' },
      );
      expect(res).toBeInstanceOf(Response);
      const r = res as Response;
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: 'NOT_FOUND' });
    }
  });
});
