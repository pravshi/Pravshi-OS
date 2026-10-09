/**
 * Normalized AI error taxonomy (Phase 9 contract §3.2).
 *
 * Raw provider errors, response bodies and headers are never propagated to
 * callers or logs — only the normalized code, the provider id and a duration
 * may travel. Every message in this file is therefore static and safe: it must
 * never interpolate a provider response, a header, or any credential material.
 */

export type AiErrorCode =
  | 'AI_NOT_CONFIGURED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_BAD_RESPONSE';

/** Retryability per the §3.2 table — the single source of truth for the flag. */
const RETRYABLE_BY_CODE: Readonly<Record<AiErrorCode, boolean>> = {
  AI_NOT_CONFIGURED: false,
  PROVIDER_TIMEOUT: true,
  PROVIDER_RATE_LIMITED: true,
  PROVIDER_UNAVAILABLE: true,
  PROVIDER_AUTH: false,
  PROVIDER_REJECTED: false,
  PROVIDER_BAD_RESPONSE: false,
};

const DEFAULT_MESSAGE_BY_CODE: Readonly<Record<AiErrorCode, string>> = {
  AI_NOT_CONFIGURED: 'AI provider is not configured.',
  PROVIDER_TIMEOUT: 'AI provider request timed out.',
  PROVIDER_RATE_LIMITED: 'AI provider rate limit reached.',
  PROVIDER_UNAVAILABLE: 'AI provider is unavailable.',
  PROVIDER_AUTH: 'AI provider rejected the configured credentials.',
  PROVIDER_REJECTED: 'AI provider rejected the request.',
  PROVIDER_BAD_RESPONSE: 'AI provider returned an unreadable response.',
};

export class AiProviderError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  /**
   * Milliseconds the provider asked us to wait (429 `Retry-After`), when it
   * sent one. The retry loop honours it only up to the overall deadline.
   */
  readonly retryAfterMs: number | null;

  constructor(code: AiErrorCode, options?: { retryAfterMs?: number | null }) {
    super(DEFAULT_MESSAGE_BY_CODE[code]);
    this.name = 'AiProviderError';
    this.code = code;
    this.retryable = RETRYABLE_BY_CODE[code];
    this.retryAfterMs = options?.retryAfterMs ?? null;
  }
}

export function isAiProviderError(value: unknown): value is AiProviderError {
  return value instanceof AiProviderError;
}
