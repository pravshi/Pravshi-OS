import { env } from '@/env';

/**
 * AI configuration resolution (Phase 9 contract §§3.5, 7.3, 10).
 *
 * Provider selection is purely a function of environment configuration:
 * `AI_PROVIDER` unset or 'mock' selects the deterministic mock provider;
 * 'openai-compatible' (alias 'openai') selects the real adapter. Every key is
 * optional — the application must boot and run with no AI config at all.
 *
 * The API key is read here, server-side only, from the parsed runtime env. It
 * is never logged, never embedded in an error, and never leaves this layer
 * except as the adapter's `Authorization` header value.
 */

export type AiProviderId = 'mock' | 'openai-compatible';

export interface AiConfig {
  readonly provider: AiProviderId;
  /** Configured model id for the real adapter; null when unset. */
  readonly model: string | null;
  /** Server-side provider key; null when unset. Never log this value. */
  readonly apiKey: string | null;
  readonly baseUrl: string;
  /** Overall AI request deadline in milliseconds (§3.5). */
  readonly timeoutMs: number;
  /** Output token cap, clamped to 100–4000 (§7.3). */
  readonly maxOutputTokens: number;
}

/** Raw env-shaped input; defaults to the parsed runtime env. */
export interface AiEnvSource {
  readonly AI_PROVIDER?: string;
  readonly AI_MODEL?: string;
  readonly AI_API_KEY?: string;
  readonly AI_BASE_URL?: string;
  readonly AI_TIMEOUT_MS?: string;
  readonly AI_MAX_OUTPUT_TOKENS?: string;
}

export const AI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const AI_DEFAULT_TIMEOUT_MS = 30_000;
export const AI_DEFAULT_MAX_OUTPUT_TOKENS = 800;
export const AI_MIN_OUTPUT_TOKENS = 100;
export const AI_MAX_OUTPUT_TOKENS_LIMIT = 4_000;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveAiConfig(source: AiEnvSource = env): AiConfig {
  const selected = source.AI_PROVIDER?.trim();
  const provider: AiProviderId =
    selected === 'openai-compatible' || selected === 'openai' ? 'openai-compatible' : 'mock';
  return {
    provider,
    model: source.AI_MODEL?.trim() ? source.AI_MODEL.trim() : null,
    apiKey: source.AI_API_KEY ? source.AI_API_KEY : null,
    baseUrl: source.AI_BASE_URL?.trim() ? source.AI_BASE_URL.trim() : AI_DEFAULT_BASE_URL,
    timeoutMs: parsePositiveInt(source.AI_TIMEOUT_MS, AI_DEFAULT_TIMEOUT_MS),
    maxOutputTokens: clamp(
      parsePositiveInt(source.AI_MAX_OUTPUT_TOKENS, AI_DEFAULT_MAX_OUTPUT_TOKENS),
      AI_MIN_OUTPUT_TOKENS,
      AI_MAX_OUTPUT_TOKENS_LIMIT,
    ),
  };
}
