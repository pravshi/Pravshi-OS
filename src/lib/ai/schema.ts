/**
 * AI zod schemas (Phase 9, Workstream F — contract §11.3).
 *
 * Two families live here:
 *
 *  1. The API input schema for `POST /api/ai/assist` (contract §5.2):
 *     a strict object — unknown keys are rejected, the question is capped
 *     at 2,000 chars, and capability/target values come from the context
 *     module's id unions so the schema can never drift from the builder.
 *
 *  2. The structured-output schemas (contract §§5.3, 6.1): the summary
 *     shape every capability returns, and the model-output envelope the
 *     capability layer validates provider text against. The summary shape
 *     structurally separates facts from suggestions and has NO field that
 *     could hold an invented probability, revenue figure or close date
 *     (prompt §9B) — and because these are plain `z.object` schemas,
 *     unknown keys a model adds are stripped, never passed through.
 *
 * Bounds (§6.1): every summary string ≤ 500 chars, every list ≤ 10 items.
 */
import { z } from 'zod';
import { AI_CAPABILITY_IDS, AI_CONTEXT_ENTITY_TYPES } from './context/types';

/** Contract §6.1: no summary string exceeds 500 characters. */
export const AI_SUMMARY_MAX_STRING_CHARS = 500;
/** Contract §6.1: no summary list exceeds 10 entries. */
export const AI_SUMMARY_MAX_ITEMS = 10;
/** Contract §5.2: the user question is capped at 2,000 characters. */
export const AI_QUESTION_MAX_CHARS = 2_000;
/** Defensive cap on model-cited sources; the capability layer intersects
 * citations with the built context, so the output is bounded regardless. */
export const AI_MODEL_SOURCES_MAX_ITEMS = 100;

// ── API input (§5.2) ────────────────────────────────────────────────────────

export const AiAssistTargetSchema = z.strictObject({
  entityType: z.enum(AI_CONTEXT_ENTITY_TYPES),
  entityId: z.uuid(),
});

export const AiAssistRequestSchema = z.strictObject({
  capability: z.enum(AI_CAPABILITY_IDS),
  target: AiAssistTargetSchema.optional(),
  question: z.string().max(AI_QUESTION_MAX_CHARS).optional(),
});

export type AiAssistTargetInput = z.infer<typeof AiAssistTargetSchema>;
export type AiAssistRequestInput = z.infer<typeof AiAssistRequestSchema>;

// ── Structured output (§§5.3, 6.1) ──────────────────────────────────────────

const summaryString = z.string().max(AI_SUMMARY_MAX_STRING_CHARS);
const summaryList = z.array(summaryString).max(AI_SUMMARY_MAX_ITEMS);

/**
 * The §5.3 summary shape — the response contract for every capability.
 * `facts` are statements grounded in the supplied records; `suggestions`
 * are AI recommendations and are ALWAYS a separate list (prompt §9);
 * `missingInformation` names what the records did not contain.
 */
export const AiSummarySchema = z.object({
  headline: summaryString,
  facts: summaryList,
  suggestions: summaryList,
  missingInformation: summaryList,
});

export type AiSummary = z.infer<typeof AiSummarySchema>;

/**
 * One source citation as a model may return it: the entity type and id
 * copied from a `<record_data>` block. The label is deliberately NOT part
 * of this schema — labels are taken from the built context, never trusted
 * from the model (see parseCapabilityOutput in capabilities.ts).
 */
export const AiModelSourceSchema = z.object({
  entityType: z.enum(AI_CONTEXT_ENTITY_TYPES),
  entityId: z.string().min(1).max(64),
});

export type AiModelSource = z.infer<typeof AiModelSourceSchema>;

/**
 * What a provider's JSON text must validate against: the summary shape
 * plus the model's optional source citations. Validation failure maps to
 * `PROVIDER_BAD_RESPONSE` (contract §5.5 step 8) — no partial or
 * fabricated summary is ever produced from an invalid payload.
 */
export const AiModelOutputSchema = AiSummarySchema.extend({
  sources: z.array(AiModelSourceSchema).max(AI_MODEL_SOURCES_MAX_ITEMS).optional(),
});

export type AiModelOutput = z.infer<typeof AiModelOutputSchema>;
