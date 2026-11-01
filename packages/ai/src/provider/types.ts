/**
 * Provider interface (Phase 9 contract §3.1) — the exact signatures business
 * logic depends on. No provider-specific type may appear outside
 * `src/lib/ai/provider/`; everything above this layer sees only these types.
 */

export type AiMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AiMessage {
  readonly role: AiMessageRole;
  readonly content: string;
  readonly toolCallId?: string; // role 'tool'
  readonly name?: string; // role 'tool': tool id
}

export interface AiToolDefinition {
  readonly name: string; // tool id from the registry
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>; // JSON Schema, from zod
}

export interface AiToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown; // parsed JSON; validated by the registry, never trusted
}

export interface AiCompletionRequest {
  readonly messages: readonly AiMessage[];
  readonly tools?: readonly AiToolDefinition[];
  readonly maxOutputTokens: number;
  readonly responseFormat: 'text' | 'json';
}

export interface AiUsageMetadata {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

export interface AiCompletionResult {
  readonly text: string | null;
  readonly toolCalls: readonly AiToolCall[];
  readonly usage: AiUsageMetadata;
  readonly providerRequestId: string | null;
  readonly finishReason: string | null;
}

export interface AiProvider {
  readonly id: string; // 'mock' | 'openai-compatible'
  readonly model: string; // configured model id, or 'mock-deterministic'
  complete(req: AiCompletionRequest, signal: AbortSignal): Promise<AiCompletionResult>;
}
