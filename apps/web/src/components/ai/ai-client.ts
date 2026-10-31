import type { AiCapabilityId, AiTargetEntityType } from '@/lib/ai/types';

/**
 * ai-client — browser-side client for POST /api/ai/assist (Phase 9, Workstream G).
 *
 * Mirrors the search-client.ts pattern: an envelope-aware fetch wrapper. The
 * server enforces authentication (401), `ai.use` authorization (403),
 * per-record visibility inside the orchestrator (404), input validation
 * (400 INVALID_REQUEST) and the AI outcomes of contract §5.4
 * (503 AI_NOT_CONFIGURED, 429 AI_LIMITED, 502 AI_PROVIDER_FAILED). The UI
 * renders exactly what this returns and maps each failure to its §9 panel
 * state — it never invents a summary, a provider message, or a retry hint
 * the server did not send.
 *
 * Privacy: requests and responses live in memory only. Nothing is persisted
 * (no localStorage/sessionStorage), so one user's summaries can never leak
 * to another user of the same browser.
 */

export interface AiSummary {
  readonly headline: string;
  /** Statements grounded in the context records (§5.3). */
  readonly facts: readonly string[];
  /** AI recommendations — ALWAYS rendered separately from facts (§9). */
  readonly suggestions: readonly string[];
  readonly missingInformation: readonly string[];
}

export interface AiSource {
  readonly entityType: AiTargetEntityType;
  readonly entityId: string;
  readonly label: string;
}

/** The §5.3 success payload, resource JSON returned directly by the route. */
export interface AiAssistResponse {
  readonly requestId: string;
  readonly capability: AiCapabilityId;
  readonly status: 'ok';
  readonly summary: AiSummary;
  readonly sources: readonly AiSource[];
  readonly usage: {
    readonly provider: string;
    readonly model: string;
    readonly totalTokens: number | null;
  };
}

export interface AiAssistTarget {
  readonly entityType: AiTargetEntityType;
  readonly entityId: string;
}

export interface AiAssistInput {
  readonly capability: AiCapabilityId;
  readonly target?: AiAssistTarget;
  /** Only meaningful for general_assistance (no V1 UI sends it — §9). */
  readonly question?: string;
}

export type AiApiErrorCode =
  | 'INVALID_REQUEST'
  | 'AI_NOT_CONFIGURED'
  | 'AI_LIMITED'
  | 'AI_PROVIDER_FAILED'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNAUTHORIZED'
  | 'REQUEST_FAILED'
  | 'SERVER_ERROR';

export class AiApiError extends Error {
  readonly code: AiApiErrorCode;
  readonly status: number;
  /** Server-supplied retry hint for AI_LIMITED (§5.4); null when absent. */
  readonly retryAfterSeconds: number | null;

  constructor(
    code: AiApiErrorCode,
    status: number,
    message: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'AiApiError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The exact JSON body POSTed to /api/ai/assist. Exported for tests. */
export function buildAssistRequestBody(input: AiAssistInput): Record<string, unknown> {
  return {
    capability: input.capability,
    ...(input.target ? { target: input.target } : {}),
    ...(input.question !== undefined ? { question: input.question } : {}),
  };
}

interface AiErrorEnvelope {
  readonly code?: string;
  readonly message?: string;
  readonly retryAfterSeconds?: number | null;
}

/** Reads the §24 envelope ({ error: { code, message, ... } }); tolerates the
 * flat module shape ({ error: 'CODE', message }) defensively. */
function parseErrorEnvelope(body: unknown): AiErrorEnvelope {
  if (typeof body !== 'object' || body === null) return {};
  const record = body as { error?: unknown; message?: unknown };
  if (typeof record.error === 'object' && record.error !== null) {
    const inner = record.error as {
      code?: unknown;
      message?: unknown;
      retryAfterSeconds?: unknown;
    };
    return {
      code: typeof inner.code === 'string' ? inner.code : undefined,
      message: typeof inner.message === 'string' ? inner.message : undefined,
      retryAfterSeconds:
        typeof inner.retryAfterSeconds === 'number' ? inner.retryAfterSeconds : null,
    };
  }
  if (typeof record.error === 'string') {
    return {
      code: record.error,
      message: typeof record.message === 'string' ? record.message : undefined,
      retryAfterSeconds: null,
    };
  }
  return {};
}

const AI_ENVELOPE_CODES: ReadonlySet<string> = new Set([
  'INVALID_REQUEST',
  'AI_NOT_CONFIGURED',
  'AI_LIMITED',
  'AI_PROVIDER_FAILED',
  'NOT_FOUND',
]);

function errorForStatus(
  status: number,
  envelope: AiErrorEnvelope,
): { code: AiApiErrorCode; message: string } {
  const detail = envelope.message;
  switch (status) {
    case 400:
      return { code: 'INVALID_REQUEST', message: detail || 'The AI request was invalid.' };
    case 401:
      return {
        code: 'UNAUTHORIZED',
        message: 'Your session has expired. Sign in again to use AI assistance.',
      };
    case 403:
      return {
        code: 'FORBIDDEN',
        message: detail || 'You do not have access to AI assistance for this record.',
      };
    case 404:
      return { code: 'NOT_FOUND', message: detail || 'This record could not be found.' };
    case 429:
      return {
        code: 'AI_LIMITED',
        message: detail || 'AI usage limit reached for this workspace. Please try again later.',
      };
    case 502:
      return {
        code: 'AI_PROVIDER_FAILED',
        message: detail || 'The AI provider could not complete this request. Please try again.',
      };
    case 503:
      return {
        code: 'AI_NOT_CONFIGURED',
        message: detail || "AI isn't configured for this workspace yet.",
      };
    default:
      return {
        code: 'SERVER_ERROR',
        message: detail || 'AI assistance is temporarily unavailable. Please try again.',
      };
  }
}

export interface AiClientOptions {
  /** AbortSignal to cancel an in-flight request (e.g. on unmount). */
  signal?: AbortSignal;
}

export async function requestAiSummary(
  input: AiAssistInput,
  options: AiClientOptions = {},
): Promise<AiAssistResponse> {
  let response: Response;
  try {
    response = await fetch('/api/ai/assist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(buildAssistRequestBody(input)),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new AiApiError('REQUEST_FAILED', 0, 'Could not reach the AI service.');
  }

  if (response.ok) {
    return (await response.json()) as AiAssistResponse;
  }

  let envelope: AiErrorEnvelope = {};
  try {
    envelope = parseErrorEnvelope(await response.json());
  } catch {
    // Non-JSON error body; fall through to the status-based messages.
  }

  const mapped = errorForStatus(response.status, envelope);
  // When the server names one of the §5.4 AI codes, it wins over the
  // status-derived code — they agree by contract; this keeps the client
  // correct if a proxy ever rewrites a status.
  const code =
    envelope.code !== undefined && AI_ENVELOPE_CODES.has(envelope.code)
      ? (envelope.code as AiApiErrorCode)
      : mapped.code;
  throw new AiApiError(code, response.status, mapped.message, envelope.retryAfterSeconds ?? null);
}
