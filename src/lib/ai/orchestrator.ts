/**
 * Phase 9 — AI Foundation: the AI request orchestrator (Workstream C).
 * Contract: phase9-contract-review.md §5.5 (lifecycle), §5.4 (error mapping),
 * §3.5 (deadline), §4.3 (audit), §6.2 (tool dispatch), §8.2 (metering rules);
 * master prompt §6.
 *
 * `runAiRequest` is the only path from the API route to a provider. The
 * lifecycle runs in the §5.5 order and every step fails in the §5.4 direction:
 *
 *   1. Validate capability + target shape + question (the route has already
 *      authorized `ai.use` via withPermission and zod-validated the body;
 *      this re-validation is defensive). Input failures throw
 *      `Error('INVALID_REQUEST: …')` — the repo's service convention (see
 *      usage.ts) — which the route renders as the 400 envelope.
 *   2. evaluateAiLimits — denied → recordAiUsageOutcome(LIMITED) + audit →
 *      `limited` outcome (429 semantics; a LIMITED row never consumes
 *      quota, §8.2).
 *   3. Provider resolution — the not-configured stub → recordAiUsageOutcome
 *      (NOT_CONFIGURED) + audit → `not_configured` outcome (503 semantics).
 *      Checked before context building: never fetch records for a request
 *      that cannot run.
 *   4. prepareCapabilityRequest (Workstream F's seam: buildContext through
 *      the services + request assembly). AuthorizationError (NOT_FOUND /
 *      FORBIDDEN) propagates UNTOUCHED — an invisible record is never
 *      converted into an empty summary, and no usage row is written for a
 *      request never authorized to see its target (§5.5 step 5).
 *      ContextBuildError / CapabilityInputError are input failures →
 *      INVALID_REQUEST throws.
 *   5. beginAiUsageRequest inserts the STARTED row. It THROWS on failure
 *      and the throw propagates: no unmetered AI (§8.2 fail-closed), and
 *      the provider is never invoked.
 *   6. Provider execution under ONE AbortController deadline
 *      (AI_TIMEOUT_MS). The adapter owns its bounded retry policy (§3.5);
 *      the orchestrator adds no retries of its own. Tool loop: tools are
 *      offered only when the capability allows them (V1: general_assistance
 *      only), at most MAX_TOOL_CALLS dispatches, every dispatch through
 *      Workstream E's dispatcher (never throws), results fed back as tool
 *      messages wrapped in <record_data> (§7.5). When the budget is spent
 *      the model gets one final tool-less call to answer from what it has.
 *   7. parseCapabilityOutput (F) validates the model's JSON against the
 *      §5.3 schema and reconciles its source citations with the built
 *      context (invented citations are dropped). Failure finalizes the
 *      row FAILED / PROVIDER_BAD_RESPONSE.
 *   8. finalizeAiUsageRequest (never throws — a metering failure never
 *      breaks the user's answer, §8.2), one audit entry (§4.3, flat
 *      metadata only), and the typed outcome the route maps to §5.4.
 *
 * Provider attempts: the §3.1 completion result carries no attempt count —
 * the adapter retries internally (§3.5) — so `providerAttempts` records
 * the number of complete() invocations the orchestrator itself made (one
 * per round). Noted for integration reconciliation.
 */
import { writeAuditEntry, type RequestMetadata } from '@/lib/audit/log';
import type { Authorization } from '@/lib/authz/require-permission';
import {
  CapabilityInputError,
  getCapability,
  parseCapabilityOutput,
  prepareCapabilityRequest,
  type AiCapabilityDefinition,
  type ParsedCapabilityOutput,
} from './capabilities';
import { resolveAiConfig } from './config';
import { ContextBuildError, escapeRecordText, type AiContextTarget } from './context';
import { isAiProviderError, type AiErrorCode } from './errors';
import { getAiProvider } from './provider';
import type {
  AiCompletionResult,
  AiMessage,
  AiToolDefinition,
  AiUsageMetadata,
} from './provider/types';
import { toolRegistry } from './tools/crm-tools';
import { dispatchToolCall, listProviderToolDefinitions, toModelToolResult } from './tools/registry';
import { isAiTargetEntityType, type AiAssistInput, type AiRequestOutcome } from './types';
import {
  beginAiUsageRequest,
  evaluateAiLimits,
  finalizeAiUsageRequest,
  recordAiUsageOutcome,
  type BeginAiUsageInput,
} from './usage';

/** §5.5 step 7: at most 3 dispatched tool calls per request. No loop beyond that. */
export const AI_MAX_TOOL_CALLS = 3;

/** §5.2: the general_assistance question bound. */
const MAX_QUESTION_CHARS = 2_000;

/** §5.2: entity ids are uuids (the services re-validate; shape only here). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidRequest(message: string): Error {
  return new Error(`INVALID_REQUEST: ${message}`);
}

// ── Input validation (§5.5 step 2) ───────────────────────────────────────────

interface ValidatedInput {
  readonly definition: AiCapabilityDefinition;
  readonly target: AiContextTarget | undefined;
  readonly question: string | undefined;
}

function validateInput(input: AiAssistInput): ValidatedInput {
  if (typeof input.capability !== 'string') {
    throw invalidRequest('Unknown AI capability.');
  }
  const definition = getCapability(input.capability);
  if (!definition) {
    throw invalidRequest('Unknown AI capability.');
  }

  let target: AiContextTarget | undefined;
  if (input.target !== undefined) {
    const { entityType, entityId } = input.target;
    if (!isAiTargetEntityType(entityType) || !UUID_PATTERN.test(entityId)) {
      throw invalidRequest('The target record reference is malformed.');
    }
    if (!definition.targetEntityTypes.includes(entityType)) {
      throw invalidRequest(`Capability ${definition.id} cannot target a ${entityType} record.`);
    }
    target = { entityType, entityId };
  }
  if (definition.requiresTarget && !target) {
    throw invalidRequest(`Capability ${definition.id} requires a target record.`);
  }

  if (definition.requiresQuestion) {
    if (typeof input.question !== 'string' || input.question.trim().length === 0) {
      throw invalidRequest('A question is required for general assistance.');
    }
    if (input.question.length > MAX_QUESTION_CHARS) {
      throw invalidRequest(`The question exceeds the ${MAX_QUESTION_CHARS}-character limit.`);
    }
    return { definition, target, question: input.question };
  }

  // `question` is ignored for summary capabilities (§5.2).
  return { definition, target, question: undefined };
}

// ── Audit (§4.3 — one entry per orchestrated request, flat metadata only) ────

interface AuditFields {
  readonly usageId: string | null;
  readonly capability: string;
  readonly provider: string;
  readonly model: string | null;
  readonly status: 'SUCCEEDED' | 'FAILED' | 'LIMITED' | 'NOT_CONFIGURED';
  readonly totalTokens: number | null;
  readonly durationMs: number;
}

async function auditAiRequest(auth: Authorization, meta: RequestMetadata, fields: AuditFields) {
  const failed = fields.status !== 'SUCCEEDED';
  try {
    await writeAuditEntry(
      auth.ctx,
      {
        action: 'ai.request',
        entityType: 'ai_request',
        entityId: fields.usageId,
        result: failed ? 'ERROR' : 'SUCCESS',
        severity: failed ? 'MEDIUM' : 'LOW',
        metadata: {
          capability: fields.capability,
          provider: fields.provider,
          model: fields.model,
          status: fields.status,
          totalTokens: fields.totalTokens,
          durationMs: fields.durationMs,
        },
      },
      meta,
    );
  } catch (error) {
    // Audit is evidence, not a gate: a failed audit write never changes the
    // request's outcome (the metering rules of §8.2 set the same precedent).
    console.error('[ai] audit write failed', {
      capability: fields.capability,
      status: fields.status,
      error,
    });
  }
}

// ── Usage accumulation across completion rounds ──────────────────────────────

function accumulateUsage(total: AiUsageMetadata, round: AiUsageMetadata): AiUsageMetadata {
  const add = (a: number | null, b: number | null): number | null =>
    a === null ? b : b === null ? a : a + b;
  return {
    promptTokens: add(total.promptTokens, round.promptTokens),
    completionTokens: add(total.completionTokens, round.completionTokens),
    totalTokens: add(total.totalTokens, round.totalTokens),
  };
}

function effectiveTotalTokens(usage: AiUsageMetadata): number | null {
  if (usage.totalTokens !== null) return usage.totalTokens;
  if (usage.promptTokens !== null && usage.completionTokens !== null) {
    return usage.promptTokens + usage.completionTokens;
  }
  return null;
}

// ── Tool result feedback (§7.5: wrapped identically to record data) ──────────

function toolResultContent(toolName: string, value: unknown): string {
  const serialized = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  const toolAttribute = escapeRecordText(toolName).replace(/"/g, '&quot;');
  return [
    `<record_data entity="tool_result" tool="${toolAttribute}">`,
    escapeRecordText(serialized),
    '</record_data>',
  ].join('\n');
}

// ── Provider execution with the bounded tool loop (§5.5 step 7) ──────────────

interface ExecutionProgress {
  readonly usage: AiUsageMetadata;
  readonly attempts: number;
  readonly toolCallsCount: number;
}

type ExecutionOutcome =
  | ({ readonly ok: true; readonly result: AiCompletionResult } & ExecutionProgress)
  | ({ readonly ok: false; readonly errorCode: AiErrorCode } & ExecutionProgress);

async function executeWithTools(
  provider: ReturnType<typeof getAiProvider>,
  auth: Authorization,
  initialMessages: readonly AiMessage[],
  initialTools: readonly AiToolDefinition[] | undefined,
  maxOutputTokens: number,
  signal: AbortSignal,
): Promise<ExecutionOutcome> {
  const messages: AiMessage[] = [...initialMessages];
  let offeredTools = initialTools;
  let usage: AiUsageMetadata = { promptTokens: null, completionTokens: null, totalTokens: null };
  let attempts = 0;
  let toolCallsCount = 0;
  let finalAnswerOnly = false;

  for (;;) {
    attempts += 1;
    let result: AiCompletionResult;
    try {
      result = await provider.complete(
        {
          messages,
          ...(offeredTools !== undefined ? { tools: offeredTools } : {}),
          maxOutputTokens,
          responseFormat: 'json',
        },
        signal,
      );
    } catch (error) {
      // Only the normalized code may travel from here (§3.2); a non-taxonomy
      // throw is logged by provider id only and normalized.
      if (!isAiProviderError(error)) {
        console.error('[ai] provider threw a non-taxonomy error', { provider: provider.id });
      }
      return {
        ok: false,
        errorCode: isAiProviderError(error) ? error.code : 'PROVIDER_UNAVAILABLE',
        usage,
        attempts,
        toolCallsCount,
      };
    }
    usage = accumulateUsage(usage, result.usage);

    if (result.toolCalls.length === 0 || offeredTools === undefined || finalAnswerOnly) {
      // Done — or the provider asked for tools it cannot have (none offered,
      // or the budget is spent): the text (if any) is the answer, and output
      // validation below decides whether it is a usable one.
      return { ok: true, result, usage, attempts, toolCallsCount };
    }

    const remaining = AI_MAX_TOOL_CALLS - toolCallsCount;
    const batch = result.toolCalls.slice(0, Math.max(remaining, 0));
    messages.push({ role: 'assistant', content: result.text ?? '' });
    for (const call of batch) {
      const dispatch = await dispatchToolCall(toolRegistry, auth, call.name, call.arguments, {
        signal,
        onExecuted: () => {
          toolCallsCount += 1;
        },
      });
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: toolResultContent(call.name, toModelToolResult(dispatch)),
      });
    }
    if (toolCallsCount >= AI_MAX_TOOL_CALLS) {
      // Budget spent: one final call with no tools offered, so the model
      // answers from what it already has. The loop then returns above.
      offeredTools = undefined;
      finalAnswerOnly = true;
    }
  }
}

// ── The lifecycle (§5.5) ─────────────────────────────────────────────────────

export async function runAiRequest(
  auth: Authorization,
  input: AiAssistInput,
  meta: RequestMetadata = auth.meta,
): Promise<AiRequestOutcome> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const requestId = meta.requestId;

  // Step 2 (route step 1 already authorized `ai.use`): validate the request.
  const { definition, target, question } = validateInput(input);
  const capabilityId = definition.id;

  const targetAttribution: Pick<BeginAiUsageInput, 'targetEntityType' | 'targetEntityId'> = {
    targetEntityType: target?.entityType ?? null,
    targetEntityId: target?.entityId ?? null,
  };

  // Provider identity is env-derived and side-effect free; resolving it here
  // lets every usage row name its provider. The not-configured CHECK still
  // runs at its §5.5 position (step 4), after the limits decision.
  const config = resolveAiConfig();
  const provider = getAiProvider(config);
  const providerNotConfigured =
    config.provider !== 'mock' && (config.apiKey === null || config.model === null);

  // Step 3: limits. Limited → visibility row + audit → 429 outcome.
  const evaluation = await evaluateAiLimits(auth);
  if (!evaluation.decision.allowed) {
    const recorded = await recordAiUsageOutcome(
      auth,
      {
        requestId,
        capability: capabilityId,
        provider: provider.id,
        model: provider.model,
        ...targetAttribution,
      },
      'LIMITED',
    );
    await auditAiRequest(auth, meta, {
      usageId: recorded?.usageId ?? null,
      capability: capabilityId,
      provider: provider.id,
      model: provider.model,
      status: 'LIMITED',
      totalTokens: null,
      durationMs: elapsed(),
    });
    return {
      status: 'limited',
      requestId,
      retryAfterSeconds: evaluation.decision.retryAfterSeconds,
    };
  }

  // Step 4: not-configured stub → visibility row + audit → 503 outcome.
  if (providerNotConfigured) {
    const recorded = await recordAiUsageOutcome(
      auth,
      {
        requestId,
        capability: capabilityId,
        provider: provider.id,
        model: provider.model,
        ...targetAttribution,
      },
      'NOT_CONFIGURED',
    );
    await auditAiRequest(auth, meta, {
      usageId: recorded?.usageId ?? null,
      capability: capabilityId,
      provider: provider.id,
      model: provider.model,
      status: 'NOT_CONFIGURED',
      totalTokens: null,
      durationMs: elapsed(),
    });
    return { status: 'not_configured', requestId };
  }

  // Step 5: context + request assembly through F's seam (buildContext is
  // the only data path). AuthorizationError propagates untouched (§5.4);
  // no usage row exists yet.
  let prepared: Awaited<ReturnType<typeof prepareCapabilityRequest>>;
  try {
    prepared = await prepareCapabilityRequest(
      auth,
      { capability: capabilityId, target, question },
      {
        maxOutputTokens: config.maxOutputTokens,
        tools: definition.toolsAllowed ? listProviderToolDefinitions(toolRegistry) : undefined,
      },
    );
  } catch (error) {
    if (error instanceof ContextBuildError || error instanceof CapabilityInputError) {
      throw invalidRequest(error.message);
    }
    throw error;
  }

  // Step 6: the STARTED row. A throw here refuses the request (fail-closed)
  // and propagates — the provider is never invoked unmetered.
  const { usageId } = await beginAiUsageRequest(auth, {
    requestId,
    capability: capabilityId,
    provider: provider.id,
    model: provider.model,
    ...targetAttribution,
  });

  const failRequest = async (
    errorCode: AiErrorCode,
    partial: ExecutionProgress,
  ): Promise<AiRequestOutcome> => {
    const totalTokens = effectiveTotalTokens(partial.usage);
    await finalizeAiUsageRequest(auth, {
      usageId,
      status: 'FAILED',
      promptTokens: partial.usage.promptTokens,
      completionTokens: partial.usage.completionTokens,
      totalTokens,
      providerAttempts: partial.attempts,
      toolCallsCount: partial.toolCallsCount,
      durationMs: elapsed(),
      errorCode,
    });
    await auditAiRequest(auth, meta, {
      usageId,
      capability: capabilityId,
      provider: provider.id,
      model: provider.model,
      status: 'FAILED',
      totalTokens,
      durationMs: elapsed(),
    });
    if (errorCode === 'AI_NOT_CONFIGURED') {
      // Unreachable with the landed providers (the stub is caught at step 4);
      // kept so a provider-side configuration failure still reads as 503.
      return { status: 'not_configured', requestId };
    }
    return { status: 'provider_failed', requestId };
  };

  // Step 7: invoke the provider under one overall deadline (§3.5).
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), config.timeoutMs);
  const execution = await executeWithTools(
    provider,
    auth,
    prepared.request.messages,
    prepared.request.tools,
    prepared.request.maxOutputTokens,
    controller.signal,
  );
  clearTimeout(deadlineTimer);
  if (!execution.ok) {
    return failRequest(execution.errorCode, execution);
  }

  // Step 8: validate the structured output + reconcile sources (F). Any
  // failure here is PROVIDER_BAD_RESPONSE by construction (§5.5 step 8).
  let parsed: ParsedCapabilityOutput;
  try {
    parsed = parseCapabilityOutput(capabilityId, execution.result, prepared.context);
  } catch {
    return failRequest('PROVIDER_BAD_RESPONSE', execution);
  }

  // Step 9: finalize (never throws), audit, return the §5.3 body.
  const totalTokens = effectiveTotalTokens(execution.usage);
  await finalizeAiUsageRequest(auth, {
    usageId,
    status: 'SUCCEEDED',
    promptTokens: execution.usage.promptTokens,
    completionTokens: execution.usage.completionTokens,
    totalTokens,
    providerAttempts: execution.attempts,
    toolCallsCount: execution.toolCallsCount,
    durationMs: elapsed(),
    errorCode: null,
  });
  await auditAiRequest(auth, meta, {
    usageId,
    capability: capabilityId,
    provider: provider.id,
    model: provider.model,
    status: 'SUCCEEDED',
    totalTokens,
    durationMs: elapsed(),
  });

  return {
    requestId,
    capability: capabilityId,
    status: 'ok',
    summary: parsed.summary,
    sources: parsed.sources.map((source) => ({
      entityType: source.entityType,
      entityId: source.entityId,
      label: source.label,
    })),
    usage: { provider: provider.id, model: provider.model, totalTokens },
  };
}
