import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 9 — Workstream C (AI Request Orchestrator): unit tests.
 * Contract: phase9-contract-review.md §5.5 (lifecycle order), §5.4 (error
 * mapping), §3.5 (deadline), §4.3 (audit), §6.2 (tool dispatch), §8.2
 * (metering failure semantics).
 *
 * Every neighbouring workstream is replaced at its module seam: usage (H),
 * capabilities (F — getCapability / prepareCapabilityRequest /
 * parseCapabilityOutput), provider + config (B), tools (E) and the audit
 * writer. The F doubles are faithful-lite: prepare assembles messages the
 * way assembleCapabilityRequest does, and parse performs the same
 * null/unparseable/schema checks before throwing PROVIDER_BAD_RESPONSE.
 * The lifecycle is asserted through mock invocation order and the exact
 * finalize/record payloads — no database, no network.
 *
 * Pinned interpretations:
 *  - §5.5 step order: limits (3) → not-configured (4) → context (5) →
 *    STARTED row (6). A service-layer NOT_FOUND therefore propagates with
 *    NO usage row and NO finalize — "no usage row is written for a request
 *    that was never authorized to see its target".
 *  - Input failures throw `Error('INVALID_REQUEST: …')` (the repo service
 *    convention the route renders as 400); the returned outcome union is
 *    the route's four `status` variants.
 */

const mocks = vi.hoisted(() => ({
  beginAiUsageRequest: vi.fn(),
  finalizeAiUsageRequest: vi.fn(),
  recordAiUsageOutcome: vi.fn(),
  evaluateAiLimits: vi.fn(),
  getCapability: vi.fn(),
  prepareCapabilityRequest: vi.fn(),
  getAiProvider: vi.fn(),
  resolveAiConfig: vi.fn(),
  providerComplete: vi.fn(),
  dispatchToolCall: vi.fn(),
  writeAuditEntry: vi.fn(),
  registrySentinel: { sentinel: 'tool-registry' },
}));

vi.mock('@/lib/ai/usage', () => ({
  beginAiUsageRequest: mocks.beginAiUsageRequest,
  finalizeAiUsageRequest: mocks.finalizeAiUsageRequest,
  recordAiUsageOutcome: mocks.recordAiUsageOutcome,
  evaluateAiLimits: mocks.evaluateAiLimits,
}));

vi.mock('@/lib/ai/context', () => {
  class ContextBuildError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'ContextBuildError';
      this.code = code;
    }
  }
  return {
    ContextBuildError,
    escapeRecordText: (value: string) => value.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  };
});

vi.mock('@/lib/ai/capabilities', async () => {
  const { AiProviderError } =
    await vi.importActual<typeof import('@/lib/ai/errors')>('@/lib/ai/errors');
  class CapabilityInputError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'CapabilityInputError';
      this.code = code;
    }
  }
  const isSummary = (value: unknown): boolean =>
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { headline?: unknown }).headline === 'string' &&
    (value as { headline: string }).headline.trim().length > 0 &&
    ['facts', 'suggestions', 'missingInformation'].every((key) => {
      const list = (value as Record<string, unknown>)[key];
      return Array.isArray(list) && list.every((item) => typeof item === 'string');
    });
  return {
    CapabilityInputError,
    getCapability: mocks.getCapability,
    prepareCapabilityRequest: mocks.prepareCapabilityRequest,
    parseCapabilityOutput: (
      _capability: string,
      result: { text: string | null },
      context: { sources: unknown },
    ) => {
      if (result.text === null || result.text.trim() === '') {
        throw new AiProviderError('PROVIDER_BAD_RESPONSE');
      }
      let raw: unknown;
      try {
        raw = JSON.parse(result.text);
      } catch {
        throw new AiProviderError('PROVIDER_BAD_RESPONSE');
      }
      if (!isSummary(raw)) {
        throw new AiProviderError('PROVIDER_BAD_RESPONSE');
      }
      return { summary: raw, sources: context.sources };
    },
  };
});

vi.mock('@/lib/ai/provider', () => ({ getAiProvider: mocks.getAiProvider }));
vi.mock('@/lib/ai/config', () => ({ resolveAiConfig: mocks.resolveAiConfig }));

vi.mock('@/lib/ai/tools/registry', () => ({
  dispatchToolCall: mocks.dispatchToolCall,
  listProviderToolDefinitions: () => [
    { name: 'get_deal', description: 'Fetch one deal', inputSchema: { type: 'object' } },
  ],
  toModelToolResult: (result: { ok: boolean; value?: unknown }) =>
    result.ok ? result.value : { error: 'unavailable' },
}));

vi.mock('@/lib/ai/tools/crm-tools', () => ({ toolRegistry: mocks.registrySentinel }));

vi.mock('@/lib/audit/log', () => ({ writeAuditEntry: mocks.writeAuditEntry }));

import { runAiRequest, AI_MAX_TOOL_CALLS } from '@/lib/ai/orchestrator';
import { CapabilityInputError } from '@/lib/ai/capabilities';
import { ContextBuildError } from '@/lib/ai/context';
import { AiProviderError } from '@/lib/ai/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import type { Authorization } from '@/lib/authz/require-permission';
import type { AiCompletionResult } from '@/lib/ai/provider/types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const PERSON_ID = '00000000-0000-4000-8000-000000000002';
const REQUEST_ID = '00000000-0000-4000-8000-000000000003';
const DEAL_ID = '00000000-0000-4000-8000-000000000004';
const COMPANY_ID = '00000000-0000-4000-8000-000000000005';
const USAGE_ID = '00000000-0000-4000-8000-000000000006';

const fakeAuth = {
  ctx: { orgId: ORG_ID, personId: PERSON_ID },
  permission: 'ai.use',
  scope: 'GLOBAL',
  requestId: REQUEST_ID,
  meta: { requestId: REQUEST_ID, ip: null, userAgent: null },
} as unknown as Authorization;

const TARGET_TYPES: Record<string, readonly string[]> = {
  lead_summary: ['deal'],
  deal_summary: ['deal'],
  contact_summary: ['contact'],
  company_summary: ['company'],
  activity_summary: ['activity', 'company', 'contact', 'deal'],
  project_summary: ['project'],
  task_summary: ['task'],
  general_assistance: ['company', 'contact', 'deal', 'activity', 'project', 'task'],
};

const VALID_SUMMARY = {
  headline: 'Acme Deal',
  facts: ['Value: 500'],
  suggestions: ['Follow up this week'],
  missingInformation: [],
};

const CONTEXT_TEXT = `<record_data entity="deal" id="${DEAL_ID}">\nlabel: Acme Deal\n</record_data>`;
const CONTEXT = {
  text: CONTEXT_TEXT,
  sources: [{ entityType: 'deal', entityId: DEAL_ID, label: 'Acme Deal' }],
  recordCount: 1,
  truncated: false,
};

function completion(partial: Partial<AiCompletionResult>): AiCompletionResult {
  return {
    text: JSON.stringify(VALID_SUMMARY),
    toolCalls: [],
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    providerRequestId: null,
    finishReason: 'stop',
    ...partial,
  };
}

function orderOf(...fns: Array<{ mock: { invocationCallOrder: number[] } }>): number[] {
  return fns.map((fn) => fn.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
}

function expectAscending(...values: number[]) {
  for (let i = 1; i < values.length; i++) {
    expect(values[i] as number).toBeGreaterThan(values[i - 1] as number);
  }
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.evaluateAiLimits.mockResolvedValue({
    decision: { allowed: true },
    limits: {
      enabled: true,
      monthlyRequests: 5000,
      monthlyTokens: 2000000,
      requestsPerMinutePerUser: 10,
      maxConcurrentRequests: 4,
    },
    rawLimits: null,
    counters: { monthRequests: 0, monthTokens: 0, lastMinuteRequests: 0, inFlight: 0 },
  });
  mocks.resolveAiConfig.mockReturnValue({
    provider: 'mock',
    model: null,
    apiKey: null,
    baseUrl: 'https://api.openai.com/v1',
    timeoutMs: 30_000,
    maxOutputTokens: 800,
  });
  mocks.getAiProvider.mockReturnValue({
    id: 'mock',
    model: 'mock-deterministic',
    complete: mocks.providerComplete,
  });
  mocks.providerComplete.mockResolvedValue(completion({}));
  mocks.beginAiUsageRequest.mockResolvedValue({ usageId: USAGE_ID });
  mocks.finalizeAiUsageRequest.mockResolvedValue(true);
  mocks.recordAiUsageOutcome.mockResolvedValue({ usageId: USAGE_ID });
  mocks.writeAuditEntry.mockResolvedValue(undefined);
  mocks.getCapability.mockImplementation((id: string) => {
    const targetEntityTypes = TARGET_TYPES[id];
    if (!targetEntityTypes) return undefined;
    return {
      id,
      targetEntityTypes,
      requiresTarget: id !== 'general_assistance',
      requiresQuestion: id === 'general_assistance',
      instructions: `instructions for ${id}`,
      toolsAllowed: id === 'general_assistance',
    };
  });
  mocks.prepareCapabilityRequest.mockImplementation(
    async (
      _auth: unknown,
      input: { capability: string; question?: string },
      options?: { tools?: unknown[]; maxOutputTokens?: number },
    ) => {
      const definition = mocks.getCapability(input.capability);
      const userContent =
        input.capability === 'general_assistance'
          ? `${CONTEXT.text}\n\nQuestion:\n${input.question ?? ''}`
          : `Summarize the supplied records.\n\n${CONTEXT.text}`;
      return {
        capability: definition,
        context: CONTEXT,
        request: {
          messages: [
            {
              role: 'system',
              content: `SYSTEM[${input.capability}] instructions for ${input.capability}`,
            },
            { role: 'user', content: userContent },
          ],
          ...(definition.toolsAllowed && options?.tools && options.tools.length > 0
            ? { tools: options.tools }
            : {}),
          maxOutputTokens: options?.maxOutputTokens ?? 800,
          responseFormat: 'json',
        },
      };
    },
  );
  mocks.dispatchToolCall.mockImplementation(
    async (
      _registry: unknown,
      _auth: unknown,
      toolId: string,
      _args: unknown,
      options?: { onExecuted?: (event: unknown) => void },
    ) => {
      options?.onExecuted?.({ toolId, outcome: 'ok', durationMs: 1 });
      return { ok: true, toolId, value: { title: 'Acme Deal' }, durationMs: 1 };
    },
  );
});

const dealInput = {
  capability: 'deal_summary',
  target: { entityType: 'deal', entityId: DEAL_ID },
};

// ── Happy path ───────────────────────────────────────────────────────────────

describe('runAiRequest — happy path', () => {
  it('runs the §5.5 lifecycle in order and returns the §5.3 body', async () => {
    const outcome = await runAiRequest(fakeAuth, dealInput);

    expect(outcome).toEqual({
      requestId: REQUEST_ID,
      capability: 'deal_summary',
      status: 'ok',
      summary: VALID_SUMMARY,
      sources: [{ entityType: 'deal', entityId: DEAL_ID, label: 'Acme Deal' }],
      usage: { provider: 'mock', model: 'mock-deterministic', totalTokens: 150 },
    });

    // Order: limits → prepare(context) → begin → provider → finalize → audit.
    expectAscending(
      ...orderOf(
        mocks.evaluateAiLimits,
        mocks.prepareCapabilityRequest,
        mocks.beginAiUsageRequest,
        mocks.providerComplete,
        mocks.finalizeAiUsageRequest,
        mocks.writeAuditEntry,
      ),
    );

    expect(mocks.prepareCapabilityRequest).toHaveBeenCalledWith(
      fakeAuth,
      {
        capability: 'deal_summary',
        target: { entityType: 'deal', entityId: DEAL_ID },
        question: undefined,
      },
      { maxOutputTokens: 800, tools: undefined },
    );
    expect(mocks.beginAiUsageRequest).toHaveBeenCalledWith(fakeAuth, {
      requestId: REQUEST_ID,
      capability: 'deal_summary',
      provider: 'mock',
      model: 'mock-deterministic',
      targetEntityType: 'deal',
      targetEntityId: DEAL_ID,
    });

    const request = mocks.providerComplete.mock.calls[0]?.[0];
    expect(request.responseFormat).toBe('json');
    expect(request.maxOutputTokens).toBe(800);
    expect(request.tools).toBeUndefined();
    expect(request.messages[0].role).toBe('system');
    expect(request.messages[0].content).toContain('instructions for deal_summary');
    expect(request.messages[1].content).toContain(CONTEXT_TEXT);
    expect(mocks.providerComplete.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);

    expect(mocks.finalizeAiUsageRequest).toHaveBeenCalledWith(fakeAuth, {
      usageId: USAGE_ID,
      status: 'SUCCEEDED',
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      providerAttempts: 1,
      toolCallsCount: 0,
      durationMs: expect.any(Number),
      errorCode: null,
    });

    const auditEntry = mocks.writeAuditEntry.mock.calls[0]?.[1];
    expect(auditEntry.action).toBe('ai.request');
    expect(auditEntry.entityType).toBe('ai_request');
    expect(auditEntry.entityId).toBe(USAGE_ID);
    expect(auditEntry.result).toBe('SUCCESS');
    expect(auditEntry.severity).toBe('LOW');
    expect(auditEntry.metadata).toEqual({
      capability: 'deal_summary',
      provider: 'mock',
      model: 'mock-deterministic',
      status: 'SUCCEEDED',
      totalTokens: 150,
      durationMs: expect.any(Number),
    });
  });

  it('still returns the summary when finalize reports a metering failure (§8.2 fail-open)', async () => {
    mocks.finalizeAiUsageRequest.mockResolvedValue(false);
    const outcome = await runAiRequest(fakeAuth, dealInput);
    expect(outcome.status).toBe('ok');
  });

  it('still returns the summary when the audit write fails', async () => {
    mocks.writeAuditEntry.mockRejectedValue(new Error('audit unavailable'));
    const outcome = await runAiRequest(fakeAuth, dealInput);
    expect(outcome.status).toBe('ok');
  });
});

// ── Input validation (§5.5 step 2 — INVALID_REQUEST throws) ───────────────────

describe('runAiRequest — input validation', () => {
  it('rejects an unknown capability before limits are evaluated', async () => {
    await expect(runAiRequest(fakeAuth, { capability: 'nonsense' })).rejects.toThrow(
      'INVALID_REQUEST: Unknown AI capability.',
    );
    expect(mocks.evaluateAiLimits).not.toHaveBeenCalled();
    expect(mocks.providerComplete).not.toHaveBeenCalled();
  });

  it('rejects a summary capability without a target', async () => {
    await expect(runAiRequest(fakeAuth, { capability: 'deal_summary' })).rejects.toThrow(
      'INVALID_REQUEST:',
    );
    expect(mocks.evaluateAiLimits).not.toHaveBeenCalled();
  });

  it('rejects a capability/target mismatch (deal_summary on a company)', async () => {
    await expect(
      runAiRequest(fakeAuth, {
        capability: 'deal_summary',
        target: { entityType: 'company', entityId: COMPANY_ID },
      }),
    ).rejects.toThrow('INVALID_REQUEST:');
    expect(mocks.prepareCapabilityRequest).not.toHaveBeenCalled();
  });

  it('rejects a malformed target id', async () => {
    await expect(
      runAiRequest(fakeAuth, {
        capability: 'deal_summary',
        target: { entityType: 'deal', entityId: 'not-a-uuid' },
      }),
    ).rejects.toThrow('INVALID_REQUEST:');
  });

  it('requires a question for general_assistance', async () => {
    await expect(runAiRequest(fakeAuth, { capability: 'general_assistance' })).rejects.toThrow(
      'INVALID_REQUEST:',
    );
  });

  it('rejects an oversized question (> 2000 chars)', async () => {
    await expect(
      runAiRequest(fakeAuth, {
        capability: 'general_assistance',
        question: 'x'.repeat(2001),
      }),
    ).rejects.toThrow('INVALID_REQUEST:');
    expect(mocks.evaluateAiLimits).not.toHaveBeenCalled();
  });

  it('translates a CapabilityInputError from the capability layer to INVALID_REQUEST', async () => {
    mocks.prepareCapabilityRequest.mockRejectedValue(
      new CapabilityInputError(
        'QUESTION_REQUIRED',
        'Capability general_assistance requires a question.',
      ),
    );
    await expect(
      runAiRequest(fakeAuth, { capability: 'general_assistance', question: 'why?' }),
    ).rejects.toThrow('INVALID_REQUEST: Capability general_assistance requires a question.');
    expect(mocks.beginAiUsageRequest).not.toHaveBeenCalled();
  });
});

// ── Limit + not-configured short-circuits (§5.5 steps 3–4) ────────────────────

describe('runAiRequest — short-circuits', () => {
  it('limited: records a LIMITED row, audits, never prepares context or begins', async () => {
    mocks.evaluateAiLimits.mockResolvedValue({
      decision: { allowed: false, reason: 'rate', retryAfterSeconds: 60 },
      limits: {
        enabled: true,
        monthlyRequests: 5000,
        monthlyTokens: 2000000,
        requestsPerMinutePerUser: 10,
        maxConcurrentRequests: 4,
      },
      rawLimits: null,
      counters: { monthRequests: 3, monthTokens: 10, lastMinuteRequests: 10, inFlight: 0 },
    });

    const outcome = await runAiRequest(fakeAuth, dealInput);

    expect(outcome).toEqual({ status: 'limited', requestId: REQUEST_ID, retryAfterSeconds: 60 });
    expect(mocks.recordAiUsageOutcome).toHaveBeenCalledTimes(1);
    expect(mocks.recordAiUsageOutcome).toHaveBeenCalledWith(
      fakeAuth,
      expect.objectContaining({ capability: 'deal_summary', provider: 'mock' }),
      'LIMITED',
    );
    expect(mocks.prepareCapabilityRequest).not.toHaveBeenCalled();
    expect(mocks.beginAiUsageRequest).not.toHaveBeenCalled();
    expect(mocks.providerComplete).not.toHaveBeenCalled();
    const auditEntry = mocks.writeAuditEntry.mock.calls[0]?.[1];
    expect(auditEntry.result).toBe('ERROR');
    expect(auditEntry.severity).toBe('MEDIUM');
    expect(auditEntry.metadata.status).toBe('LIMITED');
    expect(auditEntry.entityId).toBe(USAGE_ID);
  });

  it('limited with a null retry hint passes null through (kill switch)', async () => {
    mocks.evaluateAiLimits.mockResolvedValue({
      decision: { allowed: false, reason: 'disabled', retryAfterSeconds: null },
      limits: {
        enabled: false,
        monthlyRequests: 5000,
        monthlyTokens: 2000000,
        requestsPerMinutePerUser: 10,
        maxConcurrentRequests: 4,
      },
      rawLimits: null,
      counters: { monthRequests: 0, monthTokens: 0, lastMinuteRequests: 0, inFlight: 0 },
    });
    const outcome = await runAiRequest(fakeAuth, dealInput);
    expect(outcome).toEqual({ status: 'limited', requestId: REQUEST_ID, retryAfterSeconds: null });
  });

  it('limited outcome survives a failed visibility-row insert (entityId null in audit)', async () => {
    mocks.evaluateAiLimits.mockResolvedValue({
      decision: { allowed: false, reason: 'concurrency', retryAfterSeconds: null },
      limits: {
        enabled: true,
        monthlyRequests: 5000,
        monthlyTokens: 2000000,
        requestsPerMinutePerUser: 10,
        maxConcurrentRequests: 4,
      },
      rawLimits: null,
      counters: { monthRequests: 0, monthTokens: 0, lastMinuteRequests: 0, inFlight: 4 },
    });
    mocks.recordAiUsageOutcome.mockResolvedValue(null);
    const outcome = await runAiRequest(fakeAuth, dealInput);
    expect(outcome.status).toBe('limited');
    expect(mocks.writeAuditEntry.mock.calls[0]?.[1].entityId).toBeNull();
  });

  it('not configured: records NOT_CONFIGURED after limits, never fetches context or begins', async () => {
    mocks.resolveAiConfig.mockReturnValue({
      provider: 'openai-compatible',
      model: 'gpt-test',
      apiKey: null,
      baseUrl: 'https://api.openai.com/v1',
      timeoutMs: 30_000,
      maxOutputTokens: 800,
    });
    mocks.getAiProvider.mockReturnValue({
      id: 'openai-compatible',
      model: 'gpt-test',
      complete: mocks.providerComplete,
    });

    const outcome = await runAiRequest(fakeAuth, dealInput);

    expect(outcome).toEqual({ status: 'not_configured', requestId: REQUEST_ID });
    // Limits are evaluated BEFORE the not-configured check (§5.5 order).
    expectAscending(...orderOf(mocks.evaluateAiLimits, mocks.recordAiUsageOutcome));
    expect(mocks.recordAiUsageOutcome).toHaveBeenCalledWith(
      fakeAuth,
      expect.objectContaining({ provider: 'openai-compatible', model: 'gpt-test' }),
      'NOT_CONFIGURED',
    );
    expect(mocks.prepareCapabilityRequest).not.toHaveBeenCalled();
    expect(mocks.beginAiUsageRequest).not.toHaveBeenCalled();
    expect(mocks.providerComplete).not.toHaveBeenCalled();
    expect(mocks.writeAuditEntry.mock.calls[0]?.[1].metadata.status).toBe('NOT_CONFIGURED');
  });
});

// ── Context failures (§5.5 step 5) ───────────────────────────────────────────

describe('runAiRequest — context failures', () => {
  it('propagates a service NOT_FOUND untouched — no usage row, no finalize, no provider call', async () => {
    const notFound = new AuthorizationError('NOT_FOUND', {
      requestId: REQUEST_ID,
      reason: 'TARGET_NOT_VISIBLE',
    });
    mocks.prepareCapabilityRequest.mockRejectedValue(notFound);

    await expect(runAiRequest(fakeAuth, dealInput)).rejects.toBe(notFound);
    expect(mocks.beginAiUsageRequest).not.toHaveBeenCalled();
    expect(mocks.finalizeAiUsageRequest).not.toHaveBeenCalled();
    expect(mocks.recordAiUsageOutcome).not.toHaveBeenCalled();
    expect(mocks.providerComplete).not.toHaveBeenCalled();
  });

  it('propagates a service FORBIDDEN untouched', async () => {
    const forbidden = new AuthorizationError('FORBIDDEN', {
      requestId: REQUEST_ID,
      reason: 'PERMISSION_DENIED',
    });
    mocks.prepareCapabilityRequest.mockRejectedValue(forbidden);
    await expect(runAiRequest(fakeAuth, dealInput)).rejects.toBe(forbidden);
    expect(mocks.beginAiUsageRequest).not.toHaveBeenCalled();
  });

  it('translates a builder ContextBuildError to an INVALID_REQUEST throw', async () => {
    mocks.prepareCapabilityRequest.mockRejectedValue(
      new ContextBuildError('TARGET_REQUIRED', 'Capability deal_summary requires a target record.'),
    );
    await expect(runAiRequest(fakeAuth, dealInput)).rejects.toThrow(
      'INVALID_REQUEST: Capability deal_summary requires a target record.',
    );
    expect(mocks.beginAiUsageRequest).not.toHaveBeenCalled();
  });
});

// ── Begin failure (§5.5 step 6, §8.2 fail-closed) ────────────────────────────

describe('runAiRequest — begin failure', () => {
  it('refuses the request when the STARTED insert fails — zero provider calls', async () => {
    const failure = new Error('insert failed');
    mocks.beginAiUsageRequest.mockRejectedValue(failure);
    await expect(runAiRequest(fakeAuth, dealInput)).rejects.toBe(failure);
    expect(mocks.providerComplete).not.toHaveBeenCalled();
    expect(mocks.finalizeAiUsageRequest).not.toHaveBeenCalled();
  });
});

// ── Provider + output failures (§5.5 steps 7–8) ──────────────────────────────

describe('runAiRequest — provider failures', () => {
  it('maps a taxonomy provider error to provider_failed and finalizes FAILED with its code', async () => {
    mocks.providerComplete.mockRejectedValue(new AiProviderError('PROVIDER_UNAVAILABLE'));
    const outcome = await runAiRequest(fakeAuth, dealInput);
    expect(outcome).toEqual({ status: 'provider_failed', requestId: REQUEST_ID });
    expect(mocks.finalizeAiUsageRequest).toHaveBeenCalledWith(
      fakeAuth,
      expect.objectContaining({
        usageId: USAGE_ID,
        status: 'FAILED',
        errorCode: 'PROVIDER_UNAVAILABLE',
        providerAttempts: 1,
        totalTokens: null,
      }),
    );
    const auditEntry = mocks.writeAuditEntry.mock.calls[0]?.[1];
    expect(auditEntry.result).toBe('ERROR');
    expect(auditEntry.severity).toBe('MEDIUM');
    expect(auditEntry.metadata.status).toBe('FAILED');
  });

  it('normalizes a non-taxonomy provider throw to PROVIDER_UNAVAILABLE (raw error never surfaces)', async () => {
    mocks.providerComplete.mockRejectedValue(new Error('socket exploded at 10.0.0.1'));
    const outcome = await runAiRequest(fakeAuth, dealInput);
    expect(outcome).toEqual({ status: 'provider_failed', requestId: REQUEST_ID });
    expect(mocks.finalizeAiUsageRequest).toHaveBeenCalledWith(
      fakeAuth,
      expect.objectContaining({ errorCode: 'PROVIDER_UNAVAILABLE' }),
    );
  });

  it('enforces the overall deadline: an abort surfaces as PROVIDER_TIMEOUT', async () => {
    mocks.resolveAiConfig.mockReturnValue({
      provider: 'mock',
      model: null,
      apiKey: null,
      baseUrl: 'https://api.openai.com/v1',
      timeoutMs: 25,
      maxOutputTokens: 800,
    });
    mocks.providerComplete.mockImplementation(
      (_req: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new AiProviderError('PROVIDER_TIMEOUT')), {
            once: true,
          });
        }),
    );
    const outcome = await runAiRequest(fakeAuth, dealInput);
    expect(outcome).toEqual({ status: 'provider_failed', requestId: REQUEST_ID });
    expect(mocks.finalizeAiUsageRequest).toHaveBeenCalledWith(
      fakeAuth,
      expect.objectContaining({ status: 'FAILED', errorCode: 'PROVIDER_TIMEOUT' }),
    );
  });

  it('rejects unparseable model output as PROVIDER_BAD_RESPONSE', async () => {
    mocks.providerComplete.mockResolvedValue(completion({ text: 'not json at all' }));
    const outcome = await runAiRequest(fakeAuth, dealInput);
    expect(outcome).toEqual({ status: 'provider_failed', requestId: REQUEST_ID });
    expect(mocks.finalizeAiUsageRequest).toHaveBeenCalledWith(
      fakeAuth,
      expect.objectContaining({ status: 'FAILED', errorCode: 'PROVIDER_BAD_RESPONSE' }),
    );
  });

  it('rejects schema-invalid model output as PROVIDER_BAD_RESPONSE', async () => {
    mocks.providerComplete.mockResolvedValue(
      completion({ text: JSON.stringify({ headline: 'x', facts: 'not-an-array' }) }),
    );
    const outcome = await runAiRequest(fakeAuth, dealInput);
    expect(outcome).toEqual({ status: 'provider_failed', requestId: REQUEST_ID });
    expect(mocks.finalizeAiUsageRequest).toHaveBeenCalledWith(
      fakeAuth,
      expect.objectContaining({ errorCode: 'PROVIDER_BAD_RESPONSE' }),
    );
  });

  it('rejects a null text with no tool calls as PROVIDER_BAD_RESPONSE', async () => {
    mocks.providerComplete.mockResolvedValue(completion({ text: null }));
    const outcome = await runAiRequest(fakeAuth, dealInput);
    expect(outcome).toEqual({ status: 'provider_failed', requestId: REQUEST_ID });
  });
});

// ── Tool loop (§5.5 step 7, §6.2) ────────────────────────────────────────────

describe('runAiRequest — tool loop (general_assistance)', () => {
  const gaInput = { capability: 'general_assistance', question: 'Show me the deal get_deal' };

  it('offers tools, dispatches through the registry, feeds the result back, counts the call', async () => {
    mocks.providerComplete
      .mockResolvedValueOnce(
        completion({
          text: null,
          toolCalls: [{ id: 'call-1', name: 'get_deal', arguments: { id: DEAL_ID } }],
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          finishReason: 'tool_calls',
        }),
      )
      .mockResolvedValueOnce(
        completion({ usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } }),
      );

    const outcome = await runAiRequest(fakeAuth, gaInput);
    expect(outcome.status).toBe('ok');

    // Tools were handed to the capability layer for a tools-allowed capability.
    const prepareOptions = mocks.prepareCapabilityRequest.mock.calls[0]?.[2];
    expect(prepareOptions.tools).toEqual([
      { name: 'get_deal', description: 'Fetch one deal', inputSchema: { type: 'object' } },
    ]);

    // …and offered on the first provider call; the question rides along.
    const firstRequest = mocks.providerComplete.mock.calls[0]?.[0];
    expect(firstRequest.tools).toEqual(prepareOptions.tools);
    expect(firstRequest.messages[1].content).toContain('Show me the deal get_deal');

    // Dispatch went through E's dispatcher with the registry + request signal.
    expect(mocks.dispatchToolCall).toHaveBeenCalledTimes(1);
    const dispatchArgs = mocks.dispatchToolCall.mock.calls[0];
    expect(dispatchArgs?.[0]).toBe(mocks.registrySentinel);
    expect(dispatchArgs?.[1]).toBe(fakeAuth);
    expect(dispatchArgs?.[2]).toBe('get_deal');
    expect(dispatchArgs?.[3]).toEqual({ id: DEAL_ID });
    expect(dispatchArgs?.[4].signal).toBeInstanceOf(AbortSignal);
    expect(typeof dispatchArgs?.[4].onExecuted).toBe('function');

    // The result returns as a delimited tool message on the second call.
    const secondRequest = mocks.providerComplete.mock.calls[1]?.[0];
    const toolMessage = secondRequest.messages[secondRequest.messages.length - 1];
    expect(toolMessage.role).toBe('tool');
    expect(toolMessage.toolCallId).toBe('call-1');
    expect(toolMessage.name).toBe('get_deal');
    expect(toolMessage.content).toContain('<record_data entity="tool_result" tool="get_deal">');
    expect(toolMessage.content).toContain('"title":"Acme Deal"');

    // Metering: one tool call, two attempts, tokens summed across rounds.
    expect(mocks.finalizeAiUsageRequest).toHaveBeenCalledWith(
      fakeAuth,
      expect.objectContaining({
        status: 'SUCCEEDED',
        providerAttempts: 2,
        toolCallsCount: 1,
        promptTokens: 30,
        completionTokens: 15,
        totalTokens: 45,
      }),
    );
  });

  it('feeds a failed dispatch back as exactly {error:"unavailable"} — existence never leaks', async () => {
    mocks.dispatchToolCall.mockImplementation(
      async (
        _registry: unknown,
        _auth: unknown,
        toolId: string,
        _args: unknown,
        options?: { onExecuted?: (event: unknown) => void },
      ) => {
        options?.onExecuted?.({ toolId, outcome: 'not_found', durationMs: 1 });
        return { ok: false, toolId, error: 'unavailable', reason: 'not_found', durationMs: 1 };
      },
    );
    mocks.providerComplete
      .mockResolvedValueOnce(
        completion({
          text: null,
          toolCalls: [{ id: 'call-9', name: 'get_deal', arguments: { id: DEAL_ID } }],
          finishReason: 'tool_calls',
        }),
      )
      .mockResolvedValueOnce(completion({}));

    const outcome = await runAiRequest(fakeAuth, gaInput);
    expect(outcome.status).toBe('ok');
    const secondRequest = mocks.providerComplete.mock.calls[1]?.[0];
    const toolMessage = secondRequest.messages[secondRequest.messages.length - 1];
    expect(toolMessage.content).toContain('{"error":"unavailable"}');
    expect(mocks.finalizeAiUsageRequest).toHaveBeenCalledWith(
      fakeAuth,
      expect.objectContaining({ toolCallsCount: 1 }),
    );
  });

  it('bounds the loop at 3 dispatches against a provider that always requests tools', async () => {
    let callNumber = 0;
    mocks.providerComplete.mockImplementation(async () => {
      callNumber += 1;
      return completion({
        text: null,
        toolCalls: [{ id: `call-${callNumber}`, name: 'get_deal', arguments: { id: DEAL_ID } }],
        finishReason: 'tool_calls',
      });
    });

    const outcome = await runAiRequest(fakeAuth, gaInput);

    expect(mocks.dispatchToolCall).toHaveBeenCalledTimes(AI_MAX_TOOL_CALLS);
    // 3 tool rounds + exactly one final tool-less call, which returned no
    // text → the request fails as a bad response instead of looping.
    expect(mocks.providerComplete).toHaveBeenCalledTimes(AI_MAX_TOOL_CALLS + 1);
    const finalRequest = mocks.providerComplete.mock.calls[AI_MAX_TOOL_CALLS]?.[0];
    expect(finalRequest.tools).toBeUndefined();
    expect(outcome).toEqual({ status: 'provider_failed', requestId: REQUEST_ID });
    expect(mocks.finalizeAiUsageRequest).toHaveBeenCalledWith(
      fakeAuth,
      expect.objectContaining({
        status: 'FAILED',
        errorCode: 'PROVIDER_BAD_RESPONSE',
        toolCallsCount: AI_MAX_TOOL_CALLS,
        providerAttempts: AI_MAX_TOOL_CALLS + 1,
      }),
    );
  });
});
