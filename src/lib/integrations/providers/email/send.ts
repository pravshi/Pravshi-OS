import { Resend, type CreateEmailOptions } from 'resend';
import { env } from '@/env';

/**
 * Resend email adapter — Phase 10 contract §4.6 item 1 (Wave P).
 *
 * This is the real transmission path behind the Phase 6 job email handler
 * (`sendEmailViaProvider` in src/lib/jobs/handlers.ts), which the Phase 8
 * workflow `send_email` action enqueues into. It mirrors the conventions of
 * the two proven auth-adjacent mailers — src/lib/invitations/email.ts and
 * src/lib/auth/password-reset-email.ts: a lazily constructed module-level
 * `Resend` client, the sender taken from EMAIL_FROM, and failures reported
 * by provider error NAME only, never by payload.
 *
 * Credential: the jobs-path deployment credential EMAIL_PROVIDER_API_KEY,
 * falling back to RESEND_API_KEY (the key the auth mailers honour) when the
 * jobs-path key is unset — one Resend account per deployment is the norm,
 * and forcing operators to duplicate the same secret under two names would
 * only invite drift. The key is read from the parsed env only, is never
 * logged, and never appears in a thrown error.
 *
 * Idempotency: SUPPORTED by the installed SDK. resend@6.30.0 accepts
 * `idempotencyKey` in the second argument of `emails.send`
 * (CreateEmailRequestOptions extends IdempotentRequest; the SDK sends it as
 * the `Idempotency-Key` header — node_modules/resend/dist/index.d.mts).
 * The handler derives the key deterministically from the job id + dedup
 * key, so a retried job re-sends under the SAME key and Resend will not
 * double-send.
 *
 * Error normalisation: every failure leaves this module as an
 * `EmailSendError` carrying one of the job platform's own codes, so the
 * worker's classifyError (src/lib/jobs/retry.ts) sees the same contract
 * the fail-closed stub used:
 *   CONFIG_ERROR     → non-retryable (deployment credential/config problem)
 *   VALIDATION_ERROR → non-retryable (the message itself was rejected)
 *   PROVIDER_ERROR   → retryable (transient provider/transport failure)
 * The provider's raw response text is NEVER copied into an error message
 * or a log line; only its normalised error name (an enum, not payload) is
 * retained, on the error object and in the failure log line — the exact
 * discipline the invitation mailer applies.
 */

export interface EmailSendRequest {
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  /** Deterministic per-job key (handlers.ts buildEmailIdempotencyKey). */
  idempotencyKey: string;
  /**
   * Explicit sender override (e.g. a future connection's configured
   * fromAddress). Defaults to the deployment's EMAIL_FROM.
   */
  from?: string;
}

export interface EmailSendResult {
  messageId: string;
  idempotencyKey: string;
}

export type EmailSendErrorCode = 'CONFIG_ERROR' | 'VALIDATION_ERROR' | 'PROVIDER_ERROR';

/**
 * A send failure with a normalised, platform-owned code. `message` is
 * always static, authored text: no provider response text, no API key, no
 * recipient or body content. The provider's error NAME (a fixed enum in
 * the SDK) is available on `providerErrorName` for observability.
 */
export class EmailSendError extends Error {
  readonly code: EmailSendErrorCode;
  readonly providerErrorName?: string;

  constructor(code: EmailSendErrorCode, message: string, providerErrorName?: string) {
    super(message);
    this.name = 'EmailSendError';
    this.code = code;
    this.providerErrorName = providerErrorName;
  }
}

/** The payload handed to the provider — exactly what emails.send accepts. */
export interface ResendSendPayload {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
}

/** Structural mirror of the SDK's CreateEmailResponse (data XOR error). */
export interface ResendSendOutcome {
  data: { id: string } | null;
  error: { name: string; message: string; statusCode: number | null } | null;
}

/**
 * The injectable send function. Unit tests substitute a stub; production
 * uses `defaultSend`, which drives the real SDK. The idempotency key
 * travels in the options argument, never in the payload.
 */
export type ResendSendFn = (
  payload: ResendSendPayload,
  options: { idempotencyKey: string },
) => Promise<ResendSendOutcome>;

export interface SendViaResendDeps {
  sendImpl?: ResendSendFn;
}

/**
 * The credential this adapter sends with: the jobs-path key first, the
 * auth mailers' key as fallback, null when neither is configured.
 */
export function resolveResendApiKey(): string | null {
  return env.EMAIL_PROVIDER_API_KEY ?? env.RESEND_API_KEY ?? null;
}

// Lazy module-level client, the auth mailers' pattern: the parsed env is
// fixed for the life of the process, so the first key seen is the key.
let client: Resend | null = null;

function getClient(apiKey: string): Resend {
  if (!client) client = new Resend(apiKey);
  return client;
}

const defaultSend: ResendSendFn = async (payload, options) => {
  const apiKey = resolveResendApiKey();
  if (!apiKey) {
    throw new EmailSendError(
      'CONFIG_ERROR',
      'EMAIL_PROVIDER_UNCONFIGURED: EMAIL_PROVIDER=resend needs an API key — ' +
        'set EMAIL_PROVIDER_API_KEY (job email path) or RESEND_API_KEY (the ' +
        'auth mailers key). Job dead-letters (non-retryable) until configured.',
    );
  }
  // CreateEmailOptions is a union whose plain member demands
  // RequireAtLeastOne over {react, html, text}; a payload typed with both
  // body parts optional cannot prove that statically, so the constructed
  // literal is asserted to the SDK type at this boundary. A send with
  // neither body part is rejected by the provider and surfaces through the
  // normal VALIDATION_ERROR path.
  const sdkPayload = {
    from: payload.from,
    to: payload.to,
    subject: payload.subject,
    ...(payload.text !== undefined ? { text: payload.text } : {}),
    ...(payload.html !== undefined ? { html: payload.html } : {}),
  } as CreateEmailOptions;
  return getClient(apiKey).emails.send(sdkPayload, { idempotencyKey: options.idempotencyKey });
};

/** Provider error names that indict the deployment, not the message. */
const CONFIG_ERROR_NAMES: ReadonlySet<string> = new Set([
  'missing_api_key',
  'invalid_api_key',
  'restricted_api_key',
  'invalid_access',
]);

/** Provider error names that indict the message itself. */
const VALIDATION_ERROR_NAMES: ReadonlySet<string> = new Set([
  'validation_error',
  'invalid_from_address',
  'invalid_parameter',
  'invalid_region',
  'missing_required_field',
  'invalid_attachment',
  'invalid_idempotency_key',
  'invalid_idempotent_request',
]);

/**
 * Map a Resend error name (RESEND_ERROR_CODE_KEY) onto the job platform's
 * codes. Anything unlisted — rate limits, quotas, provider 5xx, concurrent
 * idempotent requests — is transient from the queue's point of view and
 * stays retryable.
 */
export function normaliseResendErrorName(name: string): EmailSendErrorCode {
  if (CONFIG_ERROR_NAMES.has(name)) return 'CONFIG_ERROR';
  if (VALIDATION_ERROR_NAMES.has(name)) return 'VALIDATION_ERROR';
  return 'PROVIDER_ERROR';
}

const PROVIDER_ERROR_MESSAGES: Readonly<Record<EmailSendErrorCode, string>> = {
  CONFIG_ERROR:
    'EMAIL_PROVIDER_REJECTED: the email provider rejected the deployment ' +
    'credential or configuration. Job dead-letters (non-retryable) until the ' +
    'deployment email configuration is fixed.',
  VALIDATION_ERROR:
    'EMAIL_REJECTED: the email provider rejected the message as invalid. ' +
    'Job dead-letters (non-retryable).',
  PROVIDER_ERROR:
    'EMAIL_SEND_FAILED: the email provider could not complete the send. ' +
    'The job will be retried.',
};

export async function sendViaResend(
  request: EmailSendRequest,
  deps: SendViaResendDeps = {},
): Promise<EmailSendResult> {
  const from = request.from ?? env.EMAIL_FROM;
  if (!from) {
    throw new EmailSendError(
      'CONFIG_ERROR',
      'EMAIL_FROM_UNCONFIGURED: set EMAIL_FROM to a sending address on a ' +
        'Resend-verified domain. Job dead-letters (non-retryable) until configured.',
    );
  }

  const send = deps.sendImpl ?? defaultSend;
  let outcome: ResendSendOutcome;
  try {
    outcome = await send(
      {
        from,
        to: request.to,
        subject: request.subject,
        ...(request.text !== undefined ? { text: request.text } : {}),
        ...(request.html !== undefined ? { html: request.html } : {}),
      },
      { idempotencyKey: request.idempotencyKey },
    );
  } catch (e) {
    // An EmailSendError from the default sender is already normalised
    // (e.g. the unconfigured-credential throw above) — pass it through.
    if (e instanceof EmailSendError) throw e;
    console.error('[integrations/email] provider request threw', {
      name: e instanceof Error ? e.name : typeof e,
    });
    throw new EmailSendError('PROVIDER_ERROR', PROVIDER_ERROR_MESSAGES.PROVIDER_ERROR);
  }

  if (outcome.error) {
    const code = normaliseResendErrorName(outcome.error.name);
    console.error('[integrations/email] provider send failed', {
      providerError: outcome.error.name,
      code,
    });
    throw new EmailSendError(code, PROVIDER_ERROR_MESSAGES[code], outcome.error.name);
  }

  if (!outcome.data?.id) {
    throw new EmailSendError('PROVIDER_ERROR', PROVIDER_ERROR_MESSAGES.PROVIDER_ERROR);
  }

  return { messageId: outcome.data.id, idempotencyKey: request.idempotencyKey };
}
