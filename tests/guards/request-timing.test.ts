import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/authz/require-permission', () => ({
  requirePermission: vi.fn(async () => ({
    requestId: 'timing-test',
    ctx: { personId: 'person-canary', orgId: 'org-canary', aal: 'aal1' },
  })),
}));

vi.mock('@/env', () => ({
  env: { APP_URL: 'https://app.pravshi.example' },
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
}));

import { AuthorizationError } from '@/lib/authz/errors';
import { withPermission } from '@/lib/authz/http';
import { requirePermission } from '@/lib/authz/require-permission';

/**
 * Request timing visibility (Phase 12, F-12-12; audit section 4.5).
 *
 * withPermission() emits exactly one structured timing line per wrapped
 * request — route, status, durationMs, requestId — so platform logs can
 * answer latency questions without a metrics stack. These cases pin the
 * contract behaviourally, with authorization stubbed out (no database):
 *
 *   - the line is emitted on every exit path: handler success, an
 *     authorization refusal, the origin refusal that precedes authorization,
 *     and the internal-error envelope;
 *   - the field set is exactly the four contracted fields — the request id
 *     is the only identifier, and it is the same id the envelope carries and
 *     requirePermission received, so a line correlates with the audit layer;
 *   - the route is method + path only: the query string (which can hold
 *     search terms) never reaches the line, and no person/org id from the
 *     authorization context does either;
 *   - the wrapper's behaviour is unchanged: statuses and bodies are exactly
 *     what the same requests produced before the emission existed.
 */

const okHandler = vi.fn(async () => Response.json({ ok: true }, { status: 201 }));

const call = (request: Request, handler = okHandler) =>
  withPermission({ permission: 'people.view' }, handler)(request, {
    params: Promise.resolve({}),
  });

const get = (url = 'https://app.pravshi.example/api/things') => new Request(url, { method: 'GET' });

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

interface TimingFields {
  route: string;
  status: number;
  durationMs: number;
  requestId: string;
}

const timingLines = (): TimingFields[] =>
  logSpy.mock.calls
    .filter((args: unknown[]) => args[0] === '[authz] request')
    .map((args: unknown[]) => args[1] as TimingFields);

const expectWellFormedLine = (fields: TimingFields) => {
  expect(Object.keys(fields).sort()).toEqual(['durationMs', 'requestId', 'route', 'status']);
  expect(Number.isInteger(fields.durationMs)).toBe(true);
  expect(fields.durationMs).toBeGreaterThanOrEqual(0);
  expect(fields.requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  // No tenant data beyond the request id: the stubbed authorization context
  // carries canary person/org ids that must never reach the line.
  expect(JSON.stringify(fields)).not.toContain('canary');
};

describe('withPermission request timing (F-12-12)', () => {
  it('emits one timing line on the success path, and the response is untouched', async () => {
    const res = await call(get());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });

    const lines = timingLines();
    expect(lines).toHaveLength(1);
    expectWellFormedLine(lines[0]!);
    expect(lines[0]!.route).toBe('GET /api/things');
    expect(lines[0]!.status).toBe(201);
    // The line's id is the id authorization ran under.
    const authCall = vi.mocked(requirePermission).mock.calls[0];
    expect(lines[0]!.requestId).toBe(authCall?.[1].requestId);
  });

  it('never logs the query string', async () => {
    const res = await call(get('https://app.pravshi.example/api/things?q=hush-hush-term'));
    expect(res.status).toBe(201);

    const lines = timingLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.route).toBe('GET /api/things');
    expect(JSON.stringify(lines[0])).not.toContain('hush-hush-term');
  });

  it('emits one timing line on an authorization refusal', async () => {
    // Mirrors production requirePermission: refusal errors carry the
    // requestId the wrapper handed it.
    vi.mocked(requirePermission).mockImplementationOnce(async (_headers, spec) => {
      throw new AuthorizationError('NOT_FOUND', {
        requestId: spec.requestId ?? 'missing',
        reason: 'TARGET_NOT_VISIBLE',
      });
    });

    const res = await call(get());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(okHandler).not.toHaveBeenCalled();

    const lines = timingLines();
    expect(lines).toHaveLength(1);
    expectWellFormedLine(lines[0]!);
    expect(lines[0]!.status).toBe(404);
    expect(lines[0]!.requestId).toBe(body.error.requestId);
  });

  it('emits one timing line on the origin refusal, before authorization runs', async () => {
    const res = await call(
      new Request('https://app.pravshi.example/api/things', {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('FORBIDDEN');
    expect(requirePermission).not.toHaveBeenCalled();
    expect(okHandler).not.toHaveBeenCalled();

    const lines = timingLines();
    expect(lines).toHaveLength(1);
    expectWellFormedLine(lines[0]!);
    expect(lines[0]!.route).toBe('POST /api/things');
    expect(lines[0]!.status).toBe(403);
    expect(lines[0]!.requestId).toBe(body.error.requestId);
  });

  it('emits one timing line on the internal-error path, leaking no error detail', async () => {
    const failing = vi.fn(async () => {
      throw new Error('boom-sensitive-detail');
    });
    const res = await call(get(), failing);
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).toBe('Something went wrong.');

    const lines = timingLines();
    expect(lines).toHaveLength(1);
    expectWellFormedLine(lines[0]!);
    expect(lines[0]!.status).toBe(500);
    expect(lines[0]!.requestId).toBe(body.error.requestId);
    expect(JSON.stringify(lines[0])).not.toContain('boom-sensitive-detail');
  });
});
