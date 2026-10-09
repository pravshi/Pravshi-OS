/**
 * Phase 9 — AI Foundation: shared AI types (Workstream C).
 * Contract: phase9-contract-review.md §5.2/§5.3/§5.4, §6.1.
 *
 * This module is the SINGLE canonical declaration of the capability-id union
 * (§6.1). Every other module — the context builder included — imports or
 * re-exports these ids from here; no second declaration may exist (the
 * Wave-1 reconciliation of Workstream D's interim copy in context/types.ts).
 *
 * It also declares the wire shapes the API route (Workstream G) consumes:
 * the raw assist input, the §5.3 success body, and the typed outcome union
 * `runAiRequest` returns. The route maps each outcome kind to its §5.4
 * envelope row; nothing in this module knows about HTTP.
 */
import type { AiUsageMetadata } from './provider/types';

// ── Capability ids (§6.1) ────────────────────────────────────────────────────

/** Capability ids, contract §6.1. A "lead" is a deal in the NEW pipeline
 * stage (src/lib/analytics/crm.ts) — `lead_summary` therefore targets a deal. */
export const AI_CAPABILITY_IDS = [
  'lead_summary',
  'deal_summary',
  'contact_summary',
  'company_summary',
  'activity_summary',
  'project_summary',
  'task_summary',
  'general_assistance',
] as const;
export type AiCapabilityId = (typeof AI_CAPABILITY_IDS)[number];

export function isAiCapabilityId(value: string): value is AiCapabilityId {
  return (AI_CAPABILITY_IDS as readonly string[]).includes(value);
}

// ── Target entity types (§5.2) ───────────────────────────────────────────────

export const AI_TARGET_ENTITY_TYPES = [
  'company',
  'contact',
  'deal',
  'activity',
  'project',
  'task',
] as const;
export type AiTargetEntityType = (typeof AI_TARGET_ENTITY_TYPES)[number];

export function isAiTargetEntityType(value: string): value is AiTargetEntityType {
  return (AI_TARGET_ENTITY_TYPES as readonly string[]).includes(value);
}

// ── Request input (§5.2, as accepted by runAiRequest) ────────────────────────

/** A record reference supplied by the client. Untrusted until the service
 * layer has authorized it — the orchestrator validates shape only. */
export interface AiTargetInput {
  readonly entityType: string;
  readonly entityId: string;
}

/**
 * The assist request as the orchestrator accepts it. The route validates the
 * body with zod first (§5.2); the orchestrator re-validates defensively so
 * its lifecycle never runs on an unvalidated capability or target shape.
 */
export interface AiAssistInput {
  readonly capability: string;
  readonly target?: AiTargetInput;
  /** Required for `general_assistance` (max 2,000 chars); ignored otherwise. */
  readonly question?: string;
}

// ── Structured output (§5.3) ─────────────────────────────────────────────────

/**
 * The §5.3 structured summary — every capability's output shape (§6.1).
 * Facts and suggestions are structurally separated; the schema has no field
 * that could hold invented probability, revenue or close dates (§9B).
 */
export interface AiSummary {
  readonly headline: string;
  readonly facts: readonly string[];
  readonly suggestions: readonly string[];
  readonly missingInformation: readonly string[];
}

/** One record that supports the summary (§5.3 `sources`). */
export interface AiSummarySource {
  readonly entityType: AiTargetEntityType;
  readonly entityId: string;
  readonly label: string;
}

/** The §5.3 success body — returned as resource JSON directly (HTTP 200). */
export interface AiAssistSuccess {
  readonly requestId: string;
  readonly capability: AiCapabilityId;
  readonly status: 'ok';
  readonly summary: AiSummary;
  readonly sources: readonly AiSummarySource[];
  readonly usage: {
    readonly provider: string;
    readonly model: string;
    /** Provider-reported total for the whole request; null = never reported. */
    readonly totalTokens: number | null;
  };
}

// ── Orchestrator outcome (mapped by the route to §5.4) ───────────────────────

/**
 * The typed result of `runAiRequest` — the shape the API route (Workstream
 * G) consumes, reconciled at integration with the route's declared contract:
 *   status 'ok'              → 200, the AiAssistSuccess body verbatim (§5.3)
 *   status 'limited'         → 429 AI_LIMITED (+ retryAfterSeconds when set)
 *   status 'not_configured'  → 503 AI_NOT_CONFIGURED
 *   status 'provider_failed' → 502 AI_PROVIDER_FAILED
 * The §3.2 taxonomy code and the limit reason stay server-side, exactly as
 * §5.4 prescribes: the code is recorded on the usage row, and neither ever
 * reaches the client envelope.
 *
 * Two failure channels are NOT outcomes, by contract:
 *  - Input failures (unknown capability, target mismatch, missing/oversized
 *    question) throw `Error('INVALID_REQUEST: …')` — the repo's service
 *    convention (see usage.ts) — which the route renders as 400.
 *  - Authorization failures of the target record: the service layer's
 *    AuthorizationError (NOT_FOUND / FORBIDDEN) propagates out of
 *    `runAiRequest` untouched (§5.4/§5.5 step 5) and the route's standard
 *    authz handling renders it — existence is never converted into a summary.
 */
export type AiRequestOutcome =
  | AiAssistSuccess
  | { readonly status: 'not_configured'; readonly requestId: string }
  | {
      readonly status: 'limited';
      readonly requestId: string;
      readonly retryAfterSeconds: number | null;
    }
  | { readonly status: 'provider_failed'; readonly requestId: string };

/** Provider usage accumulated across every completion round of one request. */
export type AiRequestUsage = AiUsageMetadata;
