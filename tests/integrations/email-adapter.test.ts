/**
 * Phase 10 (Wave P) — Resend email adapter + handler provider selection.
 *
 * DB-free by construction: the adapter is exercised through an injected
 * stub send function, and the handler's selection logic is exercised with
 * the worker registry and authorized-DB modules mocked out (the exact
 * pattern tests/jobs/handlers.test.ts uses) — no database, no network, no
 * real provider. classifyError() (src/lib/jobs/retry.ts) pins the
 * retryability contract: config/validation failures must dead-letter,
 * transient provider failures must retry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/jobs/worker', () => ({
  registerHandler: vi.fn(),
}));

vi.mock('../../src/lib/db/authorized', () => ({
  withAuthorizedDb: vi.fn(),
}));

import { env } from '../../src/env';
import {
  EmailSendError,
  normaliseResendErrorName,
  resolveResendApiKey,
  sendViaResend,
  type EmailSendRequest,
  type ResendSendFn,
  type ResendSendOutcome,
} from '../../src/lib/integrations/providers/email/send';
import { sendEmailViaProvider, type EmailProviderInput } from '../../src/lib/jobs/handlers';
import { classifyError } from '../../src/lib/jobs/retry';
import type { Job } from '../../src/lib/jobs/types';

const SENTINEL_KEY = 're_SENTINEL_SECRET_KEY';
const REQUEST: EmailSendRequest = {
  to: ['ops@example.com'],
  subject: 'Deploy finished',
  text: 'The deploy finished.',
  idempotencyKey: 'pravshi-email:job-1:dedup-1',
  from: 'Pravshi OS <noreply@pravshi.example>',
};

const NO_FROM_REQUEST: EmailSendRequest = {
  to: REQUEST.to,
  subject: REQUEST.subject,
  text: REQUEST.text,
  idempotencyKey: REQUEST.idempotencyKey,
};

const ENV_KEYS = [
  'EMAIL_PROVIDER',
  'EMAIL_PROVIDER_API_KEY',
  'RESEND_API_KEY',
  'EMAIL_FROM',
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
let savedEnv: Record<EnvKey, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k]])) as Record<
    EnvKey,
    string | undefined
  >;
  for (const k of ENV_KEYS) env[k] = undefined;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) env[k] = savedEnv[k];
  vi.restoreAllMocks();
});

function stubReturning(
  outcome: ResendSendOutcome,
  calls?: { payload: unknown; options: unknown }[],
) {
  const stub: ResendSendFn = async (payload, options) => {
    calls?.push({ payload, options });
    return outcome;
  };
  return stub;
}

describe('sendViaResend — success path', () => {
  it('maps a successful send to the provider message id', async () => {
    const calls: { payload: unknown; options: unknown }[] = [];
    const result = await sendViaResend(REQUEST, {
      sendImpl: stubReturning({ data: { id: 'msg-123' }, error: null }, calls),
    });

    expect(result).toEqual({ messageId: 'msg-123', idempotencyKey: REQUEST.idempotencyKey });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toEqual({
      from: 'Pravshi OS <noreply@pravshi.example>',
      to: ['ops@example.com'],
      subject: 'Deploy finished',
      text: 'The deploy finished.',
    });
  });

  it('includes html only when present and omits absent body parts', async () => {
    const calls: { payload: unknown; options: unknown }[] = [];
    await sendViaResend(
      {
        to: ['a@example.com'],
        subject: 'S',
        html: '<p>hi</p>',
        idempotencyKey: 'k',
        from: 'f@example.com',
      },
      { sendImpl: stubReturning({ data: { id: 'm' }, error: null }, calls) },
    );
    expect(calls[0]?.payload).toEqual({
      from: 'f@example.com',
      to: ['a@example.com'],
      subject: 'S',
      html: '<p>hi</p>',
    });
    expect(calls[0]?.payload).not.toHaveProperty('text');
  });

  it('defaults the sender to EMAIL_FROM when the request names none', async () => {
    env.EMAIL_FROM = 'noreply@pravshi.example';
    const calls: { payload: unknown; options: unknown }[] = [];
    await sendViaResend(NO_FROM_REQUEST, {
      sendImpl: stubReturning({ data: { id: 'm' }, error: null }, calls),
    });
    expect(calls[0]?.payload).toMatchObject({ from: 'noreply@pravshi.example' });
  });
});

describe('sendViaResend — idempotency', () => {
  it('passes the job idempotency key in the send options, never the payload', async () => {
    const calls: { payload: unknown; options: unknown }[] = [];
    const stub = stubReturning({ data: { id: 'm' }, error: null }, calls);
    // A retried job re-invokes with the SAME key (handlers.ts derives it
    // deterministically from job id + dedup key); resend@6.30.0 turns the
    // option into the Idempotency-Key header, so the retry cannot
    // double-send.
    await sendViaResend(REQUEST, { sendImpl: stub });
    await sendViaResend(REQUEST, { sendImpl: stub });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.options).toEqual({ idempotencyKey: 'pravshi-email:job-1:dedup-1' });
    expect(calls[1]?.options).toEqual({ idempotencyKey: 'pravshi-email:job-1:dedup-1' });
    expect(calls[0]?.payload).not.toHaveProperty('idempotencyKey');
  });
});

describe('sendViaResend — provider error normalisation', () => {
  it('maps validation failures to non-retryable VALIDATION_ERROR without leaking provider text or the API key', async () => {
    env.EMAIL_PROVIDER_API_KEY = SENTINEL_KEY;
    const stub = stubReturning({
      data: null,
      error: {
        name: 'validation_error',
        message: `raw provider text mentioning ${SENTINEL_KEY} and recipient ops@example.com`,
        statusCode: 422,
      },
    });

    const err = await sendViaResend(REQUEST, { sendImpl: stub }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    const sendErr = err as EmailSendError;
    expect(sendErr.code).toBe('VALIDATION_ERROR');
    expect(sendErr.providerErrorName).toBe('validation_error');
    expect(sendErr.message).not.toContain(SENTINEL_KEY);
    expect(sendErr.message).not.toContain('raw provider text');
    expect(JSON.stringify(sendErr)).not.toContain(SENTINEL_KEY);
    expect(classifyError(err).retryable).toBe(false);
    // Nothing logged may carry the secret either.
    for (const call of vi.mocked(console.error).mock.calls) {
      expect(JSON.stringify(call)).not.toContain(SENTINEL_KEY);
    }
  });

  it('maps credential failures to non-retryable CONFIG_ERROR', async () => {
    const stub = stubReturning({
      data: null,
      error: { name: 'invalid_api_key', message: 'The API key is invalid', statusCode: 401 },
    });
    const err = await sendViaResend(REQUEST, { sendImpl: stub }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as EmailSendError).code).toBe('CONFIG_ERROR');
    expect(classifyError(err).retryable).toBe(false);
  });

  it('maps rate limits and provider 5xx to retryable PROVIDER_ERROR', async () => {
    for (const name of ['rate_limit_exceeded', 'internal_server_error']) {
      const stub = stubReturning({
        data: null,
        error: { name, message: 'transient', statusCode: 500 },
      });
      const err = await sendViaResend(REQUEST, { sendImpl: stub }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmailSendError);
      expect((err as EmailSendError).code).toBe('PROVIDER_ERROR');
      expect(classifyError(err).retryable).toBe(true);
    }
  });

  it('normalises a thrown transport failure without copying its message', async () => {
    const stub: ResendSendFn = async () => {
      throw new Error(`fetch failed while presenting ${SENTINEL_KEY}`);
    };
    const err = await sendViaResend(REQUEST, { sendImpl: stub }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as EmailSendError).code).toBe('PROVIDER_ERROR');
    expect((err as EmailSendError).message).not.toContain(SENTINEL_KEY);
    expect((err as EmailSendError).message).not.toContain('fetch failed');
    expect(classifyError(err).retryable).toBe(true);
  });

  it('treats a response with neither data nor error as a retryable provider failure', async () => {
    const stub = stubReturning({ data: null, error: null });
    const err = await sendViaResend(REQUEST, { sendImpl: stub }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as EmailSendError).code).toBe('PROVIDER_ERROR');
  });
});

describe('sendViaResend — configuration gates', () => {
  it('fails CONFIG_ERROR (EMAIL_PROVIDER_UNCONFIGURED) when no API key exists', async () => {
    env.EMAIL_FROM = 'noreply@pravshi.example';
    const err = await sendViaResend(NO_FROM_REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as EmailSendError).code).toBe('CONFIG_ERROR');
    expect((err as EmailSendError).message).toContain('EMAIL_PROVIDER_UNCONFIGURED');
    expect(classifyError(err).retryable).toBe(false);
  });

  it('fails CONFIG_ERROR (EMAIL_FROM_UNCONFIGURED) before sending when no sender is resolvable', async () => {
    const calls: { payload: unknown; options: unknown }[] = [];
    const err = await sendViaResend(NO_FROM_REQUEST, {
      sendImpl: stubReturning({ data: { id: 'm' }, error: null }, calls),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as EmailSendError).message).toContain('EMAIL_FROM_UNCONFIGURED');
    expect(calls).toHaveLength(0);
  });
});

describe('resolveResendApiKey / normaliseResendErrorName', () => {
  it('prefers EMAIL_PROVIDER_API_KEY and falls back to RESEND_API_KEY', () => {
    expect(resolveResendApiKey()).toBeNull();
    env.RESEND_API_KEY = 're_auth';
    expect(resolveResendApiKey()).toBe('re_auth');
    env.EMAIL_PROVIDER_API_KEY = 're_jobs';
    expect(resolveResendApiKey()).toBe('re_jobs');
  });

  it('classifies the full provider error-name surface', () => {
    expect(normaliseResendErrorName('missing_api_key')).toBe('CONFIG_ERROR');
    expect(normaliseResendErrorName('restricted_api_key')).toBe('CONFIG_ERROR');
    expect(normaliseResendErrorName('invalid_from_address')).toBe('VALIDATION_ERROR');
    expect(normaliseResendErrorName('invalid_idempotent_request')).toBe('VALIDATION_ERROR');
    expect(normaliseResendErrorName('monthly_quota_exceeded')).toBe('PROVIDER_ERROR');
    expect(normaliseResendErrorName('concurrent_idempotent_requests')).toBe('PROVIDER_ERROR');
    expect(normaliseResendErrorName('some_future_error')).toBe('PROVIDER_ERROR');
  });
});

describe('sendEmailViaProvider — provider selection', () => {
  function makeInput(): EmailProviderInput {
    return {
      job: { id: 'job-42' } as unknown as Job,
      to: ['ops@example.com'],
      subject: 'S',
      text: 'hello',
      idempotencyKey: 'pravshi-email:job-42:no-dedup',
    };
  }

  it('fails closed EMAIL_PROVIDER_UNCONFIGURED when EMAIL_PROVIDER is unset', async () => {
    const err = await sendEmailViaProvider(makeInput()).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('CONFIG_ERROR');
    expect((err as Error).message).toContain('EMAIL_PROVIDER_UNCONFIGURED');
    expect(classifyError(err).retryable).toBe(false);
  });

  it('fails closed EMAIL_PROVIDER_NOT_IMPLEMENTED for an unknown provider', async () => {
    env.EMAIL_PROVIDER = 'acme-mail';
    env.EMAIL_PROVIDER_API_KEY = 'some-key';
    const err = await sendEmailViaProvider(makeInput()).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('CONFIG_ERROR');
    expect((err as Error).message).toContain('EMAIL_PROVIDER_NOT_IMPLEMENTED');
    expect(classifyError(err).retryable).toBe(false);
  });

  it('keeps the unconfigured gate for an unknown provider with no key', async () => {
    env.EMAIL_PROVIDER = 'acme-mail';
    const err = await sendEmailViaProvider(makeInput()).catch((e: unknown) => e);
    expect((err as Error).message).toContain('EMAIL_PROVIDER_UNCONFIGURED');
  });

  it('routes resend to the real adapter instead of the fail-closed stub', async () => {
    env.EMAIL_PROVIDER = 'resend';
    // Nothing else configured: the ADAPTER's own unconfigured error must
    // surface (EMAIL_FROM is checked before any send) — never the stub's
    // NOT_IMPLEMENTED.
    const err = await sendEmailViaProvider(makeInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as { code?: string }).code).toBe('CONFIG_ERROR');
    expect((err as Error).message).toContain('EMAIL_FROM_UNCONFIGURED');
    expect((err as Error).message).not.toContain('NOT_IMPLEMENTED');
  });

  // The documented configuration (DEPLOYMENT.md): RESEND_API_KEY + EMAIL_FROM, no
  // EMAIL_PROVIDER. Password-reset email is an `email` job, so this path must reach
  // the adapter rather than dead-letter as unconfigured.
  it('defaults to the Resend adapter when only RESEND_API_KEY is configured', async () => {
    env.RESEND_API_KEY = 're_auth';
    const err = await sendEmailViaProvider(makeInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as Error).message).toContain('EMAIL_FROM_UNCONFIGURED');
    expect((err as Error).message).not.toContain('EMAIL_PROVIDER_UNCONFIGURED');
  });

  it('lets an explicit EMAIL_PROVIDER win over the RESEND_API_KEY default', async () => {
    env.RESEND_API_KEY = 're_auth';
    env.EMAIL_PROVIDER = 'acme-mail';
    env.EMAIL_PROVIDER_API_KEY = 'some-key';
    const err = await sendEmailViaProvider(makeInput()).catch((e: unknown) => e);
    expect((err as Error).message).toContain('EMAIL_PROVIDER_NOT_IMPLEMENTED');
  });
});
