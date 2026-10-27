import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FU-2: /api/auth/mfa/verify is the only HTTP path that completes a sign-in second
 * factor, and Better Auth's TOTP enrolment still works over HTTP.
 *
 * Everything here is the production code: the real `auth` instance from
 * src/lib/auth/server.ts (its hooks, disabledPaths, rate limiter and the two-factor
 * plugin), the real [...all] route and the real mediated route. Only storage is swapped:
 * the Drizzle adapter factory returns Better Auth's in-memory adapter, and the helpers
 * that reach Postgres through authDb (lockout, person liveness, event recording, the
 * B1 limiter's check_rate_limit) are stubbed. No test in this file can reach a database.
 */
const { mem, execute, recordLoginEvent } = vi.hoisted(() => ({
  mem: {
    auth_users: [],
    auth_sessions: [],
    auth_accounts: [],
    auth_verifications: [],
    auth_two_factors: [],
    auth_rate_limits: [],
  } as Record<string, Record<string, unknown>[]>,
  execute: vi.fn(),
  recordLoginEvent: vi.fn(),
}));

vi.mock('better-auth/adapters/drizzle', async () => {
  const { memoryAdapter } = await vi.importActual<typeof import('better-auth/adapters/memory')>(
    'better-auth/adapters/memory',
  );
  return { drizzleAdapter: () => memoryAdapter(mem) };
});
vi.mock('@/lib/db/auth-client', () => ({ authDb: { execute } }));
vi.mock('@/lib/auth/login-lockout', () => ({
  isLockedOut: async () => false,
  noteLoginFailure: async () => undefined,
  noteLoginSuccess: async () => undefined,
  clearLoginLockout: async () => undefined,
}));
vi.mock('@/lib/auth/login-person-check', () => ({ loginPersonActive: async () => true }));
vi.mock('@/lib/auth/login-events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/login-events')>()),
  recordLoginEvent,
  resolveLoginOrg: async () => null,
}));

import {
  auth,
  HTTP_DISABLED_AUTH_PATHS,
  isRoutedSignInChallengeVerification,
  TWO_FACTOR_CHALLENGE_COOKIE,
} from '@/lib/auth/server';
import { POST as allRoutePOST } from '@/app/api/auth/[...all]/route';
import { POST as mfaVerifyPOST } from '@/app/api/auth/mfa/verify/route';

const BASE = 'http://localhost:3000';
const PASSWORD = 'correct horse battery staple';

let ipSeq = 0;
/** A fresh address per request, so no per-address bucket (ours or the library's) fills. */
const nextIp = () => `198.51.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

/** A cookie jar: applies a response's Set-Cookie headers to a Cookie header string. */
const jar = (prev: string, res: Response): string => {
  const cookies = new Map<string, string>();
  for (const kv of prev ? prev.split('; ') : []) {
    const at = kv.indexOf('=');
    cookies.set(kv.slice(0, at), kv.slice(at + 1));
  }
  for (const set of res.headers.getSetCookie()) {
    const [pair = '', ...attrs] = set.split(';');
    const at = pair.indexOf('=');
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (value === '' || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) cookies.delete(name);
    else cookies.set(name, value);
  }
  return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
};

/** A POST to the library through the real [...all] route — the HTTP router. */
const routed = (path: string, body: unknown, cookie = '') =>
  allRoutePOST(
    new Request(`${BASE}/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE,
        'x-forwarded-for': nextIp(),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

/** A POST to the mediated route, as the /mfa page sends it. */
const mediated = (body: Record<string, unknown>, cookie: string) =>
  mfaVerifyPOST(
    new Request(`${BASE}/api/auth/mfa/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE,
        'x-forwarded-for': nextIp(),
        cookie,
      },
      body: JSON.stringify(body),
    }),
  );

const base32Decode = (input: string): Buffer => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

/** RFC 6238 TOTP for the current period (SHA-1, 6 digits, 30 s), as the plugin uses. */
const totpNow = (secret: string): string => {
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
};

/** The challenge cookie's exact name, as the plugin builds it for this configuration. */
const challengeCookieName = async () =>
  (await auth.$context).createAuthCookie(TWO_FACTOR_CHALLENGE_COOKIE).name;

let userSeq = 0;

/** A login with a credential password, created straight in the in-memory store. */
async function newLogin() {
  const ctx = await auth.$context;
  const email = `fu2-${++userSeq}@example.test`;
  const user = await ctx.internalAdapter.createUser(
    { email, name: 'FU2', emailVerified: true },
    { method: 'admin' },
  );
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: await ctx.password.hash(PASSWORD),
  });
  return { email, userId: user.id };
}

/**
 * Enrols TOTP the way the security page does: sign in (no factor yet, so a session),
 * /two-factor/enable, then the first code through the library's HTTP verify-totp.
 */
async function enrol(email: string) {
  const signIn = await routed('/sign-in/email', { email, password: PASSWORD });
  expect(signIn.status).toBe(200);
  let cookie = jar('', signIn);
  const enabled = await routed('/two-factor/enable', { password: PASSWORD }, cookie);
  expect(enabled.status).toBe(200);
  cookie = jar(cookie, enabled);
  const { totpURI, backupCodes } = (await enabled.json()) as {
    totpURI: string;
    backupCodes: string[];
  };
  const secret = new URL(totpURI).searchParams.get('secret')!;
  const confirmed = await routed('/two-factor/verify-totp', { code: totpNow(secret) }, cookie);
  return { secret, backupCodes, confirmed, cookie: jar(cookie, confirmed) };
}

/** A fresh browser signs in as an enrolled login and receives the challenge. */
async function challenge(email: string) {
  const res = await routed('/sign-in/email', { email, password: PASSWORD });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
  const cookie = jar('', res);
  expect(cookie).toContain(`${await challengeCookieName()}=`);
  return cookie;
}

/** The pending challenge's attempt counter for a login, read from the store. */
function attemptsFor(userId: string): string | undefined {
  const rows = mem.auth_verifications as { identifier: string; value: string }[];
  const pending = rows.filter(
    (r) => r.identifier.startsWith('2fa-') && !r.identifier.startsWith('2fa-attempts-'),
  );
  const mine = pending.filter((r) => r.value === userId).at(-1);
  if (!mine) return undefined;
  return rows.find((r) => r.identifier === `2fa-attempts-${mine.identifier}`)?.value;
}

async function enrolledLogin() {
  const login = await newLogin();
  const enrolment = await enrol(login.email);
  expect(enrolment.confirmed.status).toBe(200);
  return { ...login, ...enrolment };
}

const isSessionCookie = (c: string) => /(^|; )better-auth\.session_token=/.test(c);

beforeEach(() => {
  execute.mockReset().mockResolvedValue({ rows: [{ allowed: true }] });
  recordLoginEvent.mockReset();
});

describe('FU-2: library HTTP verification is closed to the sign-in challenge', () => {
  it('refuses a routed verify-totp carrying the challenge, even with the right code', async () => {
    const { email, userId, secret } = await enrolledLogin();
    const cookie = await challenge(email);
    expect(attemptsFor(userId)).toBe('0');

    const res = await routed('/two-factor/verify-totp', { code: totpNow(secret) }, cookie);
    expect(res.status).toBe(403);
    expect(isSessionCookie(jar('', res))).toBe(false);
    // Refused before the endpoint: none of the challenge's five attempts is spent.
    expect(attemptsFor(userId)).toBe('0');
  });

  it('refuses it also when a session cookie travels alongside the challenge', async () => {
    const { email, secret, cookie: enrolledSession } = await enrolledLogin();
    const cookie = `${enrolledSession}; ${await challenge(email)}`;
    const res = await routed('/two-factor/verify-totp', { code: totpNow(secret) }, cookie);
    expect(res.status).toBe(403);
  });

  it.each(HTTP_DISABLED_AUTH_PATHS)('answers 404 for %s over HTTP', async (path) => {
    const { email, userId, backupCodes } = await enrolledLogin();
    const cookie = await challenge(email);
    const res = await routed(path, { code: backupCodes[0] }, cookie);
    expect(res.status).toBe(404);
    expect(attemptsFor(userId)).toBe('0');
  });

  it('disabledPaths is exactly the backup-code and OTP verification endpoints', () => {
    expect(auth.options.disabledPaths).toEqual([
      '/two-factor/verify-backup-code',
      '/two-factor/verify-otp',
    ]);
  });
});

describe('FU-2: enrolment still confirms through the library over HTTP', () => {
  it('a routed verify-totp with a session and no challenge enables the factor', async () => {
    const login = await newLogin();
    const { confirmed } = await enrol(login.email);
    expect(confirmed.status).toBe(200);
    const user = (mem.auth_users as { id: string; twoFactorEnabled?: boolean }[]).find(
      (u) => u.id === login.userId,
    );
    expect(user?.twoFactorEnabled).toBe(true);
    const factor = (mem.auth_two_factors as { userId: string; verified?: boolean }[]).find(
      (f) => f.userId === login.userId,
    );
    expect(factor?.verified).toBe(true);
  });
});

describe('FU-2: the mediated route is unaffected', () => {
  it('completes the same challenge the router refused, with TOTP', async () => {
    const { email, userId, secret } = await enrolledLogin();
    const cookie = await challenge(email);
    expect(
      (await routed('/two-factor/verify-totp', { code: totpNow(secret) }, cookie)).status,
    ).toBe(403);

    recordLoginEvent.mockClear(); // only the mediated route's own recording from here
    const res = await mediated({ code: totpNow(secret), email }, cookie);
    expect(res.status).toBe(200);
    expect(isSessionCookie(jar('', res))).toBe(true);
    const success = recordLoginEvent.mock.calls.find(
      ([e]) => (e as { eventType: string }).eventType === 'LOGIN_SUCCESS',
    )?.[0] as { authUserId: string; metadata: unknown } | undefined;
    expect(success).toMatchObject({ authUserId: userId, metadata: { via: 'mfa' } });
  });

  it('completes a challenge with a backup code the router refused to verify', async () => {
    const { email, backupCodes } = await enrolledLogin();
    const cookie = await challenge(email);
    expect(
      (await routed('/two-factor/verify-backup-code', { code: backupCodes[0] }, cookie)).status,
    ).toBe(404);

    const res = await mediated({ code: backupCodes[0], method: 'backup-code' }, cookie);
    expect(res.status).toBe(200);
    expect(isSessionCookie(jar('', res))).toBe(true);
  });

  it('runs the B1 limiter before the factor check, and a denial spends no attempt', async () => {
    const { email, userId, secret } = await enrolledLogin();
    const cookie = await challenge(email);
    execute.mockReset().mockResolvedValue({ rows: [{ allowed: false }] });

    const res = await mediated({ code: totpNow(secret) }, cookie);
    expect(res.status).toBe(429);
    expect(attemptsFor(userId)).toBe('0');
    const sqlText = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(sqlText).toContain('check_rate_limit');
    expect(sqlText).toContain('mfa:verify:');
  });

  it('a direct auth.api call carrying the challenge reaches the endpoint (no request on it)', async () => {
    const { email, userId, secret } = await enrolledLogin();
    const cookie = await challenge(email);

    const wrong = (await auth.api.verifyTOTP({
      body: { code: '000000' === totpNow(secret) ? '111111' : '000000' },
      headers: new Headers({ cookie }),
      asResponse: true,
    })) as Response;
    // The endpoint ran and judged the code (401 INVALID_CODE), spending one attempt —
    // the HTTP-only refusal (403) did not apply.
    expect(wrong.status).toBe(401);
    expect(attemptsFor(userId)).toBe('1');

    const right = (await auth.api.verifyTOTP({
      body: { code: totpNow(secret) },
      headers: new Headers({ cookie }),
      asResponse: true,
    })) as Response;
    expect(right.status).toBe(200);
  });
});

/**
 * How the installed router (better-call 1.4.0) treats spellings of these paths, observed
 * through the real [...all] route. The router routes on WHATWG URL.pathname: dot segments
 * (also %2e%2e) are resolved and the query dropped, so those reach the canonical path and
 * meet the refusal; anything else — case, a trailing or doubled slash, percent-encoding,
 * `;` or a trailing encoded space — matches no route at all. disabledPaths compares the
 * same pathname with trailing slashes stripped. No spelling reaches an endpoint. What
 * Next.js does to a URL before the route sees it is not covered here.
 */
describe('FU-2: no spelling of the path reaches a verification endpoint', () => {
  const cases: [string, number][] = [
    ['/two-factor/verify-totp/', 404],
    ['/two-factor/VERIFY-TOTP', 404],
    ['/Two-Factor/verify-totp', 404],
    ['/two-factor/verify%2Dtotp', 404],
    ['/two-factor%2Fverify-totp', 404],
    ['/two-factor/x/../verify-totp', 403],
    ['/two-factor/%2e%2e/two-factor/verify-totp', 403],
    ['//two-factor/verify-totp', 404],
    ['/two-factor//verify-totp', 404],
    ['/two-factor/verify-totp?x=1', 403],
    ['/two-factor/verify-totp;x', 404],
    ['/two-factor/verify-totp%20', 404],
    ['/two-factor/verify-backup-code/', 404],
    ['/two-factor/VERIFY-BACKUP-CODE', 404],
    ['/two-factor/verify%2Dbackup-code', 404],
    ['/two-factor/x/../verify-backup-code', 404],
    ['/two-factor/verify-backup-code?x=1', 404],
    ['//two-factor/verify-backup-code', 404],
    ['/two-factor/verify-otp/', 404],
    ['/two-factor/verify%2Dotp', 404],
    ['/two-factor/x/../verify-otp', 404],
  ];

  it('answers each spelling as pinned, and the challenge keeps every attempt', async () => {
    const { email, userId, secret, backupCodes } = await enrolledLogin();
    const cookie = await challenge(email);
    for (const [path, status] of cases) {
      const code = path.toLowerCase().includes('backup') ? backupCodes[0] : totpNow(secret);
      const res = await routed(path, { code }, cookie);
      expect({ path, status: res.status }).toEqual({ path, status });
    }
    expect(attemptsFor(userId)).toBe('0');
    // ...and the challenge still completes through the mediated route afterwards.
    expect((await mediated({ code: totpNow(secret) }, cookie)).status).toBe(200);
  });
});

describe('FU-2: the routed-challenge check itself', () => {
  const ctxWith = (over: { path?: string; request?: unknown; cookie?: string | null }) => ({
    path: over.path ?? '/two-factor/verify-totp',
    request: over.request,
    getCookie: (key: string) => (key === 'better-auth.two_factor' ? (over.cookie ?? null) : null),
    context: { createAuthCookie: (name: string) => ({ name: `better-auth.${name}` }) },
  });
  const httpRequest = new Request(`${BASE}/api/auth/two-factor/verify-totp`, { method: 'POST' });

  it('needs both a routed request and the challenge cookie', () => {
    expect(
      isRoutedSignInChallengeVerification(ctxWith({ request: httpRequest, cookie: 'x' })),
    ).toBe(true);
    expect(isRoutedSignInChallengeVerification(ctxWith({ request: httpRequest }))).toBe(false);
    expect(isRoutedSignInChallengeVerification(ctxWith({ cookie: 'x' }))).toBe(false);
  });

  it('covers every verification endpoint and nothing else', () => {
    for (const path of ['/two-factor/verify-backup-code', '/two-factor/verify-otp']) {
      expect(
        isRoutedSignInChallengeVerification(ctxWith({ path, request: httpRequest, cookie: 'x' })),
      ).toBe(true);
    }
    for (const path of ['/two-factor/enable', '/two-factor/disable', '/sign-in/email', undefined]) {
      const ctx = { ...ctxWith({ request: httpRequest, cookie: 'x' }), path };
      expect(isRoutedSignInChallengeVerification(ctx)).toBe(false);
    }
  });

  it('a forged or unsigned challenge value still counts as present', () => {
    expect(
      isRoutedSignInChallengeVerification(ctxWith({ request: httpRequest, cookie: 'forged' })),
    ).toBe(true);
  });
});

describe('FU-2: pinned library surface', () => {
  it('the installed verification endpoints are exactly these three', () => {
    const paths = Object.values(auth.api)
      .map((endpoint) => (endpoint as { path?: string }).path)
      .filter((p): p is string => typeof p === 'string' && p.startsWith('/two-factor/verify-'))
      .sort();
    expect(paths).toEqual([
      '/two-factor/verify-backup-code',
      '/two-factor/verify-otp',
      '/two-factor/verify-totp',
    ]);
  });

  it('the challenge cookie the plugin sets is the one the check reads', async () => {
    const { email } = await enrolledLogin();
    const res = await routed('/sign-in/email', { email, password: PASSWORD });
    const names = res.headers.getSetCookie().map((c) => c.slice(0, c.indexOf('=')));
    expect(names).toContain(await challengeCookieName());
    expect(await challengeCookieName()).toBe('better-auth.two_factor');
  });
});
