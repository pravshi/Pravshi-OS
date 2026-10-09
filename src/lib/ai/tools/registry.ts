/**
 * AI tool registry — Phase 9 AI Foundation (Workstream E).
 *
 * Contract: phase9-contract-review.md §6.2/§6.4 (binding) and master prompt §8.
 *
 * The registry is the ONLY path by which a model reaches business data through
 * tools. Its guarantees:
 *
 *  - Read-only, structurally. `classification` has exactly one value ('read');
 *    `createToolRegistry()` refuses anything else at composition time. No
 *    write tool can be registered until a future phase adds a human
 *    confirmation surface (§6.4) — there is no SQL/HTTP/shell tool and never
 *    a generic one.
 *  - Every tool declares a stable id, description, zod input AND output
 *    schemas, the catalogue permission it requires, a per-call timeout, and
 *    its audit behavior (prompt §8's declaration list).
 *  - Dispatch order is fixed: resolve tool → zod-validate arguments (strict;
 *    unknown keys and malformed values fail) → permission pre-check
 *    (`authz.scope_for(requiredPermission)` inside `withAuthorizedDb` must be
 *    non-null) → the tool's `execute`, which calls an EXISTING authorized
 *    service. The pre-check is a fast gate only — the service performs the
 *    real enforcement (RLS + scope + assertTargetAffected).
 *  - The error contract toward the model is a single shape: any failure —
 *    unknown tool, invalid arguments, missing permission, invisible record,
 *    timeout, service failure — surfaces as exactly `{ error: 'unavailable' }`
 *    (see `toModelToolResult`). Record existence, permission names and error
 *    detail never reach the model. The internal `reason` on the dispatch
 *    result is for the orchestrator's logging/counting only.
 *  - Results are size-bounded: tools project service DTOs through §7.2 field
 *    allowlists before returning, the dispatcher re-validates the projected
 *    value against the tool's output schema (an allowlist slip fails the
 *    call, it does not leak), and a hard serialized-size cap backstops both.
 *  - Audit behavior: a dispatch can report one metadata-only event through
 *    `onExecuted` (tool id, outcome, duration — never arguments, never
 *    results), and the orchestrator counts executions on the request's usage
 *    row (`tool_calls_count`, §4.1). Tool arguments and results are never
 *    audited or logged.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { AuthorizationError } from '@/lib/authz/errors';
import type { AccessScope, Authorization } from '@/lib/authz/require-permission';

/** Default per-call tool timeout (§6.2): 5 seconds. */
export const DEFAULT_TOOL_TIMEOUT_MS = 5000;

/**
 * Hard cap on one tool result, serialized. §7.3 caps the whole serialized
 * context at 24,000 chars; a single tool result stays below that with room
 * for the rest of the context.
 */
export const MAX_TOOL_RESULT_CHARS = 20_000;

/** §7.3: no single string field reaching the model exceeds 500 chars. */
export const MAX_TOOL_FIELD_CHARS = 500;

/** Read/write classification. V1: 'read' is the only value (§6.4). */
export type ToolClassification = 'read';

/**
 * What a tool records when it executes. Every Phase 9 tool is `count_only`:
 * the execution is counted on the request's usage row and reported through
 * the dispatch audit hook as metadata — arguments and results are never
 * recorded anywhere.
 */
export interface AiToolAudit {
  readonly mode: 'count_only';
  readonly includeArguments: false;
  readonly includeResult: false;
}

export const TOOL_AUDIT_COUNT_ONLY: AiToolAudit = Object.freeze({
  mode: 'count_only',
  includeArguments: false,
  includeResult: false,
});

/**
 * One registered tool (§6.2 shape, plus the output schema and audit
 * declaration master prompt §8 requires of every tool).
 *
 * `execute` receives the SAME `Authorization` the request was authorized
 * with and the zod-validated arguments; it calls an existing authorized
 * service and returns a JSON-safe, allowlist-projected result.
 */
export interface AiTool {
  readonly id: string;
  readonly description: string;
  /** Validates model-supplied arguments. Strict: unknown keys are rejected. */
  readonly inputSchema: z.ZodType;
  /** Validates the projected result before it may leave the dispatcher. */
  readonly outputSchema: z.ZodType;
  /** Catalogue key the caller must hold (any scope) for the tool to run. */
  readonly requiredPermission: string;
  readonly classification: ToolClassification;
  /** Per-call timeout, enforced by the dispatcher. */
  readonly timeoutMs: number;
  readonly audit: AiToolAudit;
  execute(auth: Authorization, args: unknown): Promise<unknown>;
}

/** An enumerable, lookup-able set of tools — the orchestrator's view. */
export interface ToolRegistry {
  /** All registered tools, in registration order. */
  list(): readonly AiTool[];
  /** The tool with this stable id, or undefined. */
  get(id: string): AiTool | undefined;
  has(id: string): boolean;
}

function assertToolDefinition(tool: AiTool): void {
  if (!tool || typeof tool.id !== 'string' || tool.id.length === 0) {
    throw new Error('AI tool definition requires a stable non-empty id.');
  }
  if (tool.classification !== 'read') {
    throw new Error(
      `AI tool '${tool.id}': classification must be 'read' — Phase 9 registers no write tools (§6.4).`,
    );
  }
  if (!(tool.inputSchema instanceof z.ZodType) || !(tool.outputSchema instanceof z.ZodType)) {
    throw new Error(`AI tool '${tool.id}': inputSchema and outputSchema must be zod schemas.`);
  }
  if (typeof tool.requiredPermission !== 'string' || tool.requiredPermission.length === 0) {
    throw new Error(`AI tool '${tool.id}': requiredPermission must be a catalogue key.`);
  }
  if (!Number.isFinite(tool.timeoutMs) || tool.timeoutMs <= 0) {
    throw new Error(`AI tool '${tool.id}': timeoutMs must be a positive number.`);
  }
  if (typeof tool.execute !== 'function') {
    throw new Error(`AI tool '${tool.id}': execute must be a function.`);
  }
}

/**
 * Compose a registry from tool definitions. Fails fast at composition time
 * (module load in practice): duplicate ids and malformed definitions throw,
 * so a broken registry can never serve a request.
 */
export function createToolRegistry(tools: readonly AiTool[]): ToolRegistry {
  const byId = new Map<string, AiTool>();
  for (const tool of tools) {
    assertToolDefinition(tool);
    if (byId.has(tool.id)) {
      throw new Error(`AI tool id '${tool.id}' is registered twice.`);
    }
    byId.set(tool.id, tool);
  }
  const ordered = Object.freeze([...byId.values()]);
  return Object.freeze({
    list: () => ordered,
    get: (id: string) => byId.get(id),
    has: (id: string) => byId.has(id),
  });
}

// ── Provider-facing definitions ──────────────────────────────────────────────

/**
 * The shape `AiProvider` tool definitions take (§3.1): the registry tool's
 * id and description, with the zod input schema rendered as JSON Schema.
 * Defined structurally here so this module never depends on provider code.
 */
export interface ProviderToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export function toProviderToolDefinition(tool: AiTool): ProviderToolDefinition {
  return Object.freeze({
    name: tool.id,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema) as Readonly<Record<string, unknown>>,
  });
}

export function listProviderToolDefinitions(
  registry: ToolRegistry,
): readonly ProviderToolDefinition[] {
  return Object.freeze(registry.list().map(toProviderToolDefinition));
}

// ── Permission pre-check ─────────────────────────────────────────────────────

const ACCESS_SCOPES: ReadonlySet<string> = new Set([
  'GLOBAL',
  'DEPARTMENT',
  'TEAM',
  'PROJECT',
  'SELF',
]);

function isAccessScope(value: unknown): value is AccessScope {
  return typeof value === 'string' && ACCESS_SCOPES.has(value);
}

/**
 * The §6.2 pre-check: the caller's effective scope for `permission`, asked
 * of the database (`authz.scope_for`) inside the authorized context.
 * Fail-closed — a NULL, missing or unexpected value is "not granted".
 * This gates the tool call; the wrapped service remains the enforcement.
 */
export async function scopeForPermission(
  auth: Authorization,
  permission: string,
): Promise<AccessScope | null> {
  const row = await withAuthorizedDb(auth.ctx, async (tx) => {
    const res = await tx.execute<{ scope: string | null }>(sql`
      select authz.scope_for(${permission})::text as scope
    `);
    return res.rows[0];
  });
  const scope = row?.scope ?? null;
  return isAccessScope(scope) ? scope : null;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/** Why a dispatch failed. Internal only — the model sees `{ error: 'unavailable' }`. */
export type ToolFailureReason =
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'permission_denied'
  | 'not_found'
  | 'forbidden'
  | 'timeout'
  | 'failed';

export type ToolExecutionResult =
  | {
      readonly ok: true;
      readonly toolId: string;
      readonly value: unknown;
      readonly durationMs: number;
    }
  | {
      readonly ok: false;
      readonly toolId: string;
      /** The one error value the model may learn. Nothing else crosses. */
      readonly error: 'unavailable';
      readonly reason: ToolFailureReason;
      readonly durationMs: number;
    };

/** Metadata-only audit event for one dispatch. Never carries arguments or results. */
export interface ToolExecutionEvent {
  readonly toolId: string;
  readonly outcome: 'ok' | ToolFailureReason;
  readonly durationMs: number;
}

export interface ToolDispatchOptions {
  /**
   * The request-level deadline (the orchestrator's AbortController). When it
   * fires, the dispatch is bounded the same way as by the tool timeout.
   */
  readonly signal?: AbortSignal;
  /** Pre-check override — tests inject a fake; production uses `scopeForPermission`. */
  readonly scopeFor?: (auth: Authorization, permission: string) => Promise<AccessScope | null>;
  /** Audit hook: invoked exactly once per dispatch, after it settles. */
  readonly onExecuted?: (event: ToolExecutionEvent) => void;
}

class ToolTimeoutError extends Error {
  constructor() {
    super('AI tool execution exceeded its deadline.');
    this.name = 'ToolTimeoutError';
  }
}

/**
 * Race `work` against the tool timeout and the request deadline. The losing
 * service call is not cancellable (services take no AbortSignal) and settles
 * in the background — its outcome is discarded, which the race subscription
 * keeps from surfacing as an unhandled rejection.
 */
function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolTimeoutError()), timeoutMs);
    const onAbort = () => reject(new ToolTimeoutError());
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new ToolTimeoutError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    work.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error('AI tool execution failed.'));
      },
    );
  });
}

function failureReason(err: unknown): ToolFailureReason {
  if (err instanceof ToolTimeoutError) return 'timeout';
  if (err instanceof AuthorizationError) {
    if (err.code === 'NOT_FOUND') return 'not_found';
    if (err.code === 'FORBIDDEN' || err.code === 'SCOPE_DENIED') return 'forbidden';
  }
  return 'failed';
}

/**
 * Dispatch one model tool call through the registry. Never throws: every
 * outcome is a `ToolExecutionResult`, and the model-bound payload is derived
 * with `toModelToolResult`.
 */
export async function dispatchToolCall(
  registry: ToolRegistry,
  auth: Authorization,
  toolId: string,
  args: unknown,
  options: ToolDispatchOptions = {},
): Promise<ToolExecutionResult> {
  const startedAt = Date.now();
  const settle = (result: ToolExecutionResult): ToolExecutionResult => {
    options.onExecuted?.({
      toolId: result.toolId,
      outcome: result.ok ? 'ok' : result.reason,
      durationMs: result.durationMs,
    });
    return result;
  };
  const fail = (reason: ToolFailureReason): ToolExecutionResult =>
    settle({
      ok: false,
      toolId,
      error: 'unavailable',
      reason,
      durationMs: Date.now() - startedAt,
    });

  const tool = registry.get(toolId);
  if (!tool) return fail('unknown_tool');

  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) return fail('invalid_arguments');

  const scopeFor = options.scopeFor ?? scopeForPermission;
  let scope: AccessScope | null;
  try {
    scope = await scopeFor(auth, tool.requiredPermission);
  } catch {
    return fail('failed');
  }
  if (scope === null) return fail('permission_denied');

  let value: unknown;
  try {
    value = await withDeadline(tool.execute(auth, parsed.data), tool.timeoutMs, options.signal);
  } catch (err) {
    return fail(failureReason(err));
  }

  // The result crosses to the model only if it matches the declared output
  // schema exactly (strict objects: an allowlist slip fails here instead of
  // leaking) and fits the serialized-size bound.
  const checked = tool.outputSchema.safeParse(value);
  if (!checked.success) return fail('failed');
  let serialized: string;
  try {
    serialized = JSON.stringify(checked.data) ?? '';
  } catch {
    return fail('failed');
  }
  if (serialized.length > MAX_TOOL_RESULT_CHARS) return fail('failed');

  return settle({ ok: true, toolId, value: checked.data, durationMs: Date.now() - startedAt });
}

/**
 * The model-bound payload for a dispatch (§6.2): the value on success, or
 * exactly `{ error: 'unavailable' }` on any failure — record existence,
 * permission state and error detail are not leaked to the model.
 */
export function toModelToolResult(result: ToolExecutionResult): unknown {
  return result.ok ? result.value : { error: 'unavailable' };
}

/** Truncate a nullable string field to the §7.3 per-field bound. */
export function truncateField(
  value: string | null,
  max: number = MAX_TOOL_FIELD_CHARS,
): string | null {
  if (value === null || value.length <= max) return value;
  return value.slice(0, max);
}
