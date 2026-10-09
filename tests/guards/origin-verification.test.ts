import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/authz/require-permission', () => ({
  requirePermission: vi.fn(async () => ({
    requestId: 'origin-test',
    ctx: { personId: 'person-1', orgId: 'org-1', aal: 'aal1' },
  })),
}));

vi.mock('@/env', () => ({
  env: { APP_URL: 'https://app.pravshi.example' },
}));

import { withPermission } from '@/lib/authz/http';
import { requirePermission } from '@/lib/authz/require-permission';

/**
 * F-11-10 — origin verification in the shared wrapper (T-17, centralised).
 *
 * Every authenticated API route is built with withPermission(); the wrapper
 * verifies Origin against APP_URL for state-changing methods before
 * requirePermission runs. These cases pin the contracted semantics
 * behaviourally, with authorization stubbed out (the origin gate precedes
 * it, so no database is touched):
 *
 *   - a present, mismatched Origin on POST/PUT/PATCH/DELETE is refused 403;
 *   - an absent Origin is not a browser acting on someone's behalf and is
 *     admitted to authentication (server-to-server, tests, the worker);
 *   - a matching Origin is admitted — compared as a URL origin, so the
 *     default port spelling of the same origin also matches;
 *   - safe methods (GET) are exempt whatever Origin they carry;
 *   - a malformed Origin, and the opaque-origin serialization 'null',
 *     cannot match and are refused.
 */

const handler = vi.fn(async () => Response.json({ ok: true }));
const route = withPermission({ permission: 'people.view' }, handler);

const call = (method: string, origin?: string) =>
  route(
    new Request('https://app.pravshi.example/api/things', {
      method,
      headers: origin === undefined ? {} : { origin },
    }),
    { params: Promise.resolve({}) },
  );

beforeEach(() => vi.clearAllMocks());

describe('withPermission origin verification (F-11-10)', () => {
  it('refuses a cross-origin POST before authorization or the handler run', async () => {
    const res = await call('POST', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(requirePermission).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('refuses a cross-origin %s', async (method) => {
    const res = await call(method, 'https://evil.example');
    expect(res.status).toBe(403);
    expect(requirePermission).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('admits a same-origin POST to the handler', async () => {
    const res = await call('POST', 'https://app.pravshi.example');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('admits the same origin spelled with its default port', async () => {
    const res = await call('POST', 'https://app.pravshi.example:443');
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('admits a POST with no Origin header (not a browser request)', async () => {
    const res = await call('POST');
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('exempts safe methods: a cross-origin GET reaches the handler', async () => {
    const res = await call('GET', 'https://evil.example');
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed Origin and the opaque-origin serialization', async () => {
    for (const origin of ['::not a url::', 'null']) {
      const res = await call('POST', origin);
      expect(res.status, `origin ${origin}`).toBe(403);
    }
    expect(handler).not.toHaveBeenCalled();
  });
});
