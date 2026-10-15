/**
 * Changing a password never lets the session token — or the new password's hash — out in an
 * error, a log line or a response, when the database fails under it. LIVE DB, the real server
 * action (/me/security changePasswordAction), real Better Auth sessions.
 *
 * The defect (WP-A1 audit, HIGH): change-password deletes every other session with
 * `token != <current session token>`. A failure of that statement surfaced as drizzle's
 * DrizzleQueryError, whose message lists its bound parameters — the current session's bearer
 * token — and the action rethrew it to Next.js, which logs a server action's error. The credential
 * update before it (`update_credential_password(<user>, <new hash>)`) was rethrown the same way.
 *
 * How the failures are made: the auth module's pool is replaced by one that passes every query —
 * on the pool AND on a checked-out client, since the credential update and the session deletion
 * run in one transaction — to the real app_auth pool, except the statement a case targets, which
 * fails in one of three ways:
 *   missing-table  the same statement against a table that does not exist: a genuine Postgres
 *                  error (42P01) carrying the real bound parameters, the current token included;
 *   connection     a dropped connection, as the driver raises it;
 *   nested         an error whose message, detail and cause all carry the token.
 * The current session's token is a synthetic canary, below the 32-character opaque-token
 * backstop of redact.ts, so the cases prove the structural handling, not a pattern match.
 * Failures name the place, never the canary.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';

import { AUTH_DB_READY } from '../auth-role';

const READY =
  AUTH_DB_READY && Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

const fault = vi.hoisted(() => ({
  mode: 'none' as 'none' | 'missing-table' | 'connection' | 'nested',
  pattern: /$^/,
  canary: '',
}));
const request = vi.hoisted(() => ({ headers: new Headers() }));
const auditFault = vi.hoisted(() => ({ fail: false, canary: '' }));

vi.mock('next/headers', () => ({ headers: async () => request.headers }));

// Observed, never sent.
vi.mock('@sentry/nextjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/nextjs')>()),
  captureException: vi.fn(() => 'test-event-id'),
}));

// The audit write after the change commits: real, unless a case makes it fail like a query would.
vi.mock('@/lib/audit/log', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/audit/log')>();
  const { DrizzleQueryError } = await import('drizzle-orm');
  return {
    ...real,
    writeAuditEntry: async (...args: Parameters<typeof real.writeAuditEntry>) => {
      if (auditFault.fail) {
        throw new DrizzleQueryError(
          'select public.write_audit_log(...)',
          [auditFault.canary],
          Object.assign(new Error(`audit refused near ${auditFault.canary}`), { code: '57014' }),
        );
      }
      return real.writeAuditEntry(...args);
    },
  };
});

vi.mock('@/lib/db/auth-pool', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/db/auth-pool')>();
  const { Pool } = await import('@neondatabase/serverless');
  type AnyFn = (...a: unknown[]) => Promise<unknown>;
  const textOf = (a: unknown) =>
    typeof a === 'string' ? a : ((a as { text?: string } | null)?.text ?? '');
  /** Run `args` through `exec`, unless they are the targeted statement. */
  const intercept = (args: unknown[], exec: AnyFn): Promise<unknown> => {
    const text = textOf(args[0]);
    if (fault.mode === 'none' || !fault.pattern.test(text)) return exec(...args);
    if (fault.mode === 'missing-table') {
      const broken = text.replace(/auth\.auth_sessions/g, 'auth.auth_sessions_absent');
      const first = typeof args[0] === 'string' ? broken : { ...(args[0] as object), text: broken };
      return exec(first, ...args.slice(1));
    }
    if (fault.mode === 'connection')
      return Promise.reject(new Error('Connection terminated unexpectedly'));
    return Promise.reject(
      Object.assign(new Error(`could not complete for ${fault.canary}`), {
        code: '08006',
        detail: `token=${fault.canary}`,
        cause: new Error(`socket said ${fault.canary}`),
      }),
    );
  };
  class FaultInjectingPool extends Pool {
    constructor() {
      super({ max: 1 });
    }
    override query(...args: unknown[]): never {
      return intercept(args, (...a) =>
        (real.authPool.query as AnyFn).apply(real.authPool, a),
      ) as never;
    }
    override connect(...args: unknown[]): never {
      if (args.length) return (real.authPool.connect as AnyFn).apply(real.authPool, args) as never;
      return (async () => {
        const client = (await real.authPool.connect()) as unknown as {
          query: AnyFn;
          release: (...r: unknown[]) => unknown;
        };
        const query = client.query.bind(client);
        const release = client.release.bind(client);
        client.query = (...a: unknown[]) => intercept(a, query);
        client.release = (...r: unknown[]) => {
          client.query = query;
          client.release = release;
          return release(...r);
        };
        return client;
      })() as never;
    }
    override end(): never {
      return real.authPool.end() as never;
    }
  }
  return { ...real, authPool: new FaultInjectingPool() };
});

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
const spies: { mockRestore(): void }[] = [];
const expectAbsent = (haystack: string, canary: string, where: string) =>
  expect(haystack.includes(canary), `the canary appears in ${where}`).toBe(false);

describe.skipIf(!READY)('changing a password never leaks the session token (live DB)', async () => {
  const fx = await import('../authz/fixtures');
  const { changePasswordAction } = await import('@/app/(app)/me/security/actions');
  const { changePassword, ChangePasswordError } = await import('@/lib/auth/change-password');
  const { resolveAuthContext } = await import('@/lib/auth/session');
  const { requestMetadata } = await import('@/lib/audit/log');
  const Sentry = await import('@sentry/nextjs');
  const { resetAuthAlertLimiter, ALERT_LIMIT, ALERT_WINDOW_MS } =
    await import('@/lib/auth/safe-log');
  const { auth } = await import('@/lib/auth/server');

  const owner = fx.ownerPool();
  const RUN = fx.runId();
  const NEW_PASSWORD = 'a different passphrase 8813 entirely';
  let org = '';
  let dept = '';
  let cookieName = '';
  let ipSeq = 0;

  const signedCookie = (token: string) => {
    const sig = createHmac('sha256', process.env.BETTER_AUTH_SECRET!)
      .update(token)
      .digest('base64');
    return `${cookieName}=${encodeURIComponent(`${token}.${sig}`)}`;
  };
  const newCanary = () => `cnry${randomBytes(8).toString('hex')}`; // 20 chars

  /** An account with three sessions: the canary-token one (current) and two others. */
  async function account(label: string) {
    const acct = await fx.mkAccount(owner, {
      org,
      dept,
      run: RUN,
      label,
      roles: ['EMPLOYEE'],
    });
    await fx.signIn(acct.email); // a second "other" session (mkAccount made the first)
    const canary = newCanary();
    const current = (
      await owner.query<{ id: string }>(
        `insert into auth.auth_sessions (user_id, token, expires_at, aal)
         values ($1, $2, now() + interval '1 day', 'aal1') returning id`,
        [acct.authUserId, canary],
      )
    ).rows[0]!.id;
    request.headers = new Headers({
      cookie: signedCookie(canary),
      'x-forwarded-for': `198.18.${150 + Math.floor(Math.random() * 40)}.${(ipSeq += 1) % 250}`,
      'user-agent': 'vitest-change-password',
    });
    return { ...acct, canary, current };
  }
  const sessionIds = async (login: string) =>
    (
      await owner.query<{ id: string }>(
        `select id from auth.auth_sessions where user_id = $1 order by id`,
        [login],
      )
    ).rows.map((r) => r.id);
  const storedHash = async (login: string) =>
    (
      await owner.query<{ password: string }>(
        `select password from auth.auth_accounts where user_id = $1 and provider_id = 'credential'`,
        [login],
      )
    ).rows[0]!.password;
  const auditCount = async (login: string) =>
    Number(
      (
        await owner.query<{ n: string }>(
          `select count(*)::text n from public.audit_logs
            where action = 'auth.password_change' and entity_id = $1`,
          [login],
        )
      ).rows[0]!.n,
    );
  const signsIn = (email: string, password: string) =>
    fx.signIn(email, password).then(
      () => true,
      () => false,
    );

  beforeAll(async () => {
    org = await fx.mkOrg(owner, `cpl-${RUN}`);
    dept = await fx.mkDept(owner, org, `CPL${RUN.toUpperCase()}`);
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
    auditFault.fail = false;
    vi.mocked(Sentry.captureException).mockClear();
    resetAuthAlertLimiter();
    // The new-password policy asks HIBP: answer locally with a non-matching range.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1\n', { status: 200 })),
    );
    for (const m of ['error', 'warn', 'log', 'info', 'debug', 'trace'] as const) {
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
          let shown = text;
          for (const c of [fault.canary, auditFault.canary])
            if (c) shown = shown.replaceAll(c, '[canary]');
          return (original as (c: string, ...r: unknown[]) => boolean)(shown, ...rest);
        }) as typeof stream.write),
      );
    }
  });

  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
    vi.unstubAllGlobals();
    fault.mode = 'none';
    fault.canary = '';
    auditFault.fail = false;
    auditFault.canary = '';
  });

  /** Run the action; a throw is captured, never left to the runner (which would print it). */
  const act = (currentPassword: string, newPassword: string) =>
    changePasswordAction(currentPassword, newPassword).then(
      (result) => ({ result, thrown: null as unknown }),
      (thrown: unknown) => ({ result: null, thrown }),
    );

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  /**
   * Exactly one Sentry alert for `event`, built from safe parts only — no canary, query text or
   * hash-like run anywhere in what was passed — and carrying the same login and request ids as
   * the safe log line, so the operation can be reconciled.
   */
  const expectAlert = (event: string, authUserId: string, secrets: string[]) => {
    const capture = vi.mocked(Sentry.captureException);
    expect(capture).toHaveBeenCalledTimes(1);
    const [alert, hint] = capture.mock.calls[0]! as unknown as [
      Error,
      { tags?: Record<string, string>; extra?: Record<string, unknown> },
    ];
    expect(alert.name).toBe('AuthFailureAlert');
    expect(alert.message.startsWith(`${event} `)).toBe(true);
    expect((alert as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(hint.tags?.auth_event).toBe(event);
    expect(hint.extra?.authUserId).toBe(authUserId);
    const requestId = String(hint.extra?.requestId);
    expect(requestId).toMatch(UUID);
    const payload = deep([alert, hint]);
    for (const s of secrets) expectAbsent(payload, s, 'the Sentry alert');
    expect(payload).not.toMatch(/Failed query|params:|auth_sessions|update_credential_password/);
    // No hash- or token-like run in the alert's data (UUIDs have dashes). The stack is left out of
    // this one check only: its frames are code locations, and pnpm store paths carry hashes.
    expect(deep([alert.message, hint])).not.toMatch(/[0-9a-f]{32,}/i);
    const line = sink.find((l) => l.includes(`[auth] ${event}`));
    expect(line, `a safe [auth] ${event} line`).toBeDefined();
    expect(line).toContain(authUserId);
    expect(line).toContain(requestId);
  };

  // ── the legitimate path ─────────────────────────────────────────────────────────────
  it('a successful change keeps the current session, ends every other one, rotates the credential and audits it', async () => {
    const a = await account('cplok');
    const others = (await sessionIds(a.authUserId)).filter((id) => id !== a.current);
    expect(others.length).toBe(2);
    const hashBefore = await storedHash(a.authUserId);
    const { result, thrown } = await act(fx.PASSWORD, NEW_PASSWORD);
    expect(thrown).toBeNull();
    expect(result).toEqual({ ok: true });
    expect(await sessionIds(a.authUserId)).toEqual([a.current]);
    expect((await storedHash(a.authUserId)) === hashBefore).toBe(false);
    expect(await auditCount(a.authUserId)).toBe(1);
    expect(await signsIn(a.email, NEW_PASSWORD)).toBe(true);
    expect(await signsIn(a.email, fx.PASSWORD)).toBe(false);
    // No failure was logged or alerted (the old password's refused sign-in above logs its usual
    // warning).
    expect(sink.filter((l) => l.includes('[auth] auth.password_change'))).toEqual([]);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // ── the session deletion fails ──────────────────────────────────────────────────────
  for (const mode of ['missing-table', 'connection', 'nested'] as const) {
    it(`${mode}: a failed session deletion is a fixed answer — nothing changed, nothing leaked`, async () => {
      const a = await account(`cpld${mode.slice(0, 3)}`);
      const sessionsBefore = await sessionIds(a.authUserId);
      const hashBefore = await storedHash(a.authUserId);
      fault.canary = a.canary;
      fault.pattern = /delete from auth\.auth_sessions/;
      fault.mode = mode;
      const { result, thrown } = await act(fx.PASSWORD, NEW_PASSWORD);
      fault.mode = 'none';

      // The action answers; it does not throw (a thrown error is what Next.js would log).
      expect(thrown === null, 'the action threw').toBe(true);
      expect(result).toEqual({
        ok: false,
        error: 'Your password could not be changed right now. Please try again.',
      });
      expectAbsent(JSON.stringify(result), a.canary, 'the action result');
      // One transaction: the credential update rolled back with the failed deletion.
      expect((await storedHash(a.authUserId)) === hashBefore, 'password unchanged').toBe(true);
      expect(await sessionIds(a.authUserId)).toEqual(sessionsBefore);
      expect(await auditCount(a.authUserId)).toBe(0);
      expect(await signsIn(a.email, fx.PASSWORD)).toBe(true);
      // Nothing leaked, and the diagnosis survives.
      const all = sink.join('\n');
      expectAbsent(all, a.canary, 'the captured logs');
      expect(all).not.toMatch(/params:\s*[^\s[]/);
      const line = sink.find((l) => l.includes('[auth] auth.password_change.update_failed'));
      expect(line, 'a safe [auth] line').toBeDefined();
      if (mode === 'missing-table') expect(line).toContain('42P01');
      if (mode === 'nested') expect(line).toContain('08006');
      // Not swallowed: one sanitized alert, correlated to the login and request.
      expectAlert('auth.password_change.update_failed', a.authUserId, [a.canary]);
    });
  }

  it('the library itself throws a fixed ChangePasswordError: no token in its message, stack or causes', async () => {
    const a = await account('cpllib');
    const ctx = await resolveAuthContext(request.headers);
    expect(ctx).not.toBeNull();
    fault.canary = a.canary;
    fault.pattern = /delete from auth\.auth_sessions/;
    fault.mode = 'missing-table';
    const e = await changePassword({
      ctx: ctx!,
      authUserId: a.authUserId,
      currentSessionToken: a.canary,
      currentPassword: fx.PASSWORD,
      newPassword: NEW_PASSWORD,
      meta: requestMetadata(request.headers, crypto.randomUUID()),
    }).then(
      () => null,
      (err: unknown) => err,
    );
    fault.mode = 'none';
    expect(e).toBeInstanceOf(ChangePasswordError);
    expect((e as InstanceType<typeof ChangePasswordError>).code).toBe('UNAVAILABLE');
    expect((e as Error & { cause?: unknown }).cause).toBeUndefined();
    expectAbsent(deep(e), a.canary, 'the thrown error');
    expect(deep(e)).not.toMatch(/Failed query|params:/);
  });

  // ── the credential update fails ─────────────────────────────────────────────────────
  it('a failed credential update is the same fixed answer, and its parameters (the new hash) are not logged', async () => {
    const a = await account('cplupd');
    const sessionsBefore = await sessionIds(a.authUserId);
    const hashBefore = await storedHash(a.authUserId);
    fault.canary = a.canary;
    fault.pattern = /update_credential_password/;
    fault.mode = 'nested';
    const { result, thrown } = await act(fx.PASSWORD, NEW_PASSWORD);
    fault.mode = 'none';
    expect(thrown === null, 'the action threw').toBe(true);
    expect(result).toEqual({
      ok: false,
      error: 'Your password could not be changed right now. Please try again.',
    });
    expect((await storedHash(a.authUserId)) === hashBefore).toBe(true);
    expect(await sessionIds(a.authUserId)).toEqual(sessionsBefore);
    const all = sink.join('\n');
    expectAbsent(all, a.canary, 'the captured logs');
    expectAbsent(all, NEW_PASSWORD, 'the captured logs (new password)');
    expect(all).not.toMatch(/params:\s*[^\s[]/); // the bound new hash is never printed
    expectAlert('auth.password_change.update_failed', a.authUserId, [a.canary, NEW_PASSWORD]);
  });

  // ── the audit write fails after the change committed ────────────────────────────────
  it('if the audit write fails after the change committed, the answer says so truthfully and leaks nothing', async () => {
    const a = await account('cplaud');
    const hashBefore = await storedHash(a.authUserId);
    auditFault.canary = newCanary();
    auditFault.fail = true;
    const { result, thrown } = await act(fx.PASSWORD, NEW_PASSWORD);
    auditFault.fail = false;
    expect(thrown === null, 'the action threw').toBe(true);
    expect(result).toEqual({
      ok: false,
      error:
        'Your password was changed and your other sessions were signed out, but the change could not be recorded. Please tell your administrator.',
    });
    // The change itself stands — the message above says exactly that.
    expect((await storedHash(a.authUserId)) === hashBefore).toBe(false);
    expect(await sessionIds(a.authUserId)).toEqual([a.current]);
    const all = sink.join('\n');
    expectAbsent(all, auditFault.canary, 'the captured logs');
    expectAbsent(all, a.canary, 'the captured logs (session token)');
    // A credential change with no audit record is alerted, with who and which request.
    expectAlert('auth.password_change.audit_failed', a.authUserId, [
      auditFault.canary,
      a.canary,
      NEW_PASSWORD,
    ]);
  });

  it('correlation context accepts identifiers only: a token passed as context is dropped, not logged', async () => {
    const { logAuthFailure } = await import('@/lib/auth/safe-log');
    const canary = newCanary();
    const id = crypto.randomUUID();
    logAuthFailure('auth.test.context', new Error('x'), { authUserId: canary, requestId: id });
    const line = sink.find((l) => l.includes('[auth] auth.test.context'));
    expect(line).toBeDefined();
    expectAbsent(line!, canary, 'the log line');
    expect(line).toContain(id);
  });

  // ── alert volume is bounded ─────────────────────────────────────────────────────────
  it('repeated failures are bounded: ALERT_LIMIT alerts per window, every failure still logged; the window reopens and reports what it suppressed', async () => {
    const a = await account('cplthr');
    // An outage of the rate-limit query: every attempt fails the same way, and the per-login
    // limiter (itself that query) cannot slow the attempts down.
    fault.canary = a.canary;
    fault.pattern = /check_rate_limit/;
    fault.mode = 'connection';
    const attempts = ALERT_LIMIT + 3;
    const UNAVAILABLE = {
      ok: false,
      error: 'Your password could not be changed right now. Please try again.',
    };
    for (let i = 0; i < attempts; i += 1) {
      const { result, thrown } = await act(fx.PASSWORD, NEW_PASSWORD);
      expect(thrown === null, 'the action threw').toBe(true);
      expect(result).toEqual(UNAVAILABLE);
    }
    const capture = vi.mocked(Sentry.captureException);
    expect(capture).toHaveBeenCalledTimes(ALERT_LIMIT);
    // Every failure is still logged, each with its own request id: the record to reconcile from.
    const lines = sink.filter((l) => l.includes('[auth] auth.password_change.rate_limit_failed'));
    expect(lines).toHaveLength(attempts);
    for (const l of lines) expect(l).toContain(a.authUserId);
    const requestIds = new Set(lines.map((l) => /"requestId":"([0-9a-f-]{36})"/.exec(l)?.[1]));
    expect(requestIds.size).toBe(attempts);

    // The window reopens (only Date is faked: timers and the database stay real): the next
    // failure is alerted again and says how many were held back.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(Date.now() + ALERT_WINDOW_MS + 1_000));
      const { result } = await act(fx.PASSWORD, NEW_PASSWORD);
      expect(result).toEqual(UNAVAILABLE);
    } finally {
      vi.useRealTimers();
    }
    fault.mode = 'none';
    expect(capture).toHaveBeenCalledTimes(ALERT_LIMIT + 1);
    const [last, lastHint] = capture.mock.calls.at(-1)! as unknown as [
      Error,
      { extra?: Record<string, unknown> },
    ];
    expect(last.name).toBe('AuthFailureAlert');
    expect(lastHint.extra?.suppressed_since_last_alert).toBe(attempts - ALERT_LIMIT);
    // No alert, sent or reported, carries anything sensitive.
    for (const call of capture.mock.calls) {
      const payload = deep(call);
      expectAbsent(payload, a.canary, 'an alert');
      expectAbsent(payload, NEW_PASSWORD, 'an alert (new password)');
      expect(payload).not.toMatch(/Failed query|params:|check_rate_limit/);
    }

    // A successful change afterwards raises nothing.
    capture.mockClear();
    const ok = await act(fx.PASSWORD, NEW_PASSWORD);
    expect(ok.result).toEqual({ ok: true });
    expect(capture).not.toHaveBeenCalled();
  }, 60_000);
});
