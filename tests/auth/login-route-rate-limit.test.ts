/**
 * Phase 3, A1 — the browser's sign-in route (/api/auth/login) is rate limited per
 * client address by the route itself, before the credential check, and fails
 * closed when the limiter cannot answer.
 *
 * Better Auth applies its own /sign-in/email limit only in its HTTP router; the
 * route calls auth.api.signInEmail() directly, which never passes through it. These
 * cases run the real route handler with the library call, the limiter's database
 * call and Sentry mocked. No database, no network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { signInEmail, execute, captureException, mfaEnrollmentRequired } = vi.hoisted(() => ({
  signInEmail: vi.fn(),
  execute: vi.fn(),
  captureException: vi.fn(),
  mfaEnrollmentRequired: vi.fn(),
}));
vi.mock('@/lib/auth/server', () => ({ auth: { api: { signInEmail } } }));
vi.mock('@/lib/auth/mfa-enforcement', () => ({ mfaEnrollmentRequired }));
vi.mock('@/lib/db/auth-client', () => ({ authDb: { execute } }));
vi.mock('@sentry/nextjs', () => ({ captureException }));

import { POST } from '@/app/api/auth/login/route';
import { resetAuthAlertLimiter } from '@/lib/auth/safe-log';

const EXISTING = 'known.user@example.com';
const UNKNOWN = 'nobody-here@example.com';

function login(email: string, ip: string | null = '203.0.113.7') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ip !== null) headers['x-forwarded-for'] = `${ip}, 10.0.0.1`;
  return POST(
    new Request('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password: 'correct horse battery staple' }),
    }),
  );
}

/** What the client sees: status, body and the headers that could differ. */
async function seen(res: Response) {
  return {
    status: res.status,
    body: await res.text(),
    cacheControl: res.headers.get('cache-control'),
    setCookie: res.headers.getSetCookie(),
  };
}

/** The limiter's SQL call: its first parameter is the bucket key. */
function limiterKeys(): unknown[] {
  return execute.mock.calls.map(([query]) => {
    const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
    return chunks.find((c) => typeof c === 'string');
  });
}

beforeEach(() => {
  signInEmail.mockReset();
  execute.mockReset();
  captureException.mockReset();
  mfaEnrollmentRequired.mockReset().mockResolvedValue(false);
  resetAuthAlertLimiter();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('/api/auth/login — per-address rate limit before the credential check', () => {
  it('checks the limiter for the client address, then delegates the credential check', async () => {
    execute.mockResolvedValueOnce({ rows: [{ allowed: true }] });
    signInEmail.mockResolvedValueOnce(
      Response.json({ error: 'INVALID_EMAIL_OR_PASSWORD' }, { status: 401 }),
    );
    const res = await login(EXISTING);
    expect(res.status).toBe(401);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(limiterKeys()).toEqual(['login:203.0.113.7']);
    expect(signInEmail).toHaveBeenCalledTimes(1);
  });

  it('over the limit: 429, and the credential check never runs', async () => {
    execute.mockResolvedValue({ rows: [{ allowed: false }] });
    const res = await login(EXISTING);
    expect(await seen(res)).toMatchObject({ status: 429, body: '{"error":"RATE_LIMITED"}' });
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it('the limited answer is identical for an existing and an unknown account', async () => {
    execute.mockResolvedValue({ rows: [{ allowed: false }] });
    expect(await seen(await login(EXISTING))).toEqual(await seen(await login(UNKNOWN)));
  });

  it('the limiter cannot answer: generic 401, no credential check, an alert', async () => {
    execute.mockRejectedValue(new Error('auth pool exhausted'));
    const res = await login(EXISTING);
    expect(await seen(res)).toMatchObject({ status: 401, body: '{"error":"INVALID_CREDENTIALS"}' });
    expect(signInEmail).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String(captureException.mock.calls[0]?.[0]?.message)).toContain(
      'auth.login.rate_limit_check_failed',
    );
  });

  it('a limiter failure answers exactly like a wrong password', async () => {
    execute.mockRejectedValueOnce(new Error('auth pool exhausted'));
    const limiterDown = await seen(await login(EXISTING));
    execute.mockResolvedValueOnce({ rows: [{ allowed: true }] });
    signInEmail.mockResolvedValueOnce(
      Response.json({ error: 'INVALID_EMAIL_OR_PASSWORD' }, { status: 401 }),
    );
    const wrongPassword = await seen(await login(UNKNOWN));
    expect(limiterDown).toEqual(wrongPassword);
  });

  it('a lockout refusal from the auth hooks (including a failed lockout check) is the generic 401', async () => {
    // server.ts's before-hook throws when isLockedOut() is true — and isLockedOut()
    // now answers true when the check fails. The route maps every throw to the
    // same answer as a wrong password.
    execute.mockResolvedValue({ rows: [{ allowed: true }] });
    signInEmail.mockRejectedValueOnce(
      Object.assign(new Error('Invalid email or password'), { status: 'UNAUTHORIZED' }),
    );
    const locked = await seen(await login(EXISTING));
    signInEmail.mockResolvedValueOnce(
      Response.json({ error: 'INVALID_EMAIL_OR_PASSWORD' }, { status: 401 }),
    );
    const wrongPassword = await seen(await login(UNKNOWN));
    expect(locked).toEqual(wrongPassword);
    expect(locked).toMatchObject({ status: 401, body: '{"error":"INVALID_CREDENTIALS"}' });
  });

  it('separate addresses get separate buckets; a request with no address shares one', async () => {
    execute.mockResolvedValue({ rows: [{ allowed: true }] });
    signInEmail.mockImplementation(async () => Response.json({ error: 'x' }, { status: 401 }));
    await login(EXISTING, '198.51.100.1');
    await login(EXISTING, '198.51.100.2');
    await login(EXISTING, null);
    expect(limiterKeys()).toEqual(['login:198.51.100.1', 'login:198.51.100.2', 'login:unknown']);
  });

  it('rotating addresses inside one IPv6 /64 hits one bucket; a forged header buys none', async () => {
    execute.mockResolvedValue({ rows: [{ allowed: true }] });
    signInEmail.mockImplementation(async () => Response.json({ error: 'x' }, { status: 401 }));
    await login(EXISTING, '2001:db8:1:2::1');
    await login(UNKNOWN, '2001:db8:1:2::beef');
    await login(EXISTING, 'x');
    await login(UNKNOWN, 'definitely-not-an-address');
    expect(limiterKeys()).toEqual([
      'login:2001:db8:1:2::/64',
      'login:2001:db8:1:2::/64',
      'login:unknown',
      'login:unknown',
    ]);
  });

  it('malformed requests are refused before the limiter is consulted', async () => {
    const res = await POST(
      new Request('http://localhost:3000/api/auth/login', { method: 'POST', body: '{' }),
    );
    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    expect(signInEmail).not.toHaveBeenCalled();
  });
});
