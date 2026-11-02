/**
 * Website Platform API — Anti-Abuse, Bot Protection & Form Sanitization.
 *
 * Implements defenses for unauthenticated public-facing forms:
 * - Hidden honeypot fields
 * - Submission timing anomaly detection (time-gate)
 * - HTML/Script tag sanitization against XSS
 * - Sliding window in-memory rate limiting
 */

export class AntiAbuseError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AntiAbuseError';
  }
}

/**
 * Validates hidden honeypot field. Legitimate users never fill this field.
 */
export function verifyHoneypot(
  formData: Record<string, unknown>,
  honeypotKey = 'hp_field_check',
): void {
  const value = formData[honeypotKey];
  if (value !== undefined && value !== null && String(value).trim().length > 0) {
    throw new AntiAbuseError('Automated bot submission detected via honeypot', 'BOT_DETECTED');
  }
}

/**
 * Validates submission time-gate. Forms submitted in under 1.5 seconds are almost certainly automated bots.
 */
export function verifyTimeGate(formRenderTimestampMs: number, minimumDurationMs = 1500): void {
  const elapsed = Date.now() - formRenderTimestampMs;
  if (elapsed < minimumDurationMs) {
    throw new AntiAbuseError(
      'Form submitted unnaturally quickly (likely bot automation)',
      'TIME_GATE_FAILED',
    );
  }
}

const DANGEROUS_TAG_REGEX = /<(?:\/?[a-zA-Z][a-zA-Z0-9]*\b[^>]*|!--[\s\S]*?--)>/gi;

/**
 * Sanitizes untrusted user text inputs by stripping HTML tags and trimming.
 */
export function sanitizeInput(input: string): string {
  return input.replace(DANGEROUS_TAG_REGEX, '').trim();
}

export interface RateLimitTracker {
  check(key: string, limit: number, windowSeconds: number): { allowed: boolean; remaining: number };
}

/**
 * In-memory sliding window rate limiter for edge/public route handlers.
 */
export class InMemoryRateLimiter implements RateLimitTracker {
  private readonly hits = new Map<string, number[]>();

  check(
    key: string,
    limit: number,
    windowSeconds: number,
  ): { allowed: boolean; remaining: number } {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const timestamps = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);

    if (timestamps.length >= limit) {
      return { allowed: false, remaining: 0 };
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return { allowed: true, remaining: limit - timestamps.length };
  }
}
