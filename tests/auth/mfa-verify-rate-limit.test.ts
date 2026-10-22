/**
 * Phase 3, F-B1-7 — the browser's second-factor route (/api/auth/mfa/verify) is rate
 * limited per client address by the route itself, before the factor check.
 *
 * Better Auth limits /two-factor/* only in its HTTP router; the route calls
 * auth.api.verifyTOTP() / verifyBackupCode() directly, which bypasses it. These cases
 * run the real route with the library calls, the login-event recorders and Sentry
 * mocked, and with a counting fake behind authz.check_rate_limit (it reads the key,
 * max and window from the route's actual call). No database, no network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyTOTP, verifyBackupCode, execute, recordLoginEvent, captureException } = vi.hoisted(
  () => ({
    verifyTOTP: vi.fn(),
    verifyBackupCode: vi.fn(),
    execute: vi.fn(),
    recordLoginEvent: vi.fn(),
    captureException: vi.fn(),
  }),
);
vi.mock('@/lib/auth/server', () => ({ auth: { api: { verifyTOTP, verifyBackupCode } } }));
vi.mock('@/lib/db/auth-client', () => ({ authDb: { execute } }));
vi.mock('@sentry/nextjs', () => ({ captureException }));
vi.mock('@/lib/auth/login-events', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/auth/login-events')>()),
  recordLoginEvent,
  resolveLoginOrg: vi.fn(async () => null),
}));

import { POST } from '@/app/api/auth/mfa/verify/route';
import { resetAuthAlertLimiter } from '@/lib/auth/safe-log';

/** authz.check_rate_limit as a fixed-window counter over the call's own parameters. */
const buckets = new Map<string, number>();
const limiterCalls: Array<{ key: string; max: number; windowSeconds: number }> = [];
function countingLimiter() {
  execute.mockImplementation(async (query: { queryChunks: unknown[] }) => {
    const [key, max, windowSeconds] = query.queryChunks.filter(
      (c) => typeof c === 'string' || typeof c === 'number',
    ) as [string, number, number];
    limiterCalls.push({ key, max, windowSeconds });
    const used = (buckets.get(key) ?? 0) + 1;
    buckets.set(key, used);
    return { rows: [{ allowed: used <= max }] };
  });
}

const ok = () =>
  Response.json({ user: { id: 'u-1', email: 'known.user@example.com' }, token: 't' });
const wrong = () => Response.json({ code: 'INVALID_CODE' }, { status: 401 });

function verify(
  code: string,
  opts: { ip?: string | null; method?: 'totp' | 'backup-code'; email?: string } = {},
) {
  const ip = opts.ip === undefined ? '203.0.113.7' : opts.ip;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ip !== null) headers['x-forwarded-for'] = ip;
  return POST(
    new Request('http://localhost:3000/api/auth/mfa/verify', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code,
        ...(opts.method ? { method: opts.method } : {}),
        ...(opts.email ? { email: opts.email } : {}),
      }),
    }),
  );
}

async function seen(res: Response) {
  return { status: res.status, body: await res.text(), setCookie: res.headers.getSetCookie() };
}

beforeEach(() => {
  for (const f of [verifyTOTP, verifyBackupCode, execute, recordLoginEvent, captureException]) {
    f.mockReset();
  }
  buckets.clear();
  limiterCalls.length = 0;
  resetAuthAlertLimiter();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  countingLimiter();
});

describe('/api/auth/mfa/verify — per-address rate limit before the factor check', () => {
  it('limits ten attempts a minute per address, keyed apart from login', async () => {
    verifyTOTP.mockImplementation(async () => ok());
    expect((await verify('123456')).status).toBe(200);
    expect(limiterCalls).toEqual([{ key: 'mfa:verify:203.0.113.7', max: 10, windowSeconds: 60 }]);
  });

  it('the eleventh attempt in a window is refused without reaching the library', async () => {
    verifyTOTP.mockImplementation(async () => wrong());
    for (let i = 0; i < 10; i += 1) expect((await verify('000000')).status).toBe(401);
    const res = await verify('000000');
    expect(await seen(res)).toMatchObject({ status: 429, body: '{"error":"RATE_LIMITED"}' });
    expect(verifyTOTP).toHaveBeenCalledTimes(10);
  });

  it('a legitimate user who mistypes several times still gets through', async () => {
    verifyTOTP
      .mockImplementationOnce(async () => wrong())
      .mockImplementationOnce(async () => wrong())
      .mockImplementationOnce(async () => wrong())
      .mockImplementationOnce(async () => wrong())
      .mockImplementationOnce(async () => ok());
    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await verify('12345' + i)).status);
    expect(statuses).toEqual([401, 401, 401, 401, 200]);
  });

  it('backup codes are limited by the same bucket', async () => {
    verifyTOTP.mockImplementation(async () => wrong());
    for (let i = 0; i < 10; i += 1) await verify('000000');
    const res = await verify('ABCD-EFGH', { method: 'backup-code' });
    expect(res.status).toBe(429);
    expect(verifyBackupCode).not.toHaveBeenCalled();
  });

  it('a throttled request is not recorded as an MFA failure', async () => {
    verifyTOTP.mockImplementation(async () => wrong());
    for (let i = 0; i < 10; i += 1) await verify('000000');
    expect(recordLoginEvent).toHaveBeenCalledTimes(10);
    await verify('000000');
    await verify('000000');
    expect(recordLoginEvent).toHaveBeenCalledTimes(10);
  });

  it('the throttled answer is the same whatever the method or claimed account', async () => {
    buckets.set('mfa:verify:203.0.113.7', 10);
    const a = await seen(await verify('000000', { email: 'known.user@example.com' }));
    const b = await seen(
      await verify('ABCD-EFGH', { method: 'backup-code', email: 'nobody-here@example.com' }),
    );
    const c = await seen(await verify('000000'));
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });

  it('throttling raises a bounded alert carrying no code, email or address', async () => {
    buckets.set('mfa:verify:203.0.113.7', 10);
    for (let i = 0; i < 20; i += 1) {
      await verify('424242', { email: 'known.user@example.com' });
    }
    // reportAuthFailure's limiter admits a few alerts per event per window, not one per request.
    expect(captureException.mock.calls.length).toBeGreaterThan(0);
    expect(captureException.mock.calls.length).toBeLessThan(20);
    expect(String(captureException.mock.calls[0]?.[0]?.message)).toContain('auth.mfa.rate_limited');
    const payload = JSON.stringify(captureException.mock.calls);
    expect(payload).not.toContain('424242');
    expect(payload).not.toContain('known.user');
    expect(payload).not.toContain('203.0.113.7');
  });

  it('a request with no forwarded address shares the unknown bucket', async () => {
    verifyTOTP.mockImplementation(async () => wrong());
    await verify('000000', { ip: null });
    expect(limiterCalls.at(-1)?.key).toBe('mfa:verify:unknown');
  });

  it('other addresses keep their own allowance', async () => {
    verifyTOTP.mockImplementation(async () => wrong());
    for (let i = 0; i < 11; i += 1) await verify('000000', { ip: '198.51.100.1' });
    expect((await verify('000000', { ip: '198.51.100.2' })).status).toBe(401);
    expect(limiterCalls.at(-1)?.key).toBe('mfa:verify:198.51.100.2');
  });

  it('the limiter cannot answer: the generic INVALID_CODE, no factor check, an alert', async () => {
    execute.mockReset().mockRejectedValue(new Error('auth pool exhausted'));
    const res = await verify('123456');
    expect(await seen(res)).toMatchObject({ status: 401, body: '{"error":"INVALID_CODE"}' });
    expect(verifyTOTP).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String(captureException.mock.calls[0]?.[0]?.message)).toContain(
      'auth.mfa.rate_limit_check_failed',
    );
  });

  it('a limiter failure answers exactly like a wrong code', async () => {
    execute.mockReset().mockRejectedValueOnce(new Error('down'));
    const limiterDown = await seen(await verify('123456'));
    countingLimiter();
    verifyTOTP.mockImplementationOnce(async () => wrong());
    const wrongCode = await seen(await verify('123456'));
    expect(limiterDown).toEqual(wrongCode);
  });

  it('malformed requests are refused before the limiter is consulted', async () => {
    const res = await POST(
      new Request('http://localhost:3000/api/auth/mfa/verify', {
        method: 'POST',
        body: '{"code":1}',
      }),
    );
    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
});

/**
 * B1 integration (fix/login-lockout-fail-closed): the route keys its bucket with the
 * real clientIp() -> forwardedIp() and ipRateLimitKey() -> rateLimitSubject(), so these
 * cases run the production address handling through the route itself. Only the
 * database call is faked (the counting limiter above), never the address logic.
 *
 * Trust model (unchanged): the first x-forwarded-for entry is the client address the
 * platform sets. These cases pin what the route does with that value; whether the
 * deployment overwrites the header is a deployment fact, not something a unit test proves.
 */
describe('/api/auth/mfa/verify — address normalisation through the route (B1 helpers)', () => {
  const keyFor = async (xff: string | null) => {
    verifyTOTP.mockImplementation(async () => wrong());
    limiterCalls.length = 0;
    await verify('000000', { ip: xff });
    return limiterCalls.at(-1)?.key;
  };

  it('keys a valid IPv4 address as itself, with surrounding whitespace ignored', async () => {
    expect(await keyFor('203.0.113.7')).toBe('mfa:verify:203.0.113.7');
    expect(await keyFor(' 203.0.113.7 , 10.0.0.1')).toBe('mfa:verify:203.0.113.7');
  });

  it('an IPv4-mapped IPv6 address shares the IPv4 bucket and its allowance', async () => {
    expect(await keyFor('::ffff:203.0.113.7')).toBe('mfa:verify:203.0.113.7');
    buckets.clear();
    verifyTOTP.mockImplementation(async () => wrong());
    for (let i = 0; i < 10; i += 1) await verify('000000', { ip: '203.0.113.7' });
    const res = await verify('000000', { ip: '::ffff:203.0.113.7' });
    expect(res.status).toBe(429);
  });

  it('groups IPv6 by /64: rotating addresses inside one /64 cannot escape the limit', async () => {
    verifyTOTP.mockImplementation(async () => wrong());
    for (let i = 1; i <= 10; i += 1) {
      expect((await verify('000000', { ip: `2001:db8:1:2::${i.toString(16)}` })).status).toBe(401);
    }
    const res = await verify('000000', { ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' });
    expect(res.status).toBe(429);
    expect(verifyTOTP).toHaveBeenCalledTimes(10);
    expect(new Set(limiterCalls.map((c) => c.key))).toEqual(
      new Set(['mfa:verify:2001:db8:1:2::/64']),
    );
  });

  it('another /64, another IPv4 network: separate allowances (no cross-network merging)', async () => {
    verifyTOTP.mockImplementation(async () => wrong());
    for (let i = 0; i < 11; i += 1) await verify('000000', { ip: '2001:db8:1:2::1' });
    expect((await verify('000000', { ip: '2001:db8:1:3::1' })).status).toBe(401);
    expect((await verify('000000', { ip: '198.51.100.20' })).status).toBe(401);
    expect(limiterCalls.slice(-2).map((c) => c.key)).toEqual([
      'mfa:verify:2001:db8:1:3::/64',
      'mfa:verify:198.51.100.20',
    ]);
  });

  it.each([
    ['x', 'a forged token'],
    ['not-an-ip', 'a forged word'],
    ['999.1.1.1', 'an out-of-range octet'],
    ['01.2.3.4', 'a leading-zero octet'],
    ['fe80::1%eth0', 'an IPv6 zone id'],
    ['fe80::1%25eth0', 'a URL-encoded zone id'],
    ['1.2.3.4:80', 'an address with a port'],
    ['x, 203.0.113.7', 'garbage first, a real address later (only the first entry counts)'],
  ])('a malformed forwarded value %j (%s) lands in the shared unknown bucket', async (xff) => {
    expect(await keyFor(xff)).toBe('mfa:verify:unknown');
  });

  it('forged forwarding values cannot buy fresh buckets: they all share one allowance', async () => {
    verifyTOTP.mockImplementation(async () => wrong());
    for (let i = 0; i < 10; i += 1) await verify('000000', { ip: `forged-${i}` });
    const res = await verify('000000', { ip: 'yet-another-forgery' });
    expect(res.status).toBe(429);
    expect(verifyTOTP).toHaveBeenCalledTimes(10);
  });

  it('a malformed forwarded value is recorded as no address, never passed to ::inet', async () => {
    verifyTOTP.mockImplementation(async () => wrong());
    await verify('000000', { ip: 'fe80::1%eth0' });
    await verify('000000', { ip: '2001:db8::5' });
    expect(recordLoginEvent.mock.calls.map(([e]) => (e as { ip: string | null }).ip)).toEqual([
      null,
      '2001:db8::5',
    ]);
  });

  it('TOTP and backup codes share one bucket for the same /64', async () => {
    verifyTOTP.mockImplementation(async () => wrong());
    verifyBackupCode.mockImplementation(async () => wrong());
    for (let i = 0; i < 5; i += 1) await verify('000000', { ip: `2001:db8:9:9::${i + 1}` });
    for (let i = 0; i < 5; i += 1) {
      await verify('ABCD-EFGH', { ip: `2001:db8:9:9::${i + 10}`, method: 'backup-code' });
    }
    const res = await verify('ABCD-EFGH', { ip: '2001:db8:9:9::ff', method: 'backup-code' });
    expect(res.status).toBe(429);
    expect(verifyTOTP.mock.calls.length + verifyBackupCode.mock.calls.length).toBe(10);
  });

  it('a limiter failure fails closed for any address form, and nothing is verified', async () => {
    execute.mockReset().mockRejectedValue(new Error('auth pool exhausted'));
    for (const ip of ['203.0.113.7', '::ffff:203.0.113.7', '2001:db8::1', 'x', null]) {
      const res = await verify('123456', { ip });
      expect(await seen(res)).toMatchObject({ status: 401, body: '{"error":"INVALID_CODE"}' });
    }
    expect(verifyTOTP).not.toHaveBeenCalled();
  });
});
