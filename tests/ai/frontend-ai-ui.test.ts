/**
 * Frontend AI UI tests (Phase 9, Workstream G).
 *
 * Covers the UI↔API contract surface owned by G: request-body construction
 * for POST /api/ai/assist and the §5.4 envelope → AiApiError mapping the
 * AiSummaryPanel states are driven by (503 not-configured, 429 limited
 * with the retry hint preserved, 502 provider-failed, 400/401/403/404).
 * Pure unit level — fetch is stubbed; no database, no Neon.
 *
 * NOTE (ownership): tests/ai/integration.test.ts carries the DB-backed
 * end-to-end coverage; J/K's security suite is separate. This file is G's
 * workstream-scoped coverage of its own frontend contract, following the
 * tests/search/frontend-search-ui.test.ts precedent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiApiError,
  buildAssistRequestBody,
  requestAiSummary,
  type AiAssistResponse,
} from '@/components/ai/ai-client';

const COMPANY_ID = '9b7e1c2a-5f6d-4c8a-b3d2-1e0f9a8b7c6d';

const SUCCESS_BODY: AiAssistResponse = {
  requestId: 'req-1',
  capability: 'company_summary',
  status: 'ok',
  summary: {
    headline: 'Acme Corp',
    facts: ['Industry: Fintech'],
    suggestions: ['Review this summary against the source records before acting on it.'],
    missingInformation: [],
  },
  sources: [{ entityType: 'company', entityId: COMPANY_ID, label: 'Acme Corp' }],
  usage: { provider: 'mock', model: 'mock-deterministic', totalTokens: 42 },
};

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('buildAssistRequestBody', () => {
  it('sends capability + target for a record summary', () => {
    expect(
      buildAssistRequestBody({
        capability: 'company_summary',
        target: { entityType: 'company', entityId: COMPANY_ID },
      }),
    ).toEqual({
      capability: 'company_summary',
      target: { entityType: 'company', entityId: COMPANY_ID },
    });
  });

  it('omits target and question entirely when absent (no null keys on the wire)', () => {
    const body = buildAssistRequestBody({ capability: 'general_assistance', question: 'Hi?' });
    expect(body).toEqual({ capability: 'general_assistance', question: 'Hi?' });
    expect('target' in body).toBe(false);
  });
});

describe('requestAiSummary', () => {
  it('POSTs the built body to /api/ai/assist and returns the §5.3 payload', async () => {
    const fetchMock = stubFetch(200, SUCCESS_BODY);
    const result = await requestAiSummary({
      capability: 'company_summary',
      target: { entityType: 'company', entityId: COMPANY_ID },
    });
    expect(result).toEqual(SUCCESS_BODY);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('/api/ai/assist');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      capability: 'company_summary',
      target: { entityType: 'company', entityId: COMPANY_ID },
    });
  });

  it('maps 503 to AI_NOT_CONFIGURED (panel renders the calm no-button state)', async () => {
    stubFetch(503, {
      error: { code: 'AI_NOT_CONFIGURED', message: "AI isn't configured for this workspace yet." },
    });
    await expect(
      requestAiSummary({
        capability: 'deal_summary',
        target: { entityType: 'deal', entityId: COMPANY_ID },
      }),
    ).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED', status: 503 });
  });

  it('maps 429 to AI_LIMITED and preserves retryAfterSeconds for the countdown', async () => {
    stubFetch(429, {
      error: { code: 'AI_LIMITED', message: 'AI usage limit reached.', retryAfterSeconds: 60 },
    });
    const error = await requestAiSummary({
      capability: 'task_summary',
      target: { entityType: 'task', entityId: COMPANY_ID },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiApiError);
    expect(error).toMatchObject({ code: 'AI_LIMITED', status: 429, retryAfterSeconds: 60 });
  });

  it('maps 429 without a hint to retryAfterSeconds null', async () => {
    stubFetch(429, { error: { code: 'AI_LIMITED', message: 'AI usage limit reached.' } });
    const error = await requestAiSummary({ capability: 'project_summary' }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'AI_LIMITED', retryAfterSeconds: null });
  });

  it('maps 502 to AI_PROVIDER_FAILED with a safe message', async () => {
    stubFetch(502, { error: { code: 'AI_PROVIDER_FAILED', message: 'Provider failed.' } });
    await expect(requestAiSummary({ capability: 'contact_summary' })).rejects.toMatchObject({
      code: 'AI_PROVIDER_FAILED',
      status: 502,
    });
  });

  it('maps 400/401/403/404 to their panel-driving codes', async () => {
    stubFetch(400, { error: { code: 'INVALID_REQUEST', message: 'capability: invalid' } });
    await expect(requestAiSummary({ capability: 'company_summary' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      status: 400,
      message: 'capability: invalid',
    });

    stubFetch(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } });
    await expect(requestAiSummary({ capability: 'company_summary' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });

    stubFetch(403, { error: { code: 'FORBIDDEN', message: 'You do not have access.' } });
    await expect(requestAiSummary({ capability: 'company_summary' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });

    stubFetch(404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
    await expect(requestAiSummary({ capability: 'company_summary' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('survives a non-JSON error body with a status-based message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('not json');
        },
      })),
    );
    await expect(requestAiSummary({ capability: 'company_summary' })).rejects.toMatchObject({
      code: 'SERVER_ERROR',
      status: 500,
    });
  });

  it('maps a network failure to REQUEST_FAILED with status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(requestAiSummary({ capability: 'company_summary' })).rejects.toMatchObject({
      code: 'REQUEST_FAILED',
      status: 0,
    });
  });

  it('propagates aborts untouched so the panel can cancel on unmount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    );
    await expect(requestAiSummary({ capability: 'company_summary' })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
