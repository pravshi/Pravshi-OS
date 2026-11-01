/**
 * Phase 9 — AI Foundation: limit constants + the pure limit decision
 * (Workstream H). Contract: phase9-contract-review.md §8.1/§8.2.
 *
 * [DESIGN] This module is deliberately pure: no database access, no clock
 *          reads. The counters it judges come from the SECURITY DEFINER
 *          aggregate `public.ai_usage_counters` (migration 0054) via
 *          usage.ts, and the effective limits come from
 *          `public.ai_effective_limits` merged over the defaults below.
 *          Keeping the decision pure makes the §8.2 counting rules
 *          unit-testable without a database (tests/ai/limits.test.ts).
 * [RULES]  §8.2, verbatim:
 *          - check order: enabled → concurrency → per-minute →
 *            monthly requests → monthly tokens; first failure wins.
 *          - retryAfterSeconds is 60 for the per-minute limit, else null.
 *          - a LIMITED or NOT_CONFIGURED outcome never consumes quota —
 *            that is enforced by the status filters inside the counter
 *            aggregates (§8.1), not here; this module only compares.
 *          - provider retries never double-count: quota is per request
 *            row, and retries only raise provider_attempts on that row
 *            (usage.ts finalize).
 */

/** §8.2 defaults, applied wherever an `ai_org_limits` field is NULL (or no row exists). */
export const AI_LIMIT_DEFAULTS = {
  /** Monthly requests per org — rows in the current calendar month (UTC) with status SUCCEEDED or FAILED. */
  monthlyRequests: 5_000,
  /** Monthly tokens per org — sum(total_tokens) over SUCCEEDED rows in the current month; NULL counts 0, never invented. */
  monthlyTokens: 2_000_000,
  /** Requests per minute per user — the caller's rows in the trailing 60s, status ≠ LIMITED. */
  requestsPerMinutePerUser: 10,
  /** Concurrent requests per org — STARTED rows created within the last 5 minutes (stale rows age out). */
  maxConcurrentRequests: 4,
} as const;

/**
 * One `ai_org_limits` row as stored (§4.2). Every limit field is nullable:
 * NULL means "use the §8.2 code default". Absence of a row is represented
 * by `null` for the whole object and means the same thing.
 */
export interface AiOrgLimitsRow {
  readonly orgId: string;
  /** The org kill switch. false → every request is LIMITED with reason 'disabled'. */
  readonly enabled: boolean;
  readonly monthlyRequestLimit: number | null;
  readonly monthlyTokenLimit: number | null;
  readonly maxRequestsPerMinutePerUser: number | null;
  readonly maxConcurrentRequests: number | null;
  readonly updatedBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The limits a request is actually judged against: row values with defaults merged in. */
export interface EffectiveAiLimits {
  readonly enabled: boolean;
  readonly monthlyRequests: number;
  readonly monthlyTokens: number;
  readonly requestsPerMinutePerUser: number;
  readonly maxConcurrentRequests: number;
}

/**
 * Aggregates from `public.ai_usage_counters` (§8.1). Aggregates only — the
 * definer function never exposes row-level data, and the counting windows
 * (calendar month UTC, trailing 60s, STARTED within 5 minutes) live in
 * its definition, per §8.2's "Counted from" column.
 */
export interface AiUsageCounters {
  /** Current-month rows with status SUCCEEDED or FAILED. */
  readonly monthRequests: number;
  /** sum(total_tokens) over current-month SUCCEEDED rows; unreported tokens count 0. */
  readonly monthTokens: number;
  /** The caller's rows in the trailing 60s, status ≠ LIMITED. */
  readonly lastMinuteRequests: number;
  /** STARTED rows within the last 5 minutes, org-wide. */
  readonly inFlight: number;
}

/** Why a request was limited. `disabled` is the `enabled = false` kill switch (§8.2). */
export type AiLimitReason =
  'disabled' | 'concurrency' | 'rate' | 'monthly_requests' | 'monthly_tokens';

/**
 * The typed outcome the orchestrator maps to the §5.4 envelope:
 * `allowed: false` → HTTP 429 `AI_LIMITED`, with `retryAfterSeconds`
 * included in the error object when non-null.
 */
export type AiLimitDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: AiLimitReason;
      readonly retryAfterSeconds: number | null;
    };

/** Merge a stored row (or its absence) over the §8.2 defaults. */
export function resolveEffectiveLimits(row: AiOrgLimitsRow | null): EffectiveAiLimits {
  return {
    enabled: row?.enabled ?? true,
    monthlyRequests: row?.monthlyRequestLimit ?? AI_LIMIT_DEFAULTS.monthlyRequests,
    monthlyTokens: row?.monthlyTokenLimit ?? AI_LIMIT_DEFAULTS.monthlyTokens,
    requestsPerMinutePerUser:
      row?.maxRequestsPerMinutePerUser ?? AI_LIMIT_DEFAULTS.requestsPerMinutePerUser,
    maxConcurrentRequests: row?.maxConcurrentRequests ?? AI_LIMIT_DEFAULTS.maxConcurrentRequests,
  };
}

/**
 * Judge one prospective request against the effective limits and the
 * current counters. A counter that has REACHED its limit refuses the
 * request (the new request would exceed it). Check order is §8.2's:
 * enabled → concurrency → per-minute → monthly requests → monthly tokens.
 */
export function checkLimits(limits: EffectiveAiLimits, counters: AiUsageCounters): AiLimitDecision {
  if (!limits.enabled) {
    return { allowed: false, reason: 'disabled', retryAfterSeconds: null };
  }
  if (counters.inFlight >= limits.maxConcurrentRequests) {
    return { allowed: false, reason: 'concurrency', retryAfterSeconds: null };
  }
  if (counters.lastMinuteRequests >= limits.requestsPerMinutePerUser) {
    // The window is a trailing 60s, so a full minute is always a safe retry hint.
    return { allowed: false, reason: 'rate', retryAfterSeconds: 60 };
  }
  if (counters.monthRequests >= limits.monthlyRequests) {
    return { allowed: false, reason: 'monthly_requests', retryAfterSeconds: null };
  }
  if (counters.monthTokens >= limits.monthlyTokens) {
    return { allowed: false, reason: 'monthly_tokens', retryAfterSeconds: null };
  }
  return { allowed: true };
}
