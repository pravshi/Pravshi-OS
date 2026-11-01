/**
 * Permission-aware context builder — shared types (Phase 9, Workstream D).
 *
 * Contract: phase9-contract-review.md §6.1 (capability ids), §7 (context builder).
 * The capability id union is declared ONCE, canonically, in src/lib/ai/types.ts
 * (Workstream C) and re-exported below — this module never re-declares it
 * (Wave-1 reconciliation, Lead integration notes).
 */

export { AI_CAPABILITY_IDS, isAiCapabilityId, type AiCapabilityId } from '../types';

/** Record types a capability may target (contract §5.2). */
export const AI_CONTEXT_ENTITY_TYPES = [
  'company',
  'contact',
  'deal',
  'activity',
  'project',
  'task',
] as const;
export type AiContextEntityType = (typeof AI_CONTEXT_ENTITY_TYPES)[number];

export function isAiContextEntityType(value: string): value is AiContextEntityType {
  return (AI_CONTEXT_ENTITY_TYPES as readonly string[]).includes(value);
}

/** A server-side record reference. The id is untrusted client input until the
 * service layer has authorized it — the builder never trusts it on its own. */
export interface AiContextTarget {
  readonly entityType: AiContextEntityType;
  readonly entityId: string;
}

/** One record that supports the summary (contract §5.3 `sources`). */
export interface AiContextSource {
  readonly entityType: AiContextEntityType;
  readonly entityId: string;
  readonly label: string;
}

/** Entity names that may appear on a serialized block. Beyond the six record
 * types there are two synthetic blocks: the project task counts and the
 * general-assistance session orientation. Neither carries record data. */
export type ContextBlockEntityType = AiContextEntityType | 'project_task_counts' | 'session';

/** One projected record: allowlisted fields only, as ordered key/value lines.
 * Values are raw at this stage — escaping and size caps happen at
 * serialization time in the builder (delimit.ts / builder.ts). */
export interface ProjectedRecord {
  readonly entityType: ContextBlockEntityType;
  readonly entityId?: string;
  readonly label: string;
  readonly fields: readonly (readonly [string, string])[];
}

/** How a segment participates in cap enforcement (builder.ts): activities are
 * dropped oldest-first, then list items, then related/meta blocks. Primary
 * and orientation segments are never dropped (hard truncation is the last
 * resort and is reported via BuiltContext.truncated). */
export type ContextSegmentKind =
  'primary' | 'related' | 'list' | 'activity' | 'meta' | 'orientation';

export interface ContextSegment extends ProjectedRecord {
  readonly kind: ContextSegmentKind;
  /** The source record this segment represents, when it carries one. Sources
   * ride on the segments (not a side list) so cap enforcement in the builder
   * can keep `BuiltContext.sources` exactly consistent with the surviving
   * text: a dropped segment's record no longer supports the summary. */
  readonly source?: AiContextSource;
}

/** What a recipe returns: the ordered segments. The builder derives
 * `BuiltContext.sources` from the segments that survive serialization. */
export interface RecipeResult {
  readonly segments: readonly ContextSegment[];
}

/** The builder's output: the serialized, delimited, size-capped context text
 * plus the source records the orchestrator reports in its response (§5.3). */
export interface BuiltContext {
  readonly text: string;
  readonly sources: readonly AiContextSource[];
  /** Number of records represented in `sources`. */
  readonly recordCount: number;
  /** True when any field was shortened or any segment dropped / hard-cut to
   * honour the size caps (§7.3). Silent by design — surfaced here only for
   * logging, never as a user-facing "missing information" claim. */
  readonly truncated: boolean;
}

export type ContextBuildErrorCode =
  'UNKNOWN_CAPABILITY' | 'TARGET_REQUIRED' | 'CAPABILITY_TARGET_MISMATCH';

/**
 * A builder-side input error. The orchestrator translates these to the
 * INVALID_REQUEST envelope (contract §5.4). Authorization failures from the
 * service layer are NEVER wrapped in this type — they propagate as the
 * service's own AuthorizationError so NOT_FOUND/FORBIDDEN semantics survive.
 */
export class ContextBuildError extends Error {
  readonly code: ContextBuildErrorCode;

  constructor(code: ContextBuildErrorCode, message: string) {
    super(message);
    this.name = 'ContextBuildError';
    this.code = code;
  }
}
