import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 9 — Workstream H (Usage, Cost & Rate Controls): unit tests.
 * Contract: phase9-contract-review.md §8.1/§8.2/§8.3, §4.1/§4.2.
 *
 * Two layers:
 *   1. limits.ts — the pure decision: defaults, NULL-merging, the §8.2
 *      check order, boundary semantics, retryAfterSeconds.
 *   2. usage.ts — the metering service with withAuthorizedDb replaced
 *      (the tests/authz/errors.test.ts mocking convention): two-phase
 *      begin/finalize, the fail-closed STARTED insert, the never-throw
 *      finalize/outcome paths, definer-read mapping, limits upsert and
 *      the §8.3 summary aggregates.
 *
 * DB-dependent behaviour (the definer functions' counting windows, RLS
 * on ai_usage_requests / ai_org_limits, guard triggers) is NOT asserted
 * here — it belongs to the tests/db suite (tests/db/ai-usage.test.ts,
 * Workstream I per contract §11.3) once migration 0054 exists.
 */

const mocks = vi.hoisted(() => ({
  withAuthorizedDb: vi.fn(),
  execute: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@/lib/db/authorized', () => ({ withAuthorizedDb: mocks.withAuthorizedDb }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.captureException }));

import {
  AI_LIMIT_DEFAULTS,
  checkLimits,
  resolveEffectiveLimits,
  type AiOrgLimitsRow,
  type AiUsageCounters,
  type EffectiveAiLimits,
} from '@/lib/ai/limits';

const {
  beginAiUsageRequest,
  recordAiUsageOutcome,
  finalizeAiUsageRequest,
  evaluateAiLimits,
  readAiLimits,
  readAiUsageCounters,
  upsertAiOrgLimits,
  getAiUsageSummary,
  mapAiUsageRequestRow,
} = await import('@/lib/ai/usage');

type Authorization = import('@/lib/authz/require-permission').Authorization;

const CTX = {
  personId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  aal: 'aal1' as const,
};
const AUTH = { ctx: CTX } as unknown as Authorization;
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const USAGE_ID = '44444444-4444-4444-8444-444444444444';

const BEGIN = {
  requestId: REQUEST_ID,
  capability: 'deal_summary',
  provider: 'mock',
  model: 'mock-deterministic',
  targetEntityType: 'deal' as const,
  targetEntityId: '55555555-5555-4555-8555-555555555555',
};

const DEFAULT_LIMITS: EffectiveAiLimits = {
  enabled: true,
  monthlyRequests: AI_LIMIT_DEFAULTS.monthlyRequests,
  monthlyTokens: AI_LIMIT_DEFAULTS.monthlyTokens,
  requestsPerMinutePerUser: AI_LIMIT_DEFAULTS.requestsPerMinutePerUser,
  maxConcurrentRequests: AI_LIMIT_DEFAULTS.maxConcurrentRequests,
};

const NO_USAGE: AiUsageCounters = {
  monthRequests: 0,
  monthTokens: 0,
  lastMinuteRequests: 0,
  inFlight: 0,
};

const limitsRow = (overrides: Partial<AiOrgLimitsRow> = {}): AiOrgLimitsRow => ({
  orgId: CTX.orgId,
  enabled: true,
  monthlyRequestLimit: null,
  monthlyTokenLimit: null,
  maxRequestsPerMinutePerUser: null,
  maxConcurrentRequests: null,
  updatedBy: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  ...overrides,
});

/** Raw ai_org_limits row as stored in the table (numbers may arrive as strings). */
const limitsDbRow = (overrides: Record<string, unknown> = {}) => ({
  org_id: CTX.orgId,
  enabled: true,
  monthly_request_limit: null,
  monthly_token_limit: null,
  max_requests_per_minute_per_user: null,
  max_concurrent_requests: null,
  updated_by: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

/** Raw ai_usage_counters row (aggregates arrive as int8 strings). */
const countersDbRow = (overrides: Record<string, unknown> = {}) => ({
  month_requests: '0',
  month_tokens: '0',
  last_minute_requests: '0',
  in_flight: '0',
  ...overrides,
});

const dbAnswers = (...results: unknown[]) => {
  for (const result of results) mocks.execute.mockResolvedValueOnce(result);
};
const rowsOf = (...rows: unknown[]) => ({ rows });

beforeEach(() => {
  mocks.execute.mockReset();
  mocks.captureException.mockReset();
  mocks.withAuthorizedDb
    .mockReset()
    .mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn({ execute: mocks.execute }),
    );
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ── limits.ts: defaults + merging ────────────────────────────────────────────

describe('AI_LIMIT_DEFAULTS (§8.2)', () => {
  it('pins the contract defaults', () => {
    expect(AI_LIMIT_DEFAULTS).toEqual({
      monthlyRequests: 5_000,
      monthlyTokens: 2_000_000,
      requestsPerMinutePerUser: 10,
      maxConcurrentRequests: 4,
    });
  });
});

describe('resolveEffectiveLimits', () => {
  it('no limits row → all defaults, kill switch on', () => {
    expect(resolveEffectiveLimits(null)).toEqual(DEFAULT_LIMITS);
  });

  it('an all-NULL row behaves exactly like no row', () => {
    expect(resolveEffectiveLimits(limitsRow())).toEqual(DEFAULT_LIMITS);
  });

  it('stored values win field-by-field; NULLs fall back individually', () => {
    const effective = resolveEffectiveLimits(
      limitsRow({ monthlyRequestLimit: 100, maxConcurrentRequests: 2 }),
    );
    expect(effective.monthlyRequests).toBe(100);
    expect(effective.maxConcurrentRequests).toBe(2);
    expect(effective.monthlyTokens).toBe(AI_LIMIT_DEFAULTS.monthlyTokens);
    expect(effective.requestsPerMinutePerUser).toBe(AI_LIMIT_DEFAULTS.requestsPerMinutePerUser);
  });

  it('enabled=false survives the merge (the kill switch)', () => {
    expect(resolveEffectiveLimits(limitsRow({ enabled: false })).enabled).toBe(false);
  });

  it('a stored 0 is a real value, not a missing one', () => {
    expect(resolveEffectiveLimits(limitsRow({ monthlyRequestLimit: 0 })).monthlyRequests).toBe(0);
  });
});

// ── limits.ts: checkLimits (§8.2 order + boundaries) ─────────────────────────

describe('checkLimits', () => {
  it('allows when every counter is below its limit', () => {
    expect(
      checkLimits(DEFAULT_LIMITS, {
        monthRequests: DEFAULT_LIMITS.monthlyRequests - 1,
        monthTokens: DEFAULT_LIMITS.monthlyTokens - 1,
        lastMinuteRequests: DEFAULT_LIMITS.requestsPerMinutePerUser - 1,
        inFlight: DEFAULT_LIMITS.maxConcurrentRequests - 1,
      }),
    ).toEqual({ allowed: true });
  });

  it('disabled wins over every other failure (check order: enabled first)', () => {
    const blown: AiUsageCounters = {
      monthRequests: 999_999,
      monthTokens: 999_999_999,
      lastMinuteRequests: 999,
      inFlight: 999,
    };
    expect(checkLimits({ ...DEFAULT_LIMITS, enabled: false }, blown)).toEqual({
      allowed: false,
      reason: 'disabled',
      retryAfterSeconds: null,
    });
  });

  it('concurrency: reaching maxConcurrentRequests refuses, one below allows', () => {
    expect(checkLimits(DEFAULT_LIMITS, { ...NO_USAGE, inFlight: 4 })).toEqual({
      allowed: false,
      reason: 'concurrency',
      retryAfterSeconds: null,
    });
    expect(checkLimits(DEFAULT_LIMITS, { ...NO_USAGE, inFlight: 3 })).toEqual({ allowed: true });
  });

  it('per-minute rate: reason rate with retryAfterSeconds 60', () => {
    expect(checkLimits(DEFAULT_LIMITS, { ...NO_USAGE, lastMinuteRequests: 10 })).toEqual({
      allowed: false,
      reason: 'rate',
      retryAfterSeconds: 60,
    });
    expect(checkLimits(DEFAULT_LIMITS, { ...NO_USAGE, lastMinuteRequests: 9 })).toEqual({
      allowed: true,
    });
  });

  it('monthly requests: reaching the cap refuses without a retry hint', () => {
    expect(checkLimits(DEFAULT_LIMITS, { ...NO_USAGE, monthRequests: 5_000 })).toEqual({
      allowed: false,
      reason: 'monthly_requests',
      retryAfterSeconds: null,
    });
  });

  it('monthly tokens: reaching the cap refuses', () => {
    expect(checkLimits(DEFAULT_LIMITS, { ...NO_USAGE, monthTokens: 2_000_000 })).toEqual({
      allowed: false,
      reason: 'monthly_tokens',
      retryAfterSeconds: null,
    });
  });

  it('order: concurrency beats rate, rate beats monthly requests, monthly requests beats monthly tokens', () => {
    const all: AiUsageCounters = {
      monthRequests: 5_000,
      monthTokens: 2_000_000,
      lastMinuteRequests: 10,
      inFlight: 4,
    };
    expect(checkLimits(DEFAULT_LIMITS, all)).toMatchObject({ reason: 'concurrency' });
    expect(checkLimits(DEFAULT_LIMITS, { ...all, inFlight: 0 })).toMatchObject({
      reason: 'rate',
    });
    expect(
      checkLimits(DEFAULT_LIMITS, { ...all, inFlight: 0, lastMinuteRequests: 0 }),
    ).toMatchObject({ reason: 'monthly_requests' });
    expect(
      checkLimits(DEFAULT_LIMITS, { ...all, inFlight: 0, lastMinuteRequests: 0, monthRequests: 0 }),
    ).toMatchObject({ reason: 'monthly_tokens' });
  });

  it('custom (lowered) limits are honoured, including a 0 cap', () => {
    const limits: EffectiveAiLimits = { ...DEFAULT_LIMITS, monthlyRequests: 0 };
    expect(checkLimits(limits, NO_USAGE)).toEqual({
      allowed: false,
      reason: 'monthly_requests',
      retryAfterSeconds: null,
    });
  });
});

// ── usage.ts: two-phase metering ─────────────────────────────────────────────

describe('beginAiUsageRequest (phase 1 — fail-closed, §8.2)', () => {
  it('inserts the STARTED row under the caller context and returns its id', async () => {
    dbAnswers(rowsOf({ id: USAGE_ID }));
    await expect(beginAiUsageRequest(AUTH, BEGIN)).resolves.toEqual({ usageId: USAGE_ID });
    expect(mocks.withAuthorizedDb).toHaveBeenCalledWith(CTX, expect.any(Function));
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('propagates a database failure — no unmetered AI', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('connection lost'));
    await expect(beginAiUsageRequest(AUTH, BEGIN)).rejects.toThrow('connection lost');
  });

  it('throws when the insert returns no row', async () => {
    dbAnswers(rowsOf());
    await expect(beginAiUsageRequest(AUTH, BEGIN)).rejects.toThrow('no row');
  });
});

describe('recordAiUsageOutcome (LIMITED / NOT_CONFIGURED visibility rows)', () => {
  it('records a LIMITED row and returns its id', async () => {
    dbAnswers(rowsOf({ id: USAGE_ID }));
    await expect(recordAiUsageOutcome(AUTH, BEGIN, 'LIMITED')).resolves.toEqual({
      usageId: USAGE_ID,
    });
  });

  it('never throws: a failed insert is logged and reported as null', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('rls denied'));
    await expect(recordAiUsageOutcome(AUTH, BEGIN, 'NOT_CONFIGURED')).resolves.toBeNull();
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('finalizeAiUsageRequest (phase 2 — never throws, §8.2)', () => {
  const FINALIZE = {
    usageId: USAGE_ID,
    status: 'SUCCEEDED' as const,
    promptTokens: 120,
    completionTokens: 80,
    totalTokens: 200,
    providerAttempts: 2,
    toolCallsCount: 1,
    durationMs: 1234,
  };

  it('updates the same row and reports success', async () => {
    dbAnswers(rowsOf({ id: USAGE_ID }));
    await expect(finalizeAiUsageRequest(AUTH, FINALIZE)).resolves.toBe(true);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('a failed finalize is logged, returns false, and does not throw', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('connection lost'));
    await expect(finalizeAiUsageRequest(AUTH, FINALIZE)).resolves.toBe(false);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it('zero rows updated (row not ours / gone) is a metering failure, not a throw', async () => {
    dbAnswers(rowsOf());
    await expect(finalizeAiUsageRequest(AUTH, FINALIZE)).resolves.toBe(false);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it('accepts unreported token counts (nulls stay null — never estimated)', async () => {
    dbAnswers(rowsOf({ id: USAGE_ID }));
    await expect(
      finalizeAiUsageRequest(AUTH, {
        usageId: USAGE_ID,
        status: 'FAILED',
        providerAttempts: 2,
        durationMs: 30_000,
        errorCode: 'PROVIDER_TIMEOUT',
      }),
    ).resolves.toBe(true);
  });
});

// ── usage.ts: definer reads + evaluation ─────────────────────────────────────

describe('readAiLimits / readAiUsageCounters', () => {
  it('no limits row stored → raw null, effective defaults', async () => {
    // Two reads: the definer projection (no row back) and the raw table select.
    dbAnswers(rowsOf(), rowsOf());
    const { effective, raw } = await readAiLimits(AUTH);
    expect(raw).toBeNull();
    expect(effective).toEqual(DEFAULT_LIMITS);
  });

  it('maps the stored row and coerces string aggregates', async () => {
    // First answer: the ai_effective_limits projection — the five
    // effective values only, defaults already merged by the definer.
    // Second answer: the raw stored row from the table.
    dbAnswers(
      rowsOf({
        enabled: true,
        monthly_request_limit: '250',
        monthly_token_limit: String(AI_LIMIT_DEFAULTS.monthlyTokens),
        max_requests_per_minute_per_user: String(AI_LIMIT_DEFAULTS.requestsPerMinutePerUser),
        max_concurrent_requests: '1',
      }),
      rowsOf(limitsDbRow({ monthly_request_limit: '250', max_concurrent_requests: '1' })),
    );
    const { effective, raw } = await readAiLimits(AUTH);
    expect(raw?.monthlyRequestLimit).toBe(250);
    expect(effective.monthlyRequests).toBe(250);
    expect(effective.maxConcurrentRequests).toBe(1);
    expect(effective.monthlyTokens).toBe(AI_LIMIT_DEFAULTS.monthlyTokens);
  });

  it('counters coerce int8 strings to numbers; missing row reads as zeros', async () => {
    dbAnswers(rowsOf(countersDbRow({ month_requests: '42', in_flight: '3' })));
    await expect(readAiUsageCounters(AUTH)).resolves.toEqual({
      monthRequests: 42,
      monthTokens: 0,
      lastMinuteRequests: 0,
      inFlight: 3,
    });
    dbAnswers(rowsOf());
    await expect(readAiUsageCounters(AUTH)).resolves.toEqual(NO_USAGE);
  });
});

describe('evaluateAiLimits (§5.5 step 3)', () => {
  it('reads limits and counters in one transaction and allows headroom', async () => {
    dbAnswers(rowsOf(limitsDbRow()), rowsOf(countersDbRow({ month_requests: '4999' })));
    const evaluation = await evaluateAiLimits(AUTH);
    expect(evaluation.decision).toEqual({ allowed: true });
    expect(evaluation.counters.monthRequests).toBe(4999);
    expect(evaluation.limits).toEqual(DEFAULT_LIMITS);
    expect(mocks.withAuthorizedDb).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });

  it('kill switch: enabled=false in the stored row limits every request', async () => {
    dbAnswers(rowsOf(limitsDbRow({ enabled: false })), rowsOf(countersDbRow()));
    const evaluation = await evaluateAiLimits(AUTH);
    expect(evaluation.decision).toEqual({
      allowed: false,
      reason: 'disabled',
      retryAfterSeconds: null,
    });
  });

  it('concurrency from the definer aggregates maps to the typed 429 outcome', async () => {
    dbAnswers(rowsOf(limitsDbRow()), rowsOf(countersDbRow({ in_flight: '4' })));
    const evaluation = await evaluateAiLimits(AUTH);
    expect(evaluation.decision).toEqual({
      allowed: false,
      reason: 'concurrency',
      retryAfterSeconds: null,
    });
  });
});

// ── usage.ts: limits upsert ──────────────────────────────────────────────────

describe('upsertAiOrgLimits', () => {
  const INPUT = {
    enabled: true,
    monthlyRequestLimit: 1000,
    monthlyTokenLimit: null,
    maxRequestsPerMinutePerUser: 5,
    maxConcurrentRequests: null,
  };

  it('upserts and returns the stored row, mapped', async () => {
    // Three statements: the upsert itself, then the in-transaction
    // re-reads — raw row from the table, effective projection via the
    // definer (its values are asserted through readAiLimits above).
    dbAnswers(
      rowsOf(),
      rowsOf(
        limitsDbRow({
          monthly_request_limit: 1000,
          max_requests_per_minute_per_user: 5,
          updated_by: CTX.personId,
        }),
      ),
      rowsOf({
        enabled: true,
        monthly_request_limit: 1000,
        monthly_token_limit: AI_LIMIT_DEFAULTS.monthlyTokens,
        max_requests_per_minute_per_user: 5,
        max_concurrent_requests: AI_LIMIT_DEFAULTS.maxConcurrentRequests,
      }),
    );
    const row = await upsertAiOrgLimits(AUTH, INPUT);
    expect(row.monthlyRequestLimit).toBe(1000);
    expect(row.monthlyTokenLimit).toBeNull();
    expect(row.maxRequestsPerMinutePerUser).toBe(5);
    expect(row.updatedBy).toBe(CTX.personId);
  });

  it('rejects a negative cap before touching the database', async () => {
    await expect(upsertAiOrgLimits(AUTH, { ...INPUT, monthlyRequestLimit: -1 })).rejects.toThrow(
      'INVALID_REQUEST',
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects a non-integer cap before touching the database', async () => {
    await expect(upsertAiOrgLimits(AUTH, { ...INPUT, maxConcurrentRequests: 1.5 })).rejects.toThrow(
      'INVALID_REQUEST',
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

// ── usage.ts: monthly summary (§8.3) ─────────────────────────────────────────

describe('getAiUsageSummary', () => {
  const queueSummary = () => {
    dbAnswers(
      rowsOf({
        requests: 7,
        succeeded: 4,
        failed: 1,
        limited: 2,
        total_tokens: '900',
      }),
      rowsOf(
        { key: 'deal_summary', requests: 5, total_tokens: '700' },
        { key: 'general_assistance', requests: 2, total_tokens: '200' },
      ),
      rowsOf({ key: 'mock', requests: 7, total_tokens: '900' }),
    );
  };

  it('returns the §8.3 shape for an explicit month, tokens coerced', async () => {
    queueSummary();
    const summary = await getAiUsageSummary(AUTH, '2026-10');
    expect(summary).toEqual({
      period: '2026-10',
      requests: 7,
      succeeded: 4,
      failed: 1,
      limited: 2,
      totalTokens: 900,
      byCapability: [
        { key: 'deal_summary', requests: 5, totalTokens: 700 },
        { key: 'general_assistance', requests: 2, totalTokens: 200 },
      ],
      byProvider: [{ key: 'mock', requests: 7, totalTokens: 900 }],
    });
  });

  it('defaults to the current UTC month', async () => {
    queueSummary();
    const summary = await getAiUsageSummary(AUTH);
    expect(summary.period).toBe(new Date().toISOString().slice(0, 7));
  });

  it('rejects a malformed month before touching the database', async () => {
    await expect(getAiUsageSummary(AUTH, '2026-13')).rejects.toThrow('INVALID_REQUEST');
    await expect(getAiUsageSummary(AUTH, '10-2026')).rejects.toThrow('INVALID_REQUEST');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

// ── usage.ts: row mapping ────────────────────────────────────────────────────

describe('mapAiUsageRequestRow', () => {
  it('coerces wire strings, preserves nulls, converts timestamps', () => {
    const row = mapAiUsageRequestRow({
      id: USAGE_ID,
      org_id: CTX.orgId,
      person_id: CTX.personId,
      request_id: REQUEST_ID,
      capability: 'deal_summary',
      provider: 'mock',
      model: null,
      status: 'SUCCEEDED',
      prompt_tokens: '120',
      completion_tokens: null,
      total_tokens: '200',
      provider_attempts: '2',
      tool_calls_count: '1',
      duration_ms: '1234',
      error_code: null,
      target_entity_type: 'deal',
      target_entity_id: '55555555-5555-4555-8555-555555555555',
      created_at: '2026-10-09T00:00:00.000Z',
      updated_at: '2026-10-09T00:00:01.000Z',
    });
    expect(row.promptTokens).toBe(120);
    expect(row.completionTokens).toBeNull();
    expect(row.totalTokens).toBe(200);
    expect(row.providerAttempts).toBe(2);
    expect(row.model).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});
