import { z } from 'zod';
import { AiProviderError } from '../errors';
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiMessage,
  AiProvider,
  AiToolCall,
} from './types';

/**
 * OpenAI-compatible adapter (Phase 9 contract §3.4) — plain `fetch`, no new
 * dependency. POSTs `${baseUrl}/chat/completions` with the API key as a Bearer
 * header. The key lives only in this class's private field and that header:
 * it is never logged, never placed in an error, never returned to a caller.
 *
 * Every failure is normalized into the §3.2 taxonomy. Response bodies and
 * headers are never propagated — an error carries only its code (plus, for
 * 429, the parsed Retry-After wait).
 *
 * Timeout and retry (§3.5): the caller's `signal` is the overall deadline
 * (the orchestrator owns it); this adapter additionally caps the whole call
 * at the configured `AI_TIMEOUT_MS` budget starting at invocation. Each
 * attempt's deadline is the remaining budget. Max 2 attempts total, only for
 * retryable codes, backoff 250ms before the second attempt; a 429's
 * `Retry-After` replaces the backoff but is honoured only up to the
 * remaining deadline. No fallback chain exists in V1.
 */

const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 250;

type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenAiCompatibleOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: FetchImpl;
}

const ToolCallSchema = z.object({
  id: z.string(),
  function: z.object({ name: z.string(), arguments: z.string() }).optional(),
  // Tolerated non-OpenAI variant some compatible endpoints emit.
  name: z.string().optional(),
  arguments: z.unknown().optional(),
});

const ChatCompletionResponseSchema = z.object({
  id: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z.array(ToolCallSchema).optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .nullish(),
});

function mapMessage(message: AiMessage): Record<string, unknown> {
  const mapped: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.role === 'tool' && message.toolCallId !== undefined) {
    mapped.tool_call_id = message.toolCallId;
  }
  return mapped;
}

function buildRequestBody(req: AiCompletionRequest, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: req.messages.map(mapMessage),
    max_tokens: req.maxOutputTokens,
  };
  if (req.responseFormat === 'json') {
    body.response_format = { type: 'json_object' };
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }
  return body;
}

function mapToolCall(raw: z.infer<typeof ToolCallSchema>): AiToolCall {
  const name = raw.function?.name ?? raw.name ?? '';
  const rawArguments = raw.function?.arguments ?? raw.arguments;
  let args: unknown = rawArguments ?? {};
  if (typeof rawArguments === 'string') {
    try {
      args = JSON.parse(rawArguments);
    } catch {
      // Unparseable arguments stay a raw string; the tool registry's zod
      // validation rejects them. The response itself was well-formed.
      args = rawArguments;
    }
  }
  return { id: raw.id, name, arguments: args };
}

function parseRetryAfterMs(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

function errorForStatus(status: number, headers: Headers): AiProviderError {
  if (status === 401 || status === 403) return new AiProviderError('PROVIDER_AUTH');
  if (status === 429) {
    return new AiProviderError('PROVIDER_RATE_LIMITED', {
      retryAfterMs: parseRetryAfterMs(headers),
    });
  }
  if (status >= 500) return new AiProviderError('PROVIDER_UNAVAILABLE');
  return new AiProviderError('PROVIDER_REJECTED');
}

/** Abortable wait: resolves after `ms`, throws PROVIDER_TIMEOUT if the overall signal fires first. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new AiProviderError('PROVIDER_TIMEOUT'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AiProviderError('PROVIDER_TIMEOUT'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly id = 'openai-compatible';
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetchImpl: FetchImpl;

  constructor(options: OpenAiCompatibleOptions) {
    this.model = options.model;
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs;
    this.#fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async complete(req: AiCompletionRequest, signal: AbortSignal): Promise<AiCompletionResult> {
    const deadline = Date.now() + this.#timeoutMs;
    let lastError: AiProviderError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (signal.aborted || Date.now() >= deadline) {
        throw new AiProviderError('PROVIDER_TIMEOUT');
      }
      try {
        return await this.#attempt(req, signal, deadline);
      } catch (error) {
        const normalized =
          error instanceof AiProviderError ? error : new AiProviderError('PROVIDER_UNAVAILABLE');
        lastError = normalized;
        if (!normalized.retryable || attempt === MAX_ATTEMPTS) throw normalized;
        const waitMs = normalized.retryAfterMs ?? RETRY_BACKOFF_MS;
        const remainingMs = deadline - Date.now();
        // Honour the wait only up to the overall deadline (§3.2); if it does
        // not fit, the normalized error stands and no retry happens.
        if (waitMs >= remainingMs) throw normalized;
        await wait(waitMs, signal);
      }
    }
    // Unreachable: the loop always returns or throws. Satisfies the checker.
    throw lastError ?? new AiProviderError('PROVIDER_UNAVAILABLE');
  }

  async #attempt(
    req: AiCompletionRequest,
    signal: AbortSignal,
    deadline: number,
  ): Promise<AiCompletionResult> {
    const remainingMs = Math.max(0, deadline - Date.now());
    const attemptController = new AbortController();
    const onParentAbort = () => attemptController.abort();
    if (signal.aborted) {
      attemptController.abort();
    } else {
      signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const timer = setTimeout(() => attemptController.abort(), remainingMs);

    let response: Response;
    try {
      response = await this.#fetchImpl(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildRequestBody(req, this.model)),
        signal: attemptController.signal,
      });
    } catch {
      // An abort (parent deadline or this attempt's) is a timeout; anything
      // else thrown by fetch is a network failure. Either way the original
      // error is discarded — it may embed the request, never propagate it.
      if (signal.aborted || attemptController.signal.aborted) {
        throw new AiProviderError('PROVIDER_TIMEOUT');
      }
      throw new AiProviderError('PROVIDER_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onParentAbort);
    }

    if (!response.ok) {
      throw errorForStatus(response.status, response.headers);
    }

    let parsed: z.infer<typeof ChatCompletionResponseSchema>;
    try {
      const raw: unknown = JSON.parse(await response.text());
      parsed = ChatCompletionResponseSchema.parse(raw);
    } catch {
      throw new AiProviderError('PROVIDER_BAD_RESPONSE');
    }

    const choice = parsed.choices[0];
    return {
      text: choice?.message.content ?? null,
      toolCalls: (choice?.message.tool_calls ?? []).map(mapToolCall),
      usage: {
        // Absent usage fields stay null — counts are never invented (§3.4).
        promptTokens: parsed.usage?.prompt_tokens ?? null,
        completionTokens: parsed.usage?.completion_tokens ?? null,
        totalTokens: parsed.usage?.total_tokens ?? null,
      },
      providerRequestId: parsed.id ?? null,
      finishReason: choice?.finish_reason ?? null,
    };
  }
}
