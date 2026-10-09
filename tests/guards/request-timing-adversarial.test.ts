import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@/lib/authz/require-permission', () => ({
  requirePermission: vi.fn(async () => ({
    requestId: 'timing-adv-test',
    ctx: { personId: 'person-canary', orgId: 'org-canary', aal: 'aal1' },
  })),
}));

vi.mock('@/env', () => ({
  env: { APP_URL: 'https://app.pravshi.example' },
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
}));

import { withPermission } from '@/lib/authz/http';
import { invalidRequestResponse } from '@/lib/crm/http';

/**
 * Request timing (Phase 12, F-12-12) — adversarial cases beyond Wave E2's
 * request-timing.test.ts (which pins the four exit paths and field shape):
 *
 *  1. A handler that throws a NON-Error value — a string, and a plain
 *     object carrying a canary secret. The wrapper's catch treats both as
 *     internal errors; the timing line must still be emitted exactly once,
 *     with exactly the four fields, and must not smuggle the thrown value
 *     out (the wrapper logs `typeof error` for non-Errors, never the value).
 *  2. A handler returning a STREAMED response: the wrapper reads only
 *     `.status` and never consumes the body, so the stream must reach the
 *     caller byte-intact and the line must still fire exactly once.
 *  3. No double emission through nested wrappers: module http helpers
 *     (src/lib/{crm,work,workflows,search,integrations}/http.ts and the
 *     analytics route helpers) build Responses INSIDE handlers — a CRM
 *     route's ZodError → 400 path composed exactly that way must produce
 *     exactly ONE timing line, and (statically) none of the helper files
 *     contains an emission of its own: withPermission's finally is the
 *     single emission point the audit §4.5 contracts.
 */

const call = (request: Request, handler: (req: Request) => Promise<Response>) =>
  withPermission({ permission: 'people.view' }, handler)(request, {
    params: Promise.resolve({}),
  });

const get = () => new Request('https://app.pravshi.example/api/things', { method: 'GET' });

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

const expectExactlyOneWellFormedLine = (status: number): TimingFields => {
  const lines = timingLines();
  expect(lines).toHaveLength(1);
  const fields = lines[0]!;
  expect(Object.keys(fields).sort()).toEqual(['durationMs', 'requestId', 'route', 'status']);
  expect(fields.status).toBe(status);
  expect(Number.isInteger(fields.durationMs)).toBe(true);
  expect(fields.durationMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(fields)).not.toContain('canary');
  return fields;
};

/** Throw an arbitrary non-Error value, as a misbehaving handler can. */
const throwValue = (value: unknown): never => {
  throw value;
};

describe('withPermission request timing — adversarial (Wave J)', () => {
  it('handler throws a string: one line, 500 envelope, the thrown value never leaks', async () => {
    const res = await call(get(), async () => throwValue('string-boom-canary'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('INTERNAL');

    const fields = expectExactlyOneWellFormedLine(500);
    expect(fields.requestId).toBe(body.error.requestId);
    expect(JSON.stringify(fields)).not.toContain('string-boom-canary');
    expect(JSON.stringify(body)).not.toContain('string-boom-canary');
  });

  it('handler throws a plain object: one line, 500 envelope, the object never leaks', async () => {
    const res = await call(get(), async () =>
      throwValue({ detail: 'object-boom-canary', nested: { secret: 'canary-secret' } }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('INTERNAL');

    const fields = expectExactlyOneWellFormedLine(500);
    expect(fields.requestId).toBe(body.error.requestId);
    expect(JSON.stringify(fields)).not.toContain('object-boom-canary');
    expect(JSON.stringify(body)).not.toContain('canary-secret');
  });

  it('handler returns a streamed response: body intact, one line with the stream status', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('chunk-1;'));
        controller.enqueue(enc.encode('chunk-2'));
        controller.close();
      },
    });
    const res = await call(
      get(),
      async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    expect(res.status).toBe(200);
    // The wrapper must not consume or corrupt the stream.
    expect(await res.text()).toBe('chunk-1;chunk-2');

    const fields = expectExactlyOneWellFormedLine(200);
    expect(fields.route).toBe('GET /api/things');
  });

  it('a response built by a module http helper inside the handler emits exactly one line', async () => {
    // The CRM route shape: validate inside the handler, let the module
    // helper (src/lib/crm/http.ts) build the 400, return it. The helper is
    // the REAL one, and the error is a REAL ZodError from a failed parse.
    const res = await call(get(), async () => {
      try {
        z.object({ name: z.string() }).parse({ name: 42 });
      } catch (error) {
        const invalid = invalidRequestResponse(error);
        if (invalid) return invalid;
        throw error;
      }
      throw new Error('unreachable: the parse must fail');
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('INVALID_REQUEST');

    expectExactlyOneWellFormedLine(400);
  });

  it('statically: no module http helper emits a timing line of its own', () => {
    // withPermission's finally is the ONLY emission point. If a helper
    // ever grows its own logging of this line, routes using it would
    // double-emit — this guard fails first.
    for (const path of [
      'src/lib/crm/http.ts',
      'src/lib/work/http.ts',
      'src/lib/workflows/http.ts',
      'src/lib/search/http.ts',
      'src/lib/integrations/http.ts',
      'src/app/api/analytics/http.ts',
    ]) {
      const src = readFileSync(path, 'utf8');
      expect(src, path).not.toContain('emitRequestTiming');
      expect(src, path).not.toContain('[authz] request');
      expect(src, path).not.toContain('console.log');
    }
  });
});
