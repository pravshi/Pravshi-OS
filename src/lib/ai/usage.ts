/**
 * Phase 9 — AI Foundation: usage metering service (Workstream H).
 * Contract: phase9-contract-review.md §4.1, §8.1, §8.2, §8.3.
 *
 * [TWO-PHASE] One row per orchestrated request in `ai_usage_requests`:
 *             begin inserts it (status STARTED — or LIMITED /
 *             NOT_CONFIGURED for requests that never reach the provider),
 *             finalize updates THE SAME row with the outcome. Provider
 *             retries never create rows; they raise `provider_attempts`
 *             on the single row, so quota is per request, never per
 *             attempt (§8.2 no-double-counting).
 * [CONTENT]   No prompt text, no response text, no record content is
 *             accepted by any function here — the table has no column
 *             that could hold it (§4.1, prompt §11).
 * [CONTEXT]   Every statement runs inside withAuthorizedDb(auth.ctx) as
 *             the requester. org/person come ONLY from auth.ctx — never
 *             from caller input — and every query additionally predicates
 *             on them (defense in depth on top of RLS).
 * [LIMITS]    The mid-request limit check goes through the SECURITY
 *             DEFINER aggregates public.ai_effective_limits /
 *             public.ai_usage_counters (§8.1): it must work for users
 *             holding ai.use but not ai.usage.view, whose RLS SELECT
 *             policy would otherwise hide the rows. ai_effective_limits
 *             returns ONLY the five effective values (defaults already
 *             merged) — never the raw row; ai_usage_counters returns
 *             aggregates only — never another tenant's data. The raw
 *             ai_org_limits row (admin reads/writes, §8.3) is selected
 *             directly from the table under the caller's context, where
 *             the view/manage-gated SELECT policy applies.
 * [RESILIENCE] §8.2: metering is fail-open for the app, fail-closed for
 *             AI. If the STARTED insert fails, beginAiUsageRequest
 *             throws and the AI request is refused (no unmetered AI).
 *             finalize and the LIMITED / NOT_CONFIGURED visibility rows
 *             NEVER throw: a metering failure is logged (Sentry) and the
 *             caller proceeds — metering must never break CRM work.
 */
import * as Sentry from '@sentry/nextjs';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { withAuthorizedDb, type Tx } from '../db/authorized';
import type { Authorization } from '../authz/require-permission';
import {
  AI_LIMIT_DEFAULTS,
  checkLimits,
  resolveEffectiveLimits,
  type AiLimitDecision,
  type AiOrgLimitsRow,
  type AiUsageCounters,
  type EffectiveAiLimits,
} from './limits';

// ── Row + input shapes (§4.1 / §4.2) ─────────────────────────────────────────

export type AiUsageStatus = 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'LIMITED' | 'NOT_CONFIGURED';

/** Target entity types attribution may point at (§4.1). Attribution only — never an authorization input. */
export type AiTargetEntityType = 'company' | 'contact' | 'deal' | 'activity' | 'project' | 'task';

export interface AiUsageRequestRow {
  readonly id: string;
  readonly orgId: string;
  readonly personId: string;
  readonly requestId: string;
  readonly capability: string;
  readonly provider: string;
  readonly model: string | null;
  readonly status: AiUsageStatus;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
  readonly providerAttempts: number;
  readonly toolCallsCount: number;
  readonly durationMs: number | null;
  readonly errorCode: string | null;
  readonly targetEntityType: AiTargetEntityType | null;
  readonly targetEntityId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type AiUsageRequestDbRow = {
  id: string;
  org_id: string;
  person_id: string;
  request_id: string;
  capability: string;
  provider: string;
  model: string | null;
  status: AiUsageStatus;
  prompt_tokens: number | string | null;
  completion_tokens: number | string | null;
  total_tokens: number | string | null;
  provider_attempts: number | string;
  tool_calls_count: number | string;
  duration_ms: number | string | null;
  error_code: string | null;
  target_entity_type: AiTargetEntityType | null;
  target_entity_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type AiOrgLimitsDbRow = {
  org_id: string;
  enabled: boolean;
  monthly_request_limit: number | string | null;
  monthly_token_limit: number | string | null;
  max_requests_per_minute_per_user: number | string | null;
  max_concurrent_requests: number | string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

/** The ai_effective_limits projection: the five effective values only (§8.1). */
type AiEffectiveLimitsDbRow = {
  enabled: boolean;
  monthly_request_limit: number | string | null;
  monthly_token_limit: number | string | null;
  max_requests_per_minute_per_user: number | string | null;
  max_concurrent_requests: number | string | null;
};

type AiUsageCountersDbRow = {
  month_requests: number | string;
  month_tokens: number | string;
  last_minute_requests: number | string;
  in_flight: number | string;
};

/** Aggregates arrive as int8 strings over the wire; counts are never negative. */
function toCount(value: number | string | bigint | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function toNullableCount(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function mapAiUsageRequestRow(row: AiUsageRequestDbRow): AiUsageRequestRow {
  return {
    id: row.id,
    orgId: row.org_id,
    personId: row.person_id,
    requestId: row.request_id,
    capability: row.capability,
    provider: row.provider,
    model: row.model,
    status: row.status,
    promptTokens: toNullableCount(row.prompt_tokens),
    completionTokens: toNullableCount(row.completion_tokens),
    totalTokens: toNullableCount(row.total_tokens),
    providerAttempts: toCount(row.provider_attempts),
    toolCallsCount: toCount(row.tool_calls_count),
    durationMs: toNullableCount(row.duration_ms),
    errorCode: row.error_code,
    targetEntityType: row.target_entity_type,
    targetEntityId: row.target_entity_id,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapAiOrgLimitsRow(row: AiOrgLimitsDbRow): AiOrgLimitsRow {
  return {
    orgId: row.org_id,
    enabled: row.enabled,
    monthlyRequestLimit: toNullableCount(row.monthly_request_limit),
    monthlyTokenLimit: toNullableCount(row.monthly_token_limit),
    maxRequestsPerMinutePerUser: toNullableCount(row.max_requests_per_minute_per_user),
    maxConcurrentRequests: toNullableCount(row.max_concurrent_requests),
    updatedBy: row.updated_by,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapAiUsageCounters(row: AiUsageCountersDbRow): AiUsageCounters {
  return {
    monthRequests: toCount(row.month_requests),
    monthTokens: toCount(row.month_tokens),
    lastMinuteRequests: toCount(row.last_minute_requests),
    inFlight: toCount(row.in_flight),
  };
}

function reportMeteringFailure(error: unknown, extra: Record<string, unknown>): void {
  console.error('[ai] usage metering failure', { ...extra, error });
  Sentry.captureException(error, {
    tags: { source: 'ai-usage' },
    extra,
  });
}

// ── Phase 1: begin ───────────────────────────────────────────────────────────

export interface BeginAiUsageInput {
  /** The app request id (Authorization.requestId); unique per (org, request) by the §4.1 index. */
  readonly requestId: string;
  /** Capability id (§6.1); the table CHECK enforces the set. */
  readonly capability: string;
  /** Provider id ('mock' | 'openai-compatible'). */
  readonly provider: string;
  /** Configured model id; null when never invoked (limited / not configured). */
  readonly model?: string | null;
  readonly targetEntityType?: AiTargetEntityType | null;
  readonly targetEntityId?: string | null;
}

async function insertUsageRow(
  auth: Authorization,
  input: BeginAiUsageInput,
  status: AiUsageStatus,
): Promise<string> {
  const rows = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{ id: string }>(sql`
      insert into public.ai_usage_requests
        (org_id, person_id, request_id, capability, provider, model, status,
         target_entity_type, target_entity_id)
      values
        (${auth.ctx.orgId}::uuid, ${auth.ctx.personId}::uuid, ${input.requestId}::uuid,
         ${input.capability}, ${input.provider}, ${input.model ?? null}, ${status},
         ${input.targetEntityType ?? null}, ${input.targetEntityId ?? null}::uuid)
      returning id
    `),
  );
  const id = rows.rows[0]?.id;
  if (id === undefined) {
    throw new Error('ai usage insert returned no row');
  }
  return id;
}

/**
 * Insert the STARTED row before the provider is invoked (§5.5 step 6).
 * THROWS on failure by design (§8.2): no unmetered AI — the orchestrator
 * refuses the request, and nothing else in the app is affected.
 * Returns the usage row id, which the §4.3 audit entry references.
 */
export async function beginAiUsageRequest(
  auth: Authorization,
  input: BeginAiUsageInput,
): Promise<{ readonly usageId: string }> {
  const usageId = await insertUsageRow(auth, input, 'STARTED');
  return { usageId };
}

/**
 * Insert a terminal visibility row for a request that never reaches the
 * provider: LIMITED (§5.5 step 3) or NOT_CONFIGURED (step 4). These rows
 * are evidence for admins; §8.2's status filters keep them out of every
 * quota counter, so recording them can never amplify a limit. NEVER
 * throws — the 429/503 answer is already decided; returns null when the
 * insert failed (already logged), so the caller can audit without an id.
 */
export async function recordAiUsageOutcome(
  auth: Authorization,
  input: BeginAiUsageInput,
  status: 'LIMITED' | 'NOT_CONFIGURED',
): Promise<{ readonly usageId: string } | null> {
  try {
    const usageId = await insertUsageRow(auth, input, status);
    return { usageId };
  } catch (error) {
    reportMeteringFailure(error, { operation: 'record_outcome', status });
    return null;
  }
}

// ── Phase 2: finalize ────────────────────────────────────────────────────────

export interface FinalizeAiUsageInput {
  readonly usageId: string;
  readonly status: 'SUCCEEDED' | 'FAILED';
  /** Provider-reported counts only; null = not reported, never estimated (§4.1). */
  readonly promptTokens?: number | null;
  readonly completionTokens?: number | null;
  readonly totalTokens?: number | null;
  /** Total provider attempts for this request, retries included — recorded, never re-counted as quota. */
  readonly providerAttempts: number;
  readonly toolCallsCount?: number;
  readonly durationMs: number;
  /** Normalized §3.2 taxonomy code for FAILED; null on success. Never a raw provider error. */
  readonly errorCode?: string | null;
}

/**
 * Update the STARTED row to its final state (§5.5 steps 8–9). NEVER
 * throws (§8.2): on failure the error is logged and false is returned —
 * the caller still delivers the user's summary.
 */
export async function finalizeAiUsageRequest(
  auth: Authorization,
  input: FinalizeAiUsageInput,
): Promise<boolean> {
  try {
    const rows = await withAuthorizedDb(auth.ctx, (tx) =>
      tx.execute<{ id: string }>(sql`
        update public.ai_usage_requests
        set status = ${input.status},
            prompt_tokens = ${input.promptTokens ?? null},
            completion_tokens = ${input.completionTokens ?? null},
            total_tokens = ${input.totalTokens ?? null},
            provider_attempts = ${input.providerAttempts},
            tool_calls_count = ${input.toolCallsCount ?? 0},
            duration_ms = ${input.durationMs},
            error_code = ${input.errorCode ?? null}
        where id = ${input.usageId}::uuid
          and org_id = ${auth.ctx.orgId}::uuid
          and person_id = ${auth.ctx.personId}::uuid
        returning id
      `),
    );
    if (rows.rows.length === 0) {
      reportMeteringFailure(new Error('ai usage finalize matched no row'), {
        operation: 'finalize',
        usageId: input.usageId,
      });
      return false;
    }
    return true;
  } catch (error) {
    reportMeteringFailure(error, { operation: 'finalize', usageId: input.usageId });
    return false;
  }
}

// ── Limits + counters (§8.1 definer reads + §8.3 raw-row reads) ──────────────

/**
 * The org's effective limits from the SECURITY DEFINER projection: the
 * five effective values only, with the §8.2 defaults already merged by
 * the function itself. The NULL fallbacks below are defensive — the
 * definer coalesces every field — and keep older rows/fixtures honest.
 */
async function selectEffectiveLimits(tx: Tx, orgId: string): Promise<EffectiveAiLimits> {
  const rows = await tx.execute<AiEffectiveLimitsDbRow>(sql`
    select enabled, monthly_request_limit, monthly_token_limit,
           max_requests_per_minute_per_user, max_concurrent_requests
    from public.ai_effective_limits(${orgId}::uuid)
  `);
  const row = rows.rows[0];
  if (row === undefined) {
    return resolveEffectiveLimits(null);
  }
  return {
    enabled: row.enabled,
    monthlyRequests:
      toNullableCount(row.monthly_request_limit) ?? AI_LIMIT_DEFAULTS.monthlyRequests,
    monthlyTokens: toNullableCount(row.monthly_token_limit) ?? AI_LIMIT_DEFAULTS.monthlyTokens,
    requestsPerMinutePerUser:
      toNullableCount(row.max_requests_per_minute_per_user) ??
      AI_LIMIT_DEFAULTS.requestsPerMinutePerUser,
    maxConcurrentRequests:
      toNullableCount(row.max_concurrent_requests) ?? AI_LIMIT_DEFAULTS.maxConcurrentRequests,
  };
}

/**
 * The org's raw stored limits row, selected directly from the table
 * under the caller's authorized context. The table's SELECT policy is
 * gated on ai.usage.view, so this is only for the admin paths (§8.3) —
 * the mid-request evaluation must never depend on it. Null when no row
 * is stored (or none is visible to the caller).
 */
async function selectRawLimitsRow(tx: Tx, orgId: string): Promise<AiOrgLimitsRow | null> {
  const rows = await tx.execute<AiOrgLimitsDbRow>(sql`
    select org_id, enabled, monthly_request_limit, monthly_token_limit,
           max_requests_per_minute_per_user, max_concurrent_requests,
           updated_by, created_at, updated_at
    from public.ai_org_limits
    where org_id = ${orgId}::uuid
  `);
  const row = rows.rows[0];
  return row === undefined ? null : mapAiOrgLimitsRow(row);
}

async function selectCounters(tx: Tx, orgId: string, personId: string): Promise<AiUsageCounters> {
  const rows = await tx.execute<AiUsageCountersDbRow>(sql`
    select month_requests, month_tokens, last_minute_requests, in_flight
    from public.ai_usage_counters(${orgId}::uuid, ${personId}::uuid)
  `);
  const row = rows.rows[0];
  return row === undefined
    ? { monthRequests: 0, monthTokens: 0, lastMinuteRequests: 0, inFlight: 0 }
    : mapAiUsageCounters(row);
}

/** The caller's org limits: effective (defaults merged) plus the raw row when one exists (§8.3). */
export async function readAiLimits(auth: Authorization): Promise<{
  readonly effective: EffectiveAiLimits;
  readonly raw: AiOrgLimitsRow | null;
}> {
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const effective = await selectEffectiveLimits(tx, auth.ctx.orgId);
    const raw = await selectRawLimitsRow(tx, auth.ctx.orgId);
    return { effective, raw };
  });
}

/** The caller's current counters (§8.1 aggregates only). */
export async function readAiUsageCounters(auth: Authorization): Promise<AiUsageCounters> {
  return withAuthorizedDb(auth.ctx, (tx) => selectCounters(tx, auth.ctx.orgId, auth.ctx.personId));
}

export interface AiLimitEvaluation {
  readonly decision: AiLimitDecision;
  readonly limits: EffectiveAiLimits;
  readonly rawLimits: AiOrgLimitsRow | null;
  readonly counters: AiUsageCounters;
}

/**
 * §5.5 step 3: resolve the org's limits and judge one prospective
 * request. Effective limits and counters are read in a single
 * transaction so the decision rests on one consistent snapshot. The
 * evaluation path uses the definer projection only — it runs for
 * ai.use holders without ai.usage.view, so `rawLimits` is always null
 * here (the raw row is an admin read, §8.3). A `decision.allowed ===
 * false` result is the typed outcome the orchestrator maps to 429
 * AI_LIMITED (with retryAfterSeconds when set).
 */
export async function evaluateAiLimits(auth: Authorization): Promise<AiLimitEvaluation> {
  const { limits, counters } = await withAuthorizedDb(auth.ctx, async (tx) => {
    const effective = await selectEffectiveLimits(tx, auth.ctx.orgId);
    const countersRow = await selectCounters(tx, auth.ctx.orgId, auth.ctx.personId);
    return { limits: effective, counters: countersRow };
  });
  return { decision: checkLimits(limits, counters), limits, rawLimits: null, counters };
}

// ── Limits administration (§8.3 PUT backing) ─────────────────────────────────

const limitValue = z.number().int().min(0).max(1_000_000_000).nullable();

/**
 * Full-row upsert input for `ai_org_limits`: every field is supplied on
 * every write (an admin settings save), null meaning "use the §8.2
 * default". Authorization (`ai.usage.manage`) is enforced at the route
 * layer and again by the table's RLS policies.
 */
export const AiOrgLimitsInputSchema = z.object({
  enabled: z.boolean(),
  monthlyRequestLimit: limitValue,
  monthlyTokenLimit: limitValue,
  maxRequestsPerMinutePerUser: limitValue,
  maxConcurrentRequests: limitValue,
});
export type AiOrgLimitsInput = z.infer<typeof AiOrgLimitsInputSchema>;

/** Create or replace the caller's org limit row; returns the stored row. */
export async function upsertAiOrgLimits(
  auth: Authorization,
  input: AiOrgLimitsInput,
): Promise<AiOrgLimitsRow> {
  const parsed = AiOrgLimitsInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      'INVALID_REQUEST: AI limits require a boolean enabled flag and non-negative integer caps (or null for the defaults)',
    );
  }
  const value = parsed.data;
  return withAuthorizedDb(auth.ctx, async (tx) => {
    await tx.execute(sql`
      insert into public.ai_org_limits
        (org_id, enabled, monthly_request_limit, monthly_token_limit,
         max_requests_per_minute_per_user, max_concurrent_requests, updated_by)
      values
        (${auth.ctx.orgId}::uuid, ${value.enabled}, ${value.monthlyRequestLimit},
         ${value.monthlyTokenLimit}, ${value.maxRequestsPerMinutePerUser},
         ${value.maxConcurrentRequests}, ${auth.ctx.personId}::uuid)
      on conflict (org_id) do update set
        enabled = excluded.enabled,
        monthly_request_limit = excluded.monthly_request_limit,
        monthly_token_limit = excluded.monthly_token_limit,
        max_requests_per_minute_per_user = excluded.max_requests_per_minute_per_user,
        max_concurrent_requests = excluded.max_concurrent_requests,
        updated_by = excluded.updated_by
    `);
    // Re-read the stored state in the same transaction rather than
    // trusting RETURNING (whose output the table's SELECT policy also
    // gates): the raw row via the direct table select, and the
    // effective projection via the definer — the values the next
    // evaluateAiLimits will judge against.
    const raw = await selectRawLimitsRow(tx, auth.ctx.orgId);
    if (raw === null) {
      throw new Error('ai org limits upsert returned no row');
    }
    await selectEffectiveLimits(tx, auth.ctx.orgId);
    return raw;
  });
}

// ── Usage reporting (§8.3 GET backing) ───────────────────────────────────────

export interface AiUsageSummaryBreakdown {
  readonly key: string;
  readonly requests: number;
  /** Tokens over SUCCEEDED rows only — the same definition the monthly token quota uses (§8.2). */
  readonly totalTokens: number;
}

export interface AiUsageSummary {
  readonly period: string;
  readonly requests: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly limited: number;
  readonly totalTokens: number;
  readonly byCapability: readonly AiUsageSummaryBreakdown[];
  readonly byProvider: readonly AiUsageSummaryBreakdown[];
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function currentUtcMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** [start, end) timestamptz bounds for a 'YYYY-MM' month, UTC (§8.2: org tz is UTC). */
function monthBounds(period: string): { start: string; end: string } {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Monthly aggregates for the caller's org (§8.3). Runs under the
 * requester's context; the table's SELECT policy gates it on
 * ai.usage.view, which the route enforces first. Defaults to the
 * current UTC month; `month` is 'YYYY-MM'.
 */
export async function getAiUsageSummary(
  auth: Authorization,
  month?: string,
): Promise<AiUsageSummary> {
  const period = month ?? currentUtcMonth();
  if (!MONTH_PATTERN.test(period)) {
    throw new Error('INVALID_REQUEST: month must be YYYY-MM');
  }
  const { start, end } = monthBounds(period);
  return withAuthorizedDb(auth.ctx, async (tx) => {
    const totals = await tx.execute<{
      requests: number | string;
      succeeded: number | string;
      failed: number | string;
      limited: number | string;
      total_tokens: number | string;
    }>(sql`
      select count(*)::int as requests,
             count(*) filter (where status = 'SUCCEEDED')::int as succeeded,
             count(*) filter (where status = 'FAILED')::int as failed,
             count(*) filter (where status = 'LIMITED')::int as limited,
             coalesce(sum(total_tokens) filter (where status = 'SUCCEEDED'), 0)::bigint as total_tokens
      from public.ai_usage_requests
      where org_id = ${auth.ctx.orgId}::uuid
        and created_at >= ${start}::timestamptz
        and created_at < ${end}::timestamptz
    `);
    const breakdown = async (
      column: 'capability' | 'provider',
    ): Promise<AiUsageSummaryBreakdown[]> => {
      const grouped = await tx.execute<{
        key: string;
        requests: number | string;
        total_tokens: number | string;
      }>(sql`
        select ${sql.identifier(column)} as key,
               count(*)::int as requests,
               coalesce(sum(total_tokens) filter (where status = 'SUCCEEDED'), 0)::bigint as total_tokens
        from public.ai_usage_requests
        where org_id = ${auth.ctx.orgId}::uuid
          and created_at >= ${start}::timestamptz
          and created_at < ${end}::timestamptz
        group by ${sql.identifier(column)}
        order by key asc
      `);
      return grouped.rows.map((row) => ({
        key: row.key,
        requests: toCount(row.requests),
        totalTokens: toCount(row.total_tokens),
      }));
    };
    const [byCapability, byProvider] = await Promise.all([
      breakdown('capability'),
      breakdown('provider'),
    ]);
    const total = totals.rows[0];
    return {
      period,
      requests: toCount(total?.requests),
      succeeded: toCount(total?.succeeded),
      failed: toCount(total?.failed),
      limited: toCount(total?.limited),
      totalTokens: toCount(total?.total_tokens),
      byCapability,
      byProvider,
    };
  });
}
