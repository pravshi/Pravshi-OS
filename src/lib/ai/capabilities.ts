/**
 * Capability layer (Phase 9, Workstream F — contract §§6.1, 11.3).
 *
 * The eight AI capabilities as a registry the orchestrator calls. This
 * layer owns exactly three things per capability:
 *
 *  1. Its instruction text — appended to the shared system prompt via
 *     `buildSystemPrompt`, i.e. AFTER the instruction-hierarchy clause,
 *     so capability text can narrow the task but can never outrank the
 *     hierarchy (§7.5).
 *  2. Provider-request assembly — system prompt + the built context text
 *     + the user's question (general_assistance only; §5.2 ignores the
 *     question for every other capability). Tools are attached only when
 *     the capability allows them (general_assistance) AND the caller
 *     supplies them — this layer never fetches tool definitions, and it
 *     never lets a summary capability see a tool.
 *  3. Structured-output handling — parse + zod-validate the provider's
 *     JSON against the §5.3 summary shape and reconcile its source
 *     citations with the built context. Any failure is a typed
 *     `AiProviderError('PROVIDER_BAD_RESPONSE')`; there is no partial or
 *     fabricated summary path (§5.5 step 8).
 *
 * Discipline rules this layer enforces:
 *  - No capability fetches data. Context comes only from `buildContext`
 *    (Workstream D), which fetches only through the authorized services.
 *  - No capability executes tools. The orchestrator owns dispatch (§6.2);
 *    a tool-call-only provider result is NOT a summary and fails parsing.
 *  - The model may not invent sources: citations are intersected with the
 *    built context, labels always come from the context, and invented
 *    citations are dropped — never passed through.
 *  - Facts vs recommendations (prompt §9): the output schema has no field
 *    for probability, revenue or close dates, unknown model keys are
 *    stripped by zod, and every capability's instructions repeat the ban.
 */
import type { Authorization } from '@/lib/authz/require-permission';
import { resolveAiConfig } from './config';
import { buildContext, buildSystemPrompt, CAPABILITY_TARGET_TYPES } from './context';
import type {
  AiCapabilityId,
  AiContextEntityType,
  AiContextSource,
  AiContextTarget,
  BuiltContext,
} from './context';
import { isAiCapabilityId } from './context';
import { AiProviderError } from './errors';
import type { AiCompletionRequest, AiCompletionResult, AiToolDefinition } from './provider/types';
import { AiModelOutputSchema, AiSummarySchema, type AiSummary } from './schema';

export { AiSummarySchema, type AiSummary } from './schema';

// ── Input errors ────────────────────────────────────────────────────────────

export type CapabilityInputErrorCode = 'UNKNOWN_CAPABILITY' | 'QUESTION_REQUIRED';

/**
 * A capability-layer input error. Like D's `ContextBuildError`, the
 * orchestrator translates these to the INVALID_REQUEST envelope (§5.4).
 * Authorization failures are never wrapped in this type.
 */
export class CapabilityInputError extends Error {
  readonly code: CapabilityInputErrorCode;

  constructor(code: CapabilityInputErrorCode, message: string) {
    super(message);
    this.name = 'CapabilityInputError';
    this.code = code;
  }
}

// ── Registry (§6.1) ─────────────────────────────────────────────────────────

export interface AiCapabilityDefinition {
  readonly id: AiCapabilityId;
  /** Entity types this capability may target (D's CAPABILITY_TARGET_TYPES —
   * the single source of truth; the context builder enforces the same map). */
  readonly targetEntityTypes: readonly AiContextEntityType[];
  /** Every capability except general_assistance requires a target record. */
  readonly requiresTarget: boolean;
  /** Only general_assistance accepts (and requires) a user question (§5.2). */
  readonly requiresQuestion: boolean;
  /** Per-capability instruction text, appended via buildSystemPrompt (§7.5). */
  readonly instructions: string;
  /** The §5.3 structured-output schema (identical for every capability). */
  readonly outputSchema: typeof AiSummarySchema;
  /** Tools are offered only to general_assistance (§6.1); never to summaries. */
  readonly toolsAllowed: boolean;
}

/**
 * Shared output discipline, appended to every capability's instructions:
 * the exact JSON envelope, the §6.1 bounds, the source-citation rule, and
 * the §9B ban on invented probability / revenue / close dates. Kept as one
 * constant so the discipline cannot drift between capabilities.
 */
const STRUCTURED_OUTPUT_INSTRUCTIONS = [
  'Respond with a single JSON object and nothing else, with exactly these fields:',
  '- "headline": one concise line summarizing the supplied record(s).',
  '- "facts": statements grounded only in the supplied <record_data> records. Quote recorded values exactly as recorded.',
  '- "suggestions": your recommendations, kept strictly separate from facts. Never state a suggestion as a recorded fact.',
  '- "missingInformation": information absent from the supplied records that would be needed; an empty array when nothing material is missing.',
  '- "sources": the records that support the summary, as objects {"entityType": "...", "entityId": "..."} copied from the <record_data> blocks you actually used. Never cite a record that was not supplied.',
  'Limits: every string at most 500 characters; at most 10 entries in each array.',
  'Never invent or estimate probability, revenue, close dates, names, figures or events that are not in the supplied records. A value recorded in the context may be quoted as a recorded fact; do not forecast from it.',
].join('\n');

function defineCapability(id: AiCapabilityId, taskInstructions: string): AiCapabilityDefinition {
  return Object.freeze({
    id,
    targetEntityTypes: CAPABILITY_TARGET_TYPES[id],
    requiresTarget: id !== 'general_assistance',
    requiresQuestion: id === 'general_assistance',
    instructions: `${taskInstructions}\n${STRUCTURED_OUTPUT_INSTRUCTIONS}`,
    outputSchema: AiSummarySchema,
    toolsAllowed: id === 'general_assistance',
  });
}

/** The §6.1 capability registry: id → definition. */
export const AI_CAPABILITIES: Readonly<Record<AiCapabilityId, AiCapabilityDefinition>> =
  Object.freeze({
    lead_summary: defineCapability(
      'lead_summary',
      [
        'You are summarizing a lead. In this system a lead is a deal in the NEW pipeline stage; the supplied context is that deal, its company and contact when recorded, and its recent activity.',
        'Focus on what is known about the lead (company, contact, recorded need and value, stage, recorded activity), what qualification information is MISSING — for example recorded budget, timeline, decision-maker, contact details, or a next scheduled activity; list every material gap in "missingInformation" — and concrete next steps to qualify or follow up, in "suggestions".',
        'Quote the recorded deal value only as a recorded fact; it is not a forecast.',
      ].join('\n'),
    ),
    deal_summary: defineCapability(
      'deal_summary',
      [
        'You are summarizing a deal: its status and stage, its recorded value and expected close date exactly as recorded, the linked company and contact, its recent activity, and any risks that are actually recorded in the supplied fields or activity.',
        'List material gaps in "missingInformation" (for example no recorded activity, no contact, or no expected close date) and put next steps in "suggestions".',
        'Never estimate win probability and never forecast revenue or a close date — the only figures and dates you may state are the ones recorded in the context.',
      ].join('\n'),
    ),
    contact_summary: defineCapability(
      'contact_summary',
      [
        'You are summarizing a contact: who they are (name, title and company as recorded) and their relevant interactions from the supplied activity history.',
        'If there is little or no recorded interaction history, say so in "missingInformation". Put follow-up ideas in "suggestions".',
      ].join('\n'),
    ),
    company_summary: defineCapability(
      'company_summary',
      [
        'You are summarizing a company from the supplied record, its listed contacts, its deals (titles, stages and recorded values only) and its recent activity. Identify the most relevant interactions.',
        'Note material absences in "missingInformation" (for example no contacts, no deals, or no recent activity) and put next steps in "suggestions". Never forecast company revenue or deal outcomes.',
      ].join('\n'),
    ),
    activity_summary: defineCapability(
      'activity_summary',
      [
        "You are summarizing the supplied activity — or, when the target is a company, contact or deal, that record's activity history: what happened, when, and what remains open (for example an activity with a due date or an unresolved follow-up).",
        'Put concrete next actions in "suggestions". You never modify, complete or delete any activity, task or record — you only summarize.',
      ].join('\n'),
    ),
    project_summary: defineCapability(
      'project_summary',
      [
        'You are summarizing a project from the supplied record, its task counts and its listed tasks: overall status, how the work is distributed across task statuses, and notable priorities and due dates as recorded.',
        'Facts must come from the supplied counts and task lines only — do not extrapolate progress percentages beyond what the counts state. Note absences (no tasks, no recorded dates) in "missingInformation" and put next steps in "suggestions".',
      ].join('\n'),
    ),
    task_summary: defineCapability(
      'task_summary',
      [
        'You are summarizing a task: its status, priority, due date and project as recorded, together with its description.',
        'Put next actions in "suggestions". You never modify, reassign, complete or delete the task — you only summarize it.',
      ].join('\n'),
    ),
    general_assistance: defineCapability(
      'general_assistance',
      [
        "Answer the user's question using only the supplied context and, when read-only tools are offered, the records those tools return.",
        'You may call an offered tool to fetch a specific record the question refers to. Never invent record identifiers — use only identifiers the user provided or that appear in the supplied context.',
        'If the information needed is not in the supplied context and no offered tool can supply it, state plainly in "missingInformation" what is unavailable and keep "facts" to what the supplied records support. Never present speculation as a database fact.',
      ].join('\n'),
    ),
  });

export const AI_CAPABILITY_LIST: readonly AiCapabilityDefinition[] = Object.freeze(
  Object.values(AI_CAPABILITIES),
);

/** Registry lookup by (untrusted) id; undefined for anything unknown. */
export function getCapability(id: string): AiCapabilityDefinition | undefined {
  return isAiCapabilityId(id) ? AI_CAPABILITIES[id] : undefined;
}

function requireCapability(id: string): AiCapabilityDefinition {
  const definition = getCapability(id);
  if (!definition) {
    throw new CapabilityInputError('UNKNOWN_CAPABILITY', `Unknown AI capability: ${id}`);
  }
  return definition;
}

/**
 * The full system prompt for a capability: D's hierarchy scaffolding with
 * this registry's instruction text appended last (§7.5) — the instructions
 * narrow the task but structurally cannot outrank the hierarchy clause.
 */
export function getCapabilitySystemPrompt(capability: AiCapabilityId): string {
  return buildSystemPrompt(capability, requireCapability(capability).instructions);
}

// ── Request assembly ────────────────────────────────────────────────────────

export interface AssembleCapabilityRequestOptions {
  /** Output-token cap; defaults to the configured cap (§7.3, default 800). */
  readonly maxOutputTokens?: number;
  /**
   * Provider tool definitions (from the tool registry, Workstream E).
   * Honoured only for capabilities with `toolsAllowed` — definitions passed
   * for a summary capability are dropped, never offered to the model.
   */
  readonly tools?: readonly AiToolDefinition[];
}

const SUMMARY_TASK_LINE =
  'Summarize the supplied records for this capability and answer with the structured JSON summary described in the system prompt.';

/**
 * Assemble the provider request for one capability from an already-built
 * context. Pure: no fetching, no tool execution. The context text is the
 * user-turn content for summary capabilities; for general_assistance the
 * orientation context precedes the user's question in the same message
 * (the deterministic mock scans user messages for both record blocks and
 * tool-trigger phrases, §3.3).
 */
export function assembleCapabilityRequest(
  capability: AiCapabilityId,
  context: BuiltContext,
  question?: string,
  options: AssembleCapabilityRequestOptions = {},
): AiCompletionRequest {
  const definition = requireCapability(capability);

  let userContent: string;
  if (definition.requiresQuestion) {
    const trimmed = question?.trim();
    if (!trimmed) {
      throw new CapabilityInputError(
        'QUESTION_REQUIRED',
        `Capability ${definition.id} requires a question.`,
      );
    }
    userContent = context.text ? `${context.text}\n\nQuestion:\n${trimmed}` : trimmed;
  } else {
    // §5.2: the question is ignored for every summary capability.
    userContent = context.text ? `${SUMMARY_TASK_LINE}\n\n${context.text}` : SUMMARY_TASK_LINE;
  }

  return {
    messages: [
      { role: 'system', content: getCapabilitySystemPrompt(definition.id) },
      { role: 'user', content: userContent },
    ],
    ...(definition.toolsAllowed && options.tools && options.tools.length > 0
      ? { tools: options.tools }
      : {}),
    maxOutputTokens: options.maxOutputTokens ?? resolveAiConfig().maxOutputTokens,
    responseFormat: 'json',
  };
}

export interface PrepareCapabilityRequestInput {
  readonly capability: AiCapabilityId;
  readonly target?: AiContextTarget;
  readonly question?: string;
}

export interface PreparedCapabilityRequest {
  readonly capability: AiCapabilityDefinition;
  /** The built context — the orchestrator reports its `sources` (§5.3) and
   * passes it to parseCapabilityOutput for citation reconciliation. */
  readonly context: BuiltContext;
  readonly request: AiCompletionRequest;
}

/**
 * The one-call seam the orchestrator uses at §5.5 steps 5+7: build the
 * permission-aware context through `buildContext` (the ONLY data path —
 * ContextBuildError and service AuthorizationErrors propagate untouched),
 * then assemble the provider request from it.
 */
export async function prepareCapabilityRequest(
  auth: Authorization,
  input: PrepareCapabilityRequestInput,
  options: AssembleCapabilityRequestOptions = {},
): Promise<PreparedCapabilityRequest> {
  const capability = requireCapability(input.capability);
  const context = await buildContext(auth, capability.id, input.target);
  const request = assembleCapabilityRequest(capability.id, context, input.question, options);
  return { capability, context, request };
}

// ── Structured-output handling (§5.5 step 8) ────────────────────────────────

export interface ParsedCapabilityOutput {
  readonly summary: AiSummary;
  /** Sources that support the summary — always context records, always
   * carrying the context's labels. Safe to report in the §5.3 response. */
  readonly sources: readonly AiContextSource[];
}

/**
 * Validate a provider result into the §5.3 summary + sources.
 *
 * Failure is total and typed: null/empty text (including a tool-call-only
 * result — the orchestrator must continue its tool loop instead),
 * unparseable JSON, or a schema violation all throw
 * `AiProviderError('PROVIDER_BAD_RESPONSE')`. No partial summary exists.
 *
 * Repairs, deliberately narrow and deterministic:
 *  - Absent list fields (`facts` / `suggestions` / `missingInformation`)
 *    are repaired to empty arrays before validation; a field that is
 *    present but wrongly typed fails validation.
 *  - Source citations are reconciled with the built context: a citation
 *    naming a context record is kept (with the context's label, in
 *    context order, de-duplicated); a citation naming anything else is
 *    dropped — the model may not invent sources. When the model cites
 *    nothing (the deterministic mock never cites), the summary is
 *    supported by everything that was supplied: all context sources.
 */
export function parseCapabilityOutput(
  capability: AiCapabilityId,
  result: AiCompletionResult,
  context: BuiltContext,
): ParsedCapabilityOutput {
  requireCapability(capability);

  const text = result.text;
  if (text === null || text.trim() === '') {
    throw new AiProviderError('PROVIDER_BAD_RESPONSE');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AiProviderError('PROVIDER_BAD_RESPONSE');
  }

  const candidate =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? { facts: [], suggestions: [], missingInformation: [], ...(raw as Record<string, unknown>) }
      : raw;

  const parsed = AiModelOutputSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.headline.trim() === '') {
    throw new AiProviderError('PROVIDER_BAD_RESPONSE');
  }

  const summary: AiSummary = {
    headline: parsed.data.headline.trim(),
    facts: parsed.data.facts,
    suggestions: parsed.data.suggestions,
    missingInformation: parsed.data.missingInformation,
  };

  const cited = parsed.data.sources ?? [];
  let sources: readonly AiContextSource[];
  if (cited.length === 0) {
    sources = context.sources;
  } else {
    const citedKeys = new Set(cited.map((source) => `${source.entityType}:${source.entityId}`));
    sources = context.sources.filter((source) =>
      citedKeys.has(`${source.entityType}:${source.entityId}`),
    );
  }

  return { summary, sources };
}
