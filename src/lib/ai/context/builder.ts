/**
 * Permission-aware context builder — entry point (Phase 9, Workstream D).
 *
 * Contract §7: `buildContext(auth, capability, target)` assembles the ONLY
 * record context a model ever sees. It fetches exclusively through the
 * existing authorized services (recipes.ts), projects hard field allowlists,
 * serializes every record inside `<record_data>` delimiters with escaping
 * (delimit.ts), and enforces the §7.3 size caps deterministically.
 *
 * The builder never widens access: authorization errors from the service
 * layer propagate untouched (an invisible target surfaces as the service's
 * own NOT_FOUND and zero context is produced), and builder-side input
 * problems raise ContextBuildError for the orchestrator to translate to
 * INVALID_REQUEST (§5.4).
 */
import type { Authorization } from '@/lib/authz/require-permission';
import { serializeRecordBlock } from './delimit';
import {
  CAPABILITY_TARGET_TYPES,
  buildActivityContext,
  buildCompanyContext,
  buildContactContext,
  buildDealContext,
  buildGeneralContext,
  buildProjectContext,
  buildTaskContext,
} from './recipes';
import {
  ContextBuildError,
  isAiCapabilityId,
  type AiContextSource,
  type AiContextTarget,
  type BuiltContext,
  type ContextSegment,
  type ContextSegmentKind,
  type RecipeResult,
} from './types';

/** Contract §7.3 size limits — hard constants. */
export const MAX_CONTEXT_CHARS = 24_000;
export const MAX_FIELD_CHARS = 500;
/** Activity bodies share the per-field cap (§7.3 lists both at 500). */
export const MAX_ACTIVITY_BODY_CHARS = 500;

/** Drop order under cap pressure (§7.3: activity lists drop oldest-first;
 * list items and related/meta blocks follow; primary and orientation
 * segments are never dropped — a final hard cut bounds the worst case). */
const DROP_ORDER: readonly ContextSegmentKind[] = ['activity', 'list', 'meta', 'related'];

/**
 * Build the context for one AI request.
 *
 * @param auth        The Authorization from requirePermission('ai.use').
 * @param capability  A contract §6.1 capability id (unknown → ContextBuildError).
 * @param target      The record to summarize; required for every summary
 *                    capability, ignored (never fetched) for general_assistance.
 */
export async function buildContext(
  auth: Authorization,
  capability: string,
  target?: AiContextTarget,
): Promise<BuiltContext> {
  if (!isAiCapabilityId(capability)) {
    throw new ContextBuildError('UNKNOWN_CAPABILITY', `Unknown AI capability: ${capability}`);
  }

  if (capability === 'general_assistance') {
    // §7.2: no pre-fetched records, with or without a target.
    return assemble(buildGeneralContext(auth));
  }

  if (!target) {
    throw new ContextBuildError(
      'TARGET_REQUIRED',
      `Capability ${capability} requires a target record.`,
    );
  }
  if (!CAPABILITY_TARGET_TYPES[capability].includes(target.entityType)) {
    throw new ContextBuildError(
      'CAPABILITY_TARGET_MISMATCH',
      `Capability ${capability} cannot target a ${target.entityType}.`,
    );
  }

  let result: RecipeResult;
  switch (capability) {
    case 'lead_summary':
    case 'deal_summary':
      // A lead is a deal in the NEW stage (§6.1) — same recipe, same target.
      result = await buildDealContext(auth, target.entityId);
      break;
    case 'company_summary':
      result = await buildCompanyContext(auth, target.entityId);
      break;
    case 'contact_summary':
      result = await buildContactContext(auth, target.entityId);
      break;
    case 'activity_summary':
      result = await buildActivityContext(auth, target);
      break;
    case 'project_summary':
      result = await buildProjectContext(auth, target.entityId);
      break;
    case 'task_summary':
      result = await buildTaskContext(auth, target.entityId);
      break;
    default:
      // Unreachable: isAiCapabilityId + the general_assistance branch cover
      // the union; kept as a fail-closed guard against future id additions.
      throw new ContextBuildError('UNKNOWN_CAPABILITY', `Unknown AI capability: ${capability}`);
  }
  return assemble(result);
}

/** Serialize the recipe's segments and enforce the total-size cap. Pure and
 * deterministic: the same segments always produce the same text, the same
 * drops, and the same sources. */
function assemble(result: RecipeResult): BuiltContext {
  const blocks = result.segments.map((segment) => ({
    segment,
    ...serializeRecordBlock(segment, MAX_FIELD_CHARS),
  }));
  let truncated = blocks.some((block) => block.fieldTruncated);

  const joinedLength = () =>
    blocks.reduce((sum, block) => sum + block.text.length, 0) + Math.max(0, blocks.length - 1);

  while (joinedLength() > MAX_CONTEXT_CHARS) {
    const dropIndex = lastDroppableIndex(blocks.map((block) => block.segment));
    if (dropIndex === -1) break;
    blocks.splice(dropIndex, 1);
    truncated = true;
  }

  let text = blocks.map((block) => block.text).join('\n');
  if (text.length > MAX_CONTEXT_CHARS) {
    // Only primary/orientation segments remain and they still exceed the cap
    // (bounded in practice by the per-field caps; this is the hard backstop).
    text = text.slice(0, MAX_CONTEXT_CHARS);
    truncated = true;
  }

  const sources: AiContextSource[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const source = block.segment.source;
    if (!source) continue;
    const key = `${source.entityType}:${source.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
  }

  return { text, sources, recordCount: sources.length, truncated };
}

/** Index of the next segment to drop: the LAST segment of the highest
 * drop-priority kind present (activities are newest-first, so the last
 * activity segment is the oldest — §7.3 drop-oldest-first). */
function lastDroppableIndex(segments: readonly ContextSegment[]): number {
  for (const kind of DROP_ORDER) {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i]?.kind === kind) return i;
    }
  }
  return -1;
}
