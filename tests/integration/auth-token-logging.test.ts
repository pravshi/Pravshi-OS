/**
 * Session tokens never reach a log line, an error a caller sees, or a response body — when the
 * database fails under the authentication plane. LIVE DB, real Better Auth, real HTTP handler.
 *
 * The defect (WP-A1 audit, HIGH): drizzle wraps every failed query in a DrizzleQueryError whose
 * message carries every bound parameter; the session lookup binds the session's bearer token; and
 * Better Auth logged the error whole. A permission error, a timeout or an exhausted pool during a
 * session lookup therefore printed the token to the server log.
 *
 * How the failures are made: the auth module's pool (src/lib/db/auth-pool.ts) is replaced by one
 * that sends every query to the real app_auth pool EXCEPT the ones a case targets, which fail in
 * one of three ways —
 *   permission  the query runs on the app_worker login, which holds nothing in the auth schema: a
 *               genuine Postgres 42501 from the real database;
 *   connection  pg-pool's own connect-timeout error, as an exhausted or cold pool raises it;
 *   nested      an error whose message, detail and cause chain all carry the token.
 * Nothing global changes — no grant, no DDL — so this file cannot disturb a parallel suite.
 *
 * Every console method and both process streams are captured; each case asserts its canary is in
 * none of them, nor in the response or the error the caller receives. Canaries are 20 characters,
 * below the 32-character opaque-token backstop in redact.ts, so these cases prove the structural
 * rules (errors are summarised, never printed), not the pattern match. A failing assertion names
 * the place, never the canary.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';

import { AUTH_DB_READY } from '../auth-role';

const READY =
  AUTH_DB_READY &&
  Boolean(
    process.env.DATABASE_URL_TEST &&
    process.env.DATABASE_URL_MIGRATE &&
    process.env.DATABASE_URL_WORKER,
  );

type Mode = 'none' | 'permission' | 'connection' | 'nested';
const fault = vi.hoisted(() => ({
  mode: 'none' as 'none' | 'permission' | 'connection' | 'nested',
  table: '"auth_sessions"',
  canary: '',
}));

vi.mock('@/lib/db/auth-pool', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/db/auth-pool')>();
  const { Pool } = await import('@neondatabase/serverless');
  // app_worker: a real login with no privilege in the auth schema (0073 verifies it).
  const noPrivilege = new Pool({ connectionString: process.env.DATABASE_URL_WORKER, max: 2 });
  const sqlOf = (a: unknown) =>
    typeof a === 'string' ? a : ((a as { text?: string } | null)?.text ?? '');
  type AnyFn = (...a: unknown[]) => never;
  class FaultInjectingPool extends Pool {
    constructor() {
      super({ max: 1 });
    }
    override query(...args: unknown[]): never {
      if (fault.mode !== 'none' && sqlOf(args[0]).includes(fault.table)) {
        if (fault.mode === 'permission')
          return (noPrivilege.query as AnyFn).apply(noPrivilege, args);
        if (fault.mode === 'connection')
          return Promise.reject(new Error('timeout exceeded when trying to connect')) as never;
        const inner = Object.assign(new Error(`socket closed while sending ${fault.canary}`), {
          code: 'ECONNRESET',
        });
        return Promise.reject(
          Object.assign(
            new Error(`duplicate key value: Key (token)=(${fault.canary}) already exists`),
            { code: '23505', detail: `Key (token)=(${fault.canary})`, cause: inner },
          ),
        ) as never;
      }
      return (real.authPool.query as AnyFn).apply(real.authPool, args);
    }
    override connect(...args: unknown[]): never {
      return (real.authPool.connect as AnyFn).apply(real.authPool, args);
    }
    override end(): never {
      return Promise.all([real.authPool.end(), noPrivilege.end()]) as never;
    }
  }
  return { ...real, authPool: new FaultInjectingPool() };
});

// The route's alert goes to Sentry: observed here, never sent (no DSN in tests either).
vi.mock('@sentry/nextjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/nextjs')>()),
  captureException: vi.fn(() => 'test-event-id'),
}));

// ── capture everything the process could write ────────────────────────────────────────────
const sink: string[] = [];
function deep(x: unknown, seen = new Set<unknown>()): string {
  if (typeof x === 'string') return x;
  if (x === null || typeof x !== 'object') return String(x);
  if (seen.has(x)) return '[cycle]';
  seen.add(x);
  if (x instanceof Error) {
    const own = Object.getOwnPropertyNames(x)
      .map((k) => `${k}=${deep((x as unknown as Record<string, unknown>)[k], seen)}`)
      .join(' ');
    return `${x.name} ${x.message} ${x.stack ?? ''} ${own} ${deep((x as { cause?: unknown }).cause, seen)}`;
  }
  try {
    return JSON.stringify(x, (_k, v: unknown) => (v instanceof Error ? deep(v, seen) : v));
  } catch {
    return Object.entries(x as Record<string, unknown>)
      .map(([k, v]) => `${k}:${deep(v, seen)}`)
      .join(' ');
  }
}
const methods = ['error', 'warn', 'log', 'info', 'debug', 'trace'] as const;
const spies: { mockRestore(): void }[] = [];
const captured = () => sink.join('\n');

/** Absent, without ever printing the canary on failure. */
const expectAbsent = (haystack: string, canary: string, where: string) =>
  expect(haystack.includes(canary), `the canary appears in ${where}`).toBe(false);

describe.skipIf(!READY)('session tokens never reach logs or responses (live DB)', async () => {
  const fx = await import('../authz/fixtures');
  const { auth } = await import('@/lib/auth/server');
  const { GET, POST } = await import('@/app/api/auth/[...all]/route');
  const { resolveAuthContext, currentSessionToken } = await import('@/lib/auth/session');

  const owner = fx.ownerPool();
  const RUN = fx.runId();
  let org = '';
  let dept = '';
  let cookieName = '';

  /** A correctly signed session cookie for `token` (better-call's HMAC-SHA256 format). */
  const signedCookie = (token: string) => {
    const sig = createHmac('sha256', process.env.BETTER_AUTH_SECRET!)
      .update(token)
      .digest('base64');
    return `${cookieName}=${encodeURIComponent(`${token}.${sig}`)}`;
  };
  const newCanary = () => `cnry${randomBytes(8).toString('hex')}`; // 20 chars: below the backstop
  const getSession = (cookie: string) =>
    GET(new Request('http://localhost:3000/api/auth/get-session', { headers: { cookie } }));

  beforeAll(async () => {
    org = await fx.mkOrg(owner, `atl-${RUN}`);
    dept = await fx.mkDept(owner, org, `ATL${RUN.toUpperCase()}`);
    const ctx = await (
      auth as unknown as { $context: Promise<{ authCookies: { sessionToken: { name: string } } }> }
    ).$context;
    cookieName = ctx.authCookies.sessionToken.name;
  }, 60_000);

  afterAll(async () => {
    await owner.end();
  });

  beforeEach(() => {
    sink.length = 0;
    fault.mode = 'none';
    fault.table = '"auth_sessions"';
    for (const m of methods) {
      spies.push(
        vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void sink.push(deep(a))),
      );
    }
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      spies.push(
        vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
          const text =
            typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString();
          sink.push(text);
          // Pass through what the runner prints, but never a canary.
          const shown = fault.canary ? text.replaceAll(fault.canary, '[canary]') : text;
          return (original as (c: string, ...r: unknown[]) => boolean)(shown, ...rest);
        }) as typeof stream.write),
      );
    }
  });

  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
    fault.mode = 'none';
    fault.canary = '';
  });

  // ── the legitimate paths still work ───────────────────────────────────────────────────
  it('control: a real sign-in and session lookup succeed, and log nothing', async () => {
    const acct = await fx.mkAccount(owner, {
      org,
      dept,
      run: RUN,
      label: 'atlok',
      roles: ['EMPLOYEE'],
    });
    const res = await GET(
      new Request('http://localhost:3000/api/auth/get-session', {
        headers: { cookie: acct.cookie },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { id?: string } } | null;
    expect(body?.user?.id).toBe(acct.authUserId);
    const token = await currentSessionToken(fx.headersFor(acct.cookie));
    expect(token).toBeTruthy();
    expect(await resolveAuthContext(fx.headersFor(acct.cookie))).not.toBeNull();
    expect(sink.filter((l) => l.includes('[auth]'))).toEqual([]);
  });

  // ── a failing session lookup, three ways ─────────────────────────────────────────────
  for (const mode of ['permission', 'connection', 'nested'] as const satisfies readonly Mode[]) {
    it(`${mode}: a failed session lookup over HTTP answers a fixed 500 and logs a safe line — never the token`, async () => {
      const canary = newCanary();
      fault.canary = canary;
      fault.mode = mode;
      const res = await getSession(signedCookie(canary));
      const text = await res.text();
      expect(res.status).toBe(500);
      expectAbsent(text, canary, 'the response body');
      expect(text).not.toMatch(/Failed query|params:|auth_sessions|select /i);
      fault.mode = 'none';
      const all = captured();
      expectAbsent(all, canary, 'the captured logs');
      expect(all).not.toMatch(/params:\s*[^\s[]/);
      // The diagnostic survives: an [auth] line naming the failure and its code.
      const line = sink.find((l) => l.includes('[auth]') && l.includes('INTERNAL_SERVER_ERROR'));
      expect(line, 'a safe [auth] error line').toBeDefined();
      if (mode === 'permission') expect(line).toContain('42501');
      if (mode === 'nested') expect(line).toContain('23505');
    });
  }

  it('permission: the server-side session resolution fails without carrying the token anywhere', async () => {
    const canary = newCanary();
    fault.canary = canary;
    fault.mode = 'permission';
    const h = fx.headersFor(signedCookie(canary));
    const e1 = await resolveAuthContext(h).then(
      () => null,
      (e: unknown) => e,
    );
    const e2 = await currentSessionToken(h).then(
      () => null,
      (e: unknown) => e,
    );
    fault.mode = 'none';
    for (const [name, e] of [
      ['resolveAuthContext', e1],
      ['currentSessionToken', e2],
    ] as const) {
      expect(e, `${name} rejects`).not.toBeNull();
      expectAbsent(deep(e), canary, `the error ${name} throws`);
    }
    expectAbsent(captured(), canary, 'the captured logs');
  });

  // ── outside an endpoint: the route's last resort ────────────────────────────────────
  it('a failure thrown out of the handler (the rate limiter runs before any endpoint) is a fixed 500 and a safe line', async () => {
    const Sentry = await import('@sentry/nextjs');
    const capture = vi.mocked(Sentry.captureException);
    capture.mockClear();
    const canary = newCanary();
    fault.canary = canary;
    fault.table = '"auth_rate_limits"';
    fault.mode = 'nested';
    try {
      const res = await getSession(signedCookie(canary));
      fault.mode = 'none';
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Authentication is temporarily unavailable.',
      });
      const all = captured();
      expectAbsent(all, canary, 'the captured logs');
      expect(all).not.toMatch(/Failed query|params:/);
      expect(sink.some((l) => l.includes('[auth] auth.route.unhandled'))).toBe(true);
      // The alert is raised, from the class and code alone.
      expect(capture).toHaveBeenCalledTimes(1);
      const reported = capture.mock.calls[0]![0] as Error;
      expect(reported.name).toBe('AuthRouteError');
      expectAbsent(deep(reported), canary, 'the reported Sentry exception');
      expect(deep(reported)).not.toMatch(/Failed query|params:/);
    } finally {
      capture.mockClear();
    }
  });

  // ── sign-in: the session insert fails ───────────────────────────────────────────────
  it('a sign-in whose session insert fails answers without a session and logs no parameter or credential', async () => {
    const acct = await fx.mkAccount(owner, {
      org,
      dept,
      run: RUN,
      label: 'atlsi',
      roles: ['EMPLOYEE'],
    });
    const Sentry = await import('@sentry/nextjs');
    const capture = vi.mocked(Sentry.captureException);
    capture.mockClear();
    sink.length = 0;
    fault.mode = 'permission'; // the insert into auth.auth_sessions (the new session's token)
    const res = await POST(
      new Request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `198.18.${100 + Math.floor(Math.random() * 50)}.${Math.floor(Math.random() * 250) + 1}`,
          origin: 'http://localhost:3000',
        },
        body: JSON.stringify({ email: acct.email, password: fx.PASSWORD }),
      }),
    );
    fault.mode = 'none';
    expect(res.ok).toBe(false);
    expect(res.headers.get('set-cookie') ?? '').not.toMatch(/session_token=[^;]+\./);
    const all = captured();
    expectAbsent(all, fx.PASSWORD, 'the captured logs (password)');
    expect(all).not.toMatch(/params:\s*[^\s[]/);
    // No opaque token-shaped value at all: the session token is generated server-side, so its
    // absence is asserted by shape.
    expect(all).not.toMatch(
      /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{32}(?![A-Za-z0-9_-])/,
    );
    // Not the router's raw `# SERVER_ERROR:` print: the route's safe line, and one alert.
    expect(all).not.toContain('SERVER_ERROR: ');
    expect(sink.some((l) => l.includes('[auth] auth.route.unhandled'))).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(deep(capture.mock.calls[0]![0])).not.toMatch(/Failed query|params:/);
    capture.mockClear();
  });
});
