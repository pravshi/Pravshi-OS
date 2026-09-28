import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Task 1.14 — setup completion, with the database replaced.
 *
 * tests/db/bootstrap.test.ts proves what the database does. This file proves what the code in
 * front of it refuses to do: ask the database anything about a malformed token, spend a
 * scrypt hash on a dead one, send the token itself anywhere, or let a driver error — whose
 * message embeds the query parameters — reach a log or a response.
 */

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  hash: vi.fn(async () => `${'a'.repeat(32)}:${'b'.repeat(128)}`),
}));

vi.mock('@/env', () => ({ env: { APP_URL: 'https://os.pravshi.com', NODE_ENV: 'test' } }));
vi.mock('@/lib/auth/server', () => ({
  auth: {
    $context: Promise.resolve({
      password: { hash: mocks.hash, config: { minPasswordLength: 12, maxPasswordLength: 128 } },
    }),
  },
}));
vi.mock('@/lib/db/auth-client', () => ({ authDb: { execute: mocks.execute } }));

const { completeBootstrapSetup, BootstrapSetupError } = await import('@/lib/auth/bootstrap-setup');
const { POST } = await import('@/app/api/bootstrap/complete/route');

const TOKEN = 'A'.repeat(20) + '_' + 'b'.repeat(22); // 43 base64url characters
const PASSWORD = 'correct horse battery staple';
const DIGEST = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

const dialect = new PgDialect();
const rendered = () => mocks.execute.mock.calls.map(([query]) => dialect.sqlToQuery(query as SQL));

const dbError = (code: string) =>
  Object.assign(new Error(`Failed query: select ... params: ${DIGEST},secret-hash`), {
    cause: Object.assign(new Error('boom'), { code }),
  });

const liveToken = () => mocks.execute.mockResolvedValueOnce({ rows: [{ valid: true }] });
const deadToken = () => mocks.execute.mockResolvedValueOnce({ rows: [{ valid: false }] });
const linked = () =>
  mocks.execute.mockResolvedValueOnce({
    rows: [{ linked_person_id: 'p', linked_org_id: 'o', linked_auth_user_id: 'u' }],
  });

// The route rate-limits per IP before touching the token logic, so every POST
// that survives body parsing consumes one extra execute call first.
const rateLimitOk = () => mocks.execute.mockResolvedValueOnce({ rows: [{ allowed: true }] });
const rateLimitExceeded = () => mocks.execute.mockResolvedValueOnce({ rows: [{ allowed: false }] });

beforeEach(() => {
  mocks.execute.mockReset();
  mocks.hash.mockClear();
});

describe('completeBootstrapSetup()', () => {
  it('refuses a malformed token without touching the database or the hasher', async () => {
    for (const token of ['', 'short', TOKEN + 'x', TOKEN.replace('_', '+'), ' '.repeat(43)]) {
      expect(await completeBootstrapSetup({ token, password: PASSWORD })).toEqual({
        ok: false,
        reason: 'SETUP_TOKEN_INVALID',
      });
    }
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
  });

  it('refuses a request that is not two strings', async () => {
    expect(await completeBootstrapSetup({ token: 42, password: PASSWORD })).toEqual({
      ok: false,
      reason: 'INVALID_REQUEST',
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('applies the Better Auth password policy before asking the database anything', async () => {
    const short = await completeBootstrapSetup({ token: TOKEN, password: 'x'.repeat(11) });
    expect(short).toEqual({
      ok: false,
      reason: 'PASSWORD_TOO_SHORT',
      minPasswordLength: 12,
      maxPasswordLength: 128,
    });
    const long = await completeBootstrapSetup({ token: TOKEN, password: 'x'.repeat(129) });
    expect(long).toMatchObject({ ok: false, reason: 'PASSWORD_TOO_LONG' });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
  });

  it('spends no scrypt hash on a token the database says is dead', async () => {
    deadToken();
    expect(await completeBootstrapSetup({ token: TOKEN, password: PASSWORD })).toEqual({
      ok: false,
      reason: 'SETUP_TOKEN_INVALID',
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.hash).not.toHaveBeenCalled();
  });

  it('sends the digest and the library hash, and never the token or the password', async () => {
    liveToken();
    linked();
    const result = await completeBootstrapSetup({ token: TOKEN, password: PASSWORD });
    expect(result).toEqual({ ok: true, personId: 'p', orgId: 'o', authUserId: 'u' });
    expect(mocks.hash).toHaveBeenCalledWith(PASSWORD);

    const queries = rendered();
    expect(queries.length).toBe(2);
    expect(queries[0]!.sql).toContain('bootstrap_setup_token_is_valid');
    expect(queries[1]!.sql).toContain('complete_bootstrap_setup');
    for (const q of queries) {
      expect(q.params).toContain(DIGEST);
      expect(JSON.stringify(q)).not.toContain(TOKEN);
      expect(JSON.stringify(q)).not.toContain(PASSWORD);
    }
  });

  it('maps a dead token found under the lock to the same answer as any other dead token', async () => {
    liveToken();
    mocks.execute.mockRejectedValueOnce(dbError('28000'));
    expect(await completeBootstrapSetup({ token: TOKEN, password: PASSWORD })).toEqual({
      ok: false,
      reason: 'SETUP_TOKEN_INVALID',
    });
  });

  it('maps a person who cannot receive a login, or a lost email race, to CANNOT_COMPLETE', async () => {
    for (const code of ['55000', '23505']) {
      liveToken();
      mocks.execute.mockRejectedValueOnce(dbError(code));
      expect(await completeBootstrapSetup({ token: TOKEN, password: PASSWORD })).toEqual({
        ok: false,
        reason: 'SETUP_CANNOT_COMPLETE',
      });
    }
  });

  it('throws only a SQLSTATE for anything else — never the driver error that names the parameters', async () => {
    liveToken();
    mocks.execute.mockRejectedValueOnce(dbError('XX000'));
    const error = await completeBootstrapSetup({ token: TOKEN, password: PASSWORD }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BootstrapSetupError);
    expect((error as InstanceType<typeof BootstrapSetupError>).sqlstate).toBe('XX000');
    expect((error as Error).cause).toBeUndefined();
    expect((error as Error).message).not.toContain(DIGEST);
  });
});

// ── the HTTP route ───────────────────────────────────────────────────────────────

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request('https://os.pravshi.com/api/bootstrap/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

describe('POST /api/bootstrap/complete', () => {
  it('refuses a cross-origin browser request before reading anything', async () => {
    const res = await post({ token: TOKEN, password: PASSWORD }, { origin: 'https://evil.test' });
    expect(res.status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('accepts a same-origin request, and a request carrying no Origin at all', async () => {
    rateLimitOk();
    deadToken();
    expect(
      (await post({ token: TOKEN, password: PASSWORD }, { origin: 'https://os.pravshi.com' }))
        .status,
    ).toBe(400);
    rateLimitOk();
    deadToken();
    expect((await post({ token: TOKEN, password: PASSWORD })).status).toBe(400);
    expect(mocks.execute).toHaveBeenCalledTimes(4);
  });

  it('refuses an oversized, unparseable or unexpected body', async () => {
    expect((await post('x'.repeat(5000))).status).toBe(413);
    expect((await post('{not json')).status).toBe(400);
    expect((await post({ token: TOKEN, password: PASSWORD, email: 'x@y.z' })).status).toBe(400);
    expect((await post({ token: TOKEN })).status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('reports the password policy by name', async () => {
    rateLimitOk();
    const res = await post({ token: TOKEN, password: 'too short' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'PASSWORD_TOO_SHORT',
      minPasswordLength: 12,
      maxPasswordLength: 128,
    });
  });

  it('answers 429 when the IP is over the rate limit, before touching the token', async () => {
    rateLimitExceeded();
    const res = await post({ token: TOKEN, password: PASSWORD });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'RATE_LIMITED' });
    // One query only: the rate-limit check. The token was never consulted.
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const queries = rendered();
    expect(queries.length).toBe(1);
    expect(queries[0]!.sql).toContain('check_rate_limit');
  });

  it('answers 409 when the database refuses to link, and 400 for any dead token', async () => {
    rateLimitOk();
    liveToken();
    mocks.execute.mockRejectedValueOnce(dbError('55000'));
    expect((await post({ token: TOKEN, password: PASSWORD })).status).toBe(409);
    rateLimitOk();
    deadToken();
    const dead = await post({ token: TOKEN, password: PASSWORD });
    expect(dead.status).toBe(400);
    expect(await dead.json()).toEqual({ error: 'SETUP_TOKEN_INVALID' });
  });

  it('logs a failure by SQLSTATE alone and returns nothing about it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      rateLimitOk();
      liveToken();
      mocks.execute.mockRejectedValueOnce(dbError('XX000'));
      const res = await post({ token: TOKEN, password: PASSWORD });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'INTERNAL' });
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).toContain('XX000');
      for (const secret of [TOKEN, PASSWORD, DIGEST]) expect(logged).not.toContain(secret);
    } finally {
      log.mockRestore();
    }
  });

  it('completes, and marks the response uncacheable', async () => {
    rateLimitOk();
    liveToken();
    linked();
    const res = await post({ token: TOKEN, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ status: 'COMPLETED' });
    expect(body).not.toContain(TOKEN);
  });
});
