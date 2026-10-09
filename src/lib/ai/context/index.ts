/**
 * Permission-aware context builder — public surface (Phase 9, Workstream D).
 *
 * Consumers:
 * - Workstream C (orchestrator): buildContext + buildSystemPrompt +
 *   ContextBuildError (translated to INVALID_REQUEST, contract §5.4);
 *   service-layer AuthorizationErrors from buildContext propagate untouched
 *   (NOT_FOUND stays NOT_FOUND, §5.4).
 * - Workstream F (capabilities): buildSystemPrompt(capability, instructions)
 *   — the registry owns the per-capability instruction text, this module
 *   owns the hierarchy scaffolding it is composed into (§7.5).
 * - Workstream E (tools): serializeRecordBlock / escapeRecordText wrap tool
 *   results identically to context records (§7.5), and the project*
 *   projections apply the same field allowlists to tool results (§6.3).
 */
export {
  buildContext,
  MAX_ACTIVITY_BODY_CHARS,
  MAX_CONTEXT_CHARS,
  MAX_FIELD_CHARS,
} from './builder';
export {
  escapeRecordText,
  RECORD_DATA_TAG,
  serializeRecordBlock,
  truncateChars,
  type SerializedBlock,
} from './delimit';
export {
  ACTIVITY_FETCH_LIMIT,
  CAPABILITY_TARGET_TYPES,
  CONTEXT_ALLOWLISTS,
  LIST_FETCH_LIMIT,
  PROJECT_TASK_FETCH_LIMIT,
  PROJECT_TASK_SHOWN_LIMIT,
  projectActivity,
  projectActivityFull,
  projectCompany,
  projectCompanyBrief,
  projectContact,
  projectContactBrief,
  projectDeal,
  projectDealBrief,
  projectProject,
  projectTask,
  projectTaskBrief,
} from './recipes';
export {
  AI_SYSTEM_PROMPT_VERSION,
  buildSystemPrompt,
  INSTRUCTION_HIERARCHY_CLAUSE,
} from './system-prompt';
export {
  AI_CAPABILITY_IDS,
  AI_CONTEXT_ENTITY_TYPES,
  ContextBuildError,
  isAiCapabilityId,
  isAiContextEntityType,
  type AiCapabilityId,
  type AiContextEntityType,
  type AiContextSource,
  type AiContextTarget,
  type BuiltContext,
  type ContextBlockEntityType,
  type ContextBuildErrorCode,
  type ContextSegment,
  type ContextSegmentKind,
  type ProjectedRecord,
  type RecipeResult,
} from './types';
