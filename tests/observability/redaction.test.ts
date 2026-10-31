/**
 * Diagnostics redaction (src/lib/observability/redact.ts) and its two consumers: the
 * authentication plane's logger (src/lib/auth/safe-log.ts) and the Sentry configuration of all
 * three runtimes. No database, no network.
 *
 * The Sentry cases run the REAL SDK pipeline — event processing, breadcrumbs from the console
 * integration, normalisation, envelope serialisation — with the options the app's own config
 * files pass to Sentry.init (captured by stubbing init alone), and an in-memory transport in
 * place of the network. Nothing is sent anywhere: the DSN points at the reserved `.invalid` TLD
 * and the transport only records the envelope bytes. What this does NOT prove: the browser SDK's
 * own integrations (it runs the browser config's hooks through the Node pipeline) and whatever a
 * deployed Sentry project adds server-side — those need checking against the real deployment.
 *
 * Canaries are 20 characters, below the 32-character opaque-token backstop, so every case proves
 * a structural rule rather than the pattern match. Failures name the place, never the canary.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { DrizzleQueryError } from 'drizzle-orm';

import {
  errorSummary,
  redactText,
  redactValue,
  scrubBreadcrumb,
  scrubEvent,
} from '@/lib/observability/redact';

vi.mock('@sentry/nextjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/nextjs')>()),
  init: vi.fn(),
  // Browser-only export, read by instrumentation-client.ts; the Node build has none.
  captureRouterTransitionStart: vi.fn(),
}));

const canaryOf = () => `cnry${randomBytes(8).toString('hex')}`;
const expectAbsent = (haystack: string, canary: string, where: string) =>
  expect(haystack.includes(canary), `the canary appears in ${where}`).toBe(false);

/** A failed session lookup exactly as drizzle builds it, with a driver error as its cause. */
function failedLookup(canary: string) {
  const driver = Object.assign(new Error(`duplicate key: Key (token)=(${canary}) already exists`), {
    name: 'error',
    code: '23505',
    detail: `Key (token)=(${canary})`,
    cause: Object.assign(new Error(`socket said ${canary}`), { code: 'ECONNRESET' }),
  });
  return new DrizzleQueryError(
    'select "id", "token" from "auth"."auth_sessions" where "auth"."auth_sessions"."token" = $1',
    [canary],
    driver,
  );
}

describe('redaction primitives', () => {
  it('a DrizzleQueryError is summarised by class and codes only — no message, params, detail or cause text', () => {
    const c = canaryOf();
    const err = failedLookup(c);
    expect(err.message).toContain(c); // the defect this guards: the message carries the params
    const s = errorSummary(err);
    expectAbsent(JSON.stringify(s), c, 'the summary');
    expect(s).toEqual({
      error: 'DrizzleQueryError',
      cause: { error: 'error', code: '23505', cause: { error: 'Error', code: 'ECONNRESET' } },
    });
  });

  it('redactText removes every credential shape it knows, and keeps what diagnoses', () => {
    const c = canaryOf();
    const cases = [
      failedLookup(c).message,
      `https://app.example/reset-password?token=${c}&x=1`,
      `https://app.example/invite#token=${c}`,
      `/setup#token=${c}`,
      `/callback?code=${c}&state=s`,
      `Authorization: Bearer ${c}`,
      `cookie: better-auth.session_token=${c}.sig%3D; other=1`,
      `__Secure-better-auth.session_token=${c}`,
      `postgresql://app_auth:${c}@host-pooler.example/db`,
      `Key (token)=(${c}) already exists`,
    ];
    for (const text of cases)
      expectAbsent(redactText(text), c, `redactText(${text.slice(0, 30)}…)`);
    const id = '123e4567-e89b-42d3-a456-426614174000';
    expect(redactText(`request ${id} failed with 42501`)).toBe(`request ${id} failed with 42501`);
    expect(redactText(redactText(cases[0]!))).toBe(redactText(cases[0]!)); // idempotent
  });

  it('the opaque-token backstop catches a 32-character token in a shape no rule names', () => {
    const token = randomBytes(16).toString('hex'); // 32 hex: a session token's length
    expectAbsent(redactText(`something odd ${token} here`), token, 'redacted text');
  });

  it('redactValue replaces credential-named keys at any depth and summarises errors inside', () => {
    const c = canaryOf();
    const v = redactValue({
      ok: 'keep',
      code: '42501',
      nested: {
        session_token: c,
        deeper: { password: c, list: [{ authorization: `Bearer ${c}` }] },
      },
      params: [c],
      err: failedLookup(c),
      url: `/reset-password?token=${c}`,
    });
    expectAbsent(JSON.stringify(v), c, 'the redacted value');
    expect(v).toMatchObject({ ok: 'keep', code: '42501', err: { error: 'DrizzleQueryError' } });
  });
});

describe('the authentication plane logger (Better Auth `logger.log`)', () => {
  it('writes errors as summaries and redacted messages through the console — never the token', async () => {
    const { authLog, authLoggerOptions, logAuthFailure } = await import('@/lib/auth/safe-log');
    expect(authLoggerOptions.log).toBe(authLog);
    const lines: string[] = [];
    const spies = (['error', 'warn', 'info', 'debug', 'log'] as const).map((m) =>
      vi
        .spyOn(console, m)
        .mockImplementation((...a: unknown[]) => void lines.push(JSON.stringify(a))),
    );
    try {
      const c = canaryOf();
      // Exactly the calls Better Auth makes on a failed session lookup and in its router.
      authLog('error', 'INTERNAL_SERVER_ERROR', failedLookup(c));
      authLog('error', failedLookup(c).message);
      authLog('warn', `Invalid url: https://app.example/reset-password?token=${c}`, { token: c });
      logAuthFailure('auth.route.unhandled', failedLookup(c));
      const all = lines.join('\n');
      expectAbsent(all, c, 'the auth logger output');
      expect(all).toContain('[auth] INTERNAL_SERVER_ERROR');
      expect(all).toContain('23505');
      expect(lines).toHaveLength(4);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it('is the logger Better Auth is configured with', async () => {
    const src = (await import('node:fs')).readFileSync('src/lib/auth/server.ts', 'utf8');
    expect(src).toMatch(/logger:\s*authLoggerOptions/);
    expect(src).toMatch(/onAPIError:\s*\{\s*throw:\s*true\s*\}/);
  });
});

describe('Sentry: the real SDK pipeline with each runtime’s own options', async () => {
  const Sentry = await vi.importActual<typeof import('@sentry/nextjs')>('@sentry/nextjs');
  type Options = Parameters<typeof Sentry.init>[0] & Record<string, unknown>;

  /** The options a config file passes to Sentry.init (a fresh module graph each time). */
  const optionsOf = async (file: string): Promise<Options> => {
    vi.resetModules();
    const mocked = await import('@sentry/nextjs');
    const init = vi.mocked(mocked.init);
    init.mockClear();
    await import(/* @vite-ignore */ file);
    expect(init).toHaveBeenCalledTimes(1);
    return init.mock.calls[0]![0] as Options;
  };

  const runtimes: [string, string][] = [
    ['server', '../../apps/web/sentry.server.config'],
    ['edge', '../../apps/web/sentry.edge.config'],
    ['browser', '../../apps/web/instrumentation-client'],
  ];

  const consoleSpies: { mockRestore(): void }[] = [];
  beforeAll(() => {
    // Silence the console BEFORE the console integration wraps it: the wrapper still records
    // breadcrumbs, and nothing a case logs reaches the test output.
    for (const m of ['error', 'warn', 'log', 'info'] as const)
      consoleSpies.push(vi.spyOn(console, m).mockImplementation(() => undefined));
  });
  afterAll(() => {
    for (const s of consoleSpies) s.mockRestore();
  });

  for (const [runtime, file] of runtimes) {
    it(`${runtime}: exceptions, messages, request data, console and navigation breadcrumbs and transactions leave without the token`, async () => {
      const options = await optionsOf(file);
      expect(options.sendDefaultPii).toBe(false);
      for (const hook of ['beforeSend', 'beforeSendTransaction', 'beforeBreadcrumb'])
        expect(typeof options[hook], `${runtime} ${hook}`).toBe('function');

      const envelopes: string[] = [];
      const client = new Sentry.NodeClient({
        ...(options as object),
        dsn: 'https://public@sentry.invalid/1',
        transport: (o) =>
          Sentry.createTransport(o, async (req) => {
            envelopes.push(
              typeof req.body === 'string' ? req.body : new TextDecoder().decode(req.body),
            );
            return { statusCode: 200 };
          }),
        stackParser: Sentry.defaultStackParser,
        integrations: [Sentry.consoleIntegration()],
      } as ConstructorParameters<typeof Sentry.NodeClient>[0]);
      Sentry.setCurrentClient(client);
      client.init();
      Sentry.getCurrentScope().clear();
      Sentry.getIsolationScope().clear();

      const c = canaryOf();
      const traceId = 'a1'.repeat(16);
      console.error('[auth] lookup failed', failedLookup(c)); // → console breadcrumb
      Sentry.addBreadcrumb({
        category: 'navigation',
        data: { from: `/reset-password?token=${c}`, to: `/invite#token=${c}` },
      });
      Sentry.addBreadcrumb({
        category: 'fetch',
        message: `Authorization: Bearer ${c}`,
        data: { url: `https://api.example/x?token=${c}`, cookie: c },
      });
      Sentry.setExtra('params', [c]);
      Sentry.setContext('auth', { session_token: c, note: `better-auth.session_token=${c}` });
      Sentry.setTag('page', `/setup#token=${c}`);
      Sentry.captureException(failedLookup(c));
      Sentry.captureMessage(`reset failed for /reset-password?token=${c}`);
      Sentry.captureEvent({
        message: 'request-bearing event',
        request: {
          url: `https://app.example/reset-password?token=${c}`,
          query_string: `token=${c}&next=%2F`,
          headers: { authorization: `Bearer ${c}`, cookie: `a=${c}`, 'user-agent': 'ua' },
          cookies: { 'better-auth.session_token': c },
          data: { password: c },
        },
      });
      const now = Date.now() / 1000;
      Sentry.captureEvent({
        type: 'transaction',
        transaction: `GET /reset-password?token=${c}`,
        start_timestamp: now - 1,
        timestamp: now,
        contexts: {
          trace: {
            trace_id: traceId,
            span_id: 'b2'.repeat(8),
            data: { 'url.full': `https://app.example/reset-password?token=${c}` },
          },
        },
        spans: [
          {
            span_id: 'c3'.repeat(8),
            trace_id: traceId,
            start_timestamp: now - 1,
            timestamp: now,
            description: `GET https://api.example/x?token=${c}`,
            data: { 'url.full': `https://api.example/x?token=${c}` },
          },
        ],
        request: { url: `https://app.example/reset-password?token=${c}` },
      } as Parameters<typeof Sentry.captureEvent>[0]);
      await client.flush(2000);

      const all = envelopes.join('\n');
      expect(envelopes.length, `${runtime}: envelopes recorded`).toBeGreaterThanOrEqual(4);
      expectAbsent(all, c, `${runtime} Sentry envelopes`);
      // Not vacuous: the events are there, with their diagnosis.
      expect(all).toContain('params: [redacted]'); // the exception value, redacted
      expect(all).toContain('"category":"console"'); // the console breadcrumb was kept
      // The error class survives in the breadcrumb (its cause codes sit below the SDK's own
      // normalisation depth for breadcrumb data, which is not this file's to change).
      expect(all).toContain('DrizzleQueryError');
      expect(all).toContain(traceId); // trace linking survives
      expect(all).not.toMatch(/"headers":\{[^}]*"(authorization|cookie)"/i); // credential headers gone
      await client.close();
    });
  }

  it('scrubEvent and scrubBreadcrumb are the hooks — the same functions on every runtime', async () => {
    const c = canaryOf();
    for (const [runtime, file] of runtimes) {
      const o = await optionsOf(file);
      const ev = (o.beforeSend as (e: object, h: object) => object)(
        { message: `token=${c}`, exception: { values: [{ value: failedLookup(c).message }] } },
        {},
      );
      expectAbsent(JSON.stringify(ev), c, `${runtime} beforeSend`);
      const crumb = (o.beforeBreadcrumb as (b: object, h?: object) => object)(
        { message: `Bearer ${c}`, data: { arguments: [failedLookup(c)] } },
        {},
      );
      expectAbsent(JSON.stringify(crumb), c, `${runtime} beforeBreadcrumb`);
    }
    // And they are pure redaction: scrubbing twice changes nothing more.
    const once = scrubEvent({ message: `x token=${c}` } as never);
    expect(scrubEvent(structuredClone(once))).toEqual(once);
    expect(scrubBreadcrumb({ message: 'plain' })).toEqual({ message: 'plain' });
  });
});
