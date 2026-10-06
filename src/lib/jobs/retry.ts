/**
 * Phase 6 — Job retry classification and exponential backoff.
 *
 * Pure logic module (no DB, no I/O): every function is a pure function of its
 * inputs, which makes it unit-testable and safe to share between the worker,
 * the scheduler, and the reaper.
 *
 * Contract: ~/workspace/goals/pravshi-os-build/hidden_files/phase6-architecture-contracts.md §3.3
 */

export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
}

/** Upper bound for any single backoff delay: 15 minutes. */
export const MAX_DELAY_MS = 15 * 60 * 1000;

/** Node.js errno codes that indicate a transient failure. */
const RETRYABLE_ERRNO = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ECONNREFUSED',
]);

/** PostgreSQL error codes that indicate a transient failure. */
const RETRYABLE_PG_CODES = new Set([
  '40P01', // deadlock_detected
  '40001', // serialization_failure
  '55P03', // lock_not_available
]);

const NON_RETRYABLE_CODES = new Set([
  'VALIDATION_ERROR',
  'CONFIG_ERROR',
  'BAD_CONFIG',
  'RECORD_NOT_FOUND',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'ZOD_ERROR',
]);

interface ErrorLike {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  name?: unknown;
  message?: unknown;
  response?: { status?: unknown } | unknown;
}

function asObject(err: unknown): ErrorLike | null {
  if (err === null || err === undefined) return null;
  if (typeof err === 'object') return err as ErrorLike;
  return null;
}

function extractMessage(err: unknown, obj: ErrorLike | null): string {
  if (obj && typeof obj.message === 'string' && obj.message.length > 0) {
    return obj.message;
  }
  if (typeof err === 'string' && err.length > 0) return err;
  try {
    return String(err);
  } catch {
    return 'Unknown error';
  }
}

function extractCode(obj: ErrorLike | null): string | null {
  if (!obj) return null;
  const code = obj.code;
  if (typeof code === 'string' && code.length > 0) return code;
  if (typeof code === 'number') return String(code);
  return null;
}

function extractHttpStatus(obj: ErrorLike | null): number | null {
  if (!obj) return null;
  const candidates = [obj.status, obj.statusCode];
  const response = obj.response;
  if (response && typeof response === 'object') {
    candidates.push((response as { status?: unknown }).status);
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return Math.trunc(candidate);
    }
  }
  return null;
}

function isZodError(obj: ErrorLike | null): boolean {
  if (!obj) return false;
  if (obj.name === 'ZodError') return true;
  // Cross-realm instances: duck-type on the issues array.
  return (
    typeof obj === 'object' &&
    Array.isArray((obj as { issues?: unknown }).issues) &&
    typeof obj.message === 'string' &&
    obj.message.includes('ZodError')
  );
}

function messageMatchesTimeout(message: string): boolean {
  return /timed?\s?out|deadline\s+exceeded|ETIMEDOUT/i.test(message);
}

function messageMatchesConnectionFailure(message: string): boolean {
  return /neon|fetch failed|connection (terminated|refused|reset|closed)|pool/i.test(message);
}

/**
 * Classify an arbitrary thrown value into a structured JobError.
 *
 * Fail-open: unknown errors classify as retryable with code 'UNKNOWN' — losing
 * a job silently is worse than retrying it once more.
 */
export function classifyError(err: unknown): JobError {
  const obj = asObject(err);
  const message = extractMessage(err, obj);

  // 1. Zod validation errors are never transient.
  if (isZodError(obj)) {
    return { code: 'ZOD_ERROR', message, retryable: false };
  }

  // 2. Named Error subclasses.
  const name = obj && typeof obj.name === 'string' ? obj.name : null;
  if (name === 'ValidationError' || name === 'SchemaError') {
    return { code: 'VALIDATION_ERROR', message, retryable: false };
  }
  if (name === 'NeonDbError') {
    return { code: 'NEON_CONNECTION_ERROR', message, retryable: true };
  }

  // 3. Explicit error codes.
  const code = extractCode(obj);
  if (code) {
    const upper = code.toUpperCase();
    if (RETRYABLE_ERRNO.has(upper) || RETRYABLE_PG_CODES.has(upper)) {
      return { code: upper, message, retryable: true };
    }
    if (NON_RETRYABLE_CODES.has(upper)) {
      return { code: upper, message, retryable: false };
    }
    // Prisma "record not found" surfaces as P2025.
    if (upper === 'P2025') {
      return { code: upper, message, retryable: false };
    }
  }

  // 4. HTTP status codes.
  const status = extractHttpStatus(obj);
  if (status !== null) {
    if (status === 401 || status === 403) {
      return {
        code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
        message,
        retryable: false,
      };
    }
    if (status === 404) {
      return { code: 'NOT_FOUND', message, retryable: false };
    }
    if (status >= 400 && status < 500) {
      return { code: `HTTP_${status}`, message, retryable: false };
    }
    if (status >= 500 && status < 600) {
      return { code: `HTTP_${status}`, message, retryable: true };
    }
  }

  // 5. Message heuristics for provider/transport failures without codes.
  if (messageMatchesTimeout(message)) {
    return { code: 'TIMEOUT', message, retryable: true };
  }
  if (messageMatchesConnectionFailure(message)) {
    return { code: 'CONNECTION_ERROR', message, retryable: true };
  }

  // 6. Fail-open for everything else.
  return { code: 'UNKNOWN', message, retryable: true };
}

/**
 * Exponential backoff with full jitter.
 *
 * delay = min(base * 2^attempt + random(0, base), MAX_DELAY_MS)
 *
 * attempt is 0-indexed: the first retry waits ~base, the second ~2*base, etc.
 * Jitter uses Math.random (no cryptographic randomness needed here).
 */
export function backoffDelayMs(attempt: number, baseMs = 1000): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const safeBase = Math.max(0, baseMs);
  const exponential = safeBase * 2 ** safeAttempt;
  const jitter = Math.random() * safeBase;
  return Math.min(exponential + jitter, MAX_DELAY_MS);
}

/**
 * Whether another attempt is allowed: attempts < maxAttempts.
 * attempts = number of attempts already made.
 */
export function shouldRetry(attempts: number, maxAttempts: number): boolean {
  return attempts < maxAttempts;
}
