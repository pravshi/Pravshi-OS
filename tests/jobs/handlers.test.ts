/**
 * Phase 6 — job handler unit tests (Job Handler Engineer).
 *
 * Pure-function and validation-path tests: no database, no network, no real
 * provider. Handlers are expected to throw BEFORE any I/O on invalid input,
 * which is what these tests pin down. classifyError() (retry.ts) is used to
 * assert the retryability contract: validation/config errors must be
 * NON-retryable so bad jobs dead-letter instead of retry-looping.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/jobs/worker', () => ({
  registerHandler: vi.fn(),
}));

// Phase 8 integration (Workstream G): pin the duplicate-redelivery contract.
// withAuthorizedDb is mocked so no real database is touched.
vi.mock('../../src/lib/db/authorized', () => ({
  withAuthorizedDb: vi.fn(),
}));

// Phase 10 (Wave P): the Resend SDK is stubbed so the wired email adapter
// path can be asserted without network access or a real provider account.
const resendMocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendMocks.send };
  },
}));

import type { JobExecutionContext } from '../../src/lib/jobs/worker';
import {
  assertValidEmailAddress,
  buildEmailIdempotencyKey,
  classifyWebhookStatus,
  handleCleanup,
  handleEmail,
  handleNotification,
  normalizeCleanupPayload,
  normalizeEmailPayload,
  normalizeNotificationPayload,
  normalizeWebhookPayload,
  signWebhookBody,
} from '../../src/lib/jobs/handlers';
import { classifyError } from '../../src/lib/jobs/retry';
import { env } from '../../src/env';
import type { Job } from '../../src/lib/jobs/types';
import { withAuthorizedDb } from '../../src/lib/db/authorized';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PERSON_ID = '22222222-2222-4222-8222-222222222222';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    orgId: ORG_ID,
    type: 'notification',
    status: 'running',
    priority: 0,
    payload: {},
    attempts: 1,
    maxAttempts: 5,
    nextRunAt: new Date().toISOString(),
    claimedBy: 'worker-1',
    claimedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    dedupKey: 'dedup-1',
    errorCode: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCtx(job: Job): JobExecutionContext {
  return {
    job,
    auth: {
      ctx: { personId: 'system', orgId: job.orgId, aal: 'aal1' },
      permission: 'jobs.create',
      scope: 'ORGANIZATION',
      aal: 'aal1',
      requestId: 'test-request',
      meta: {},
    } as unknown as JobExecutionContext['auth'],
    signal: new AbortController().signal,
  };
}

/** Assert a thrown handler error classifies as non-retryable. */
async function expectNonRetryable(fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const classified = classifyError(err);
    expect(classified.retryable).toBe(false);
    return;
  }
  throw new Error('expected handler to throw');
}

describe('normalizeNotificationPayload', () => {
  it('accepts the canonical types.ts shape', () => {
    const n = normalizeNotificationPayload({
      personId: PERSON_ID,
      title: 'Deal moved',
      message: 'Acme deal moved to Negotiation',
      data: { dealId: 'x' },
    });
    expect(n).toEqual({
      personId: PERSON_ID,
      title: 'Deal moved',
      message: 'Acme deal moved to Negotiation',
      data: { dealId: 'x' },
      // Phase 8: event type / idempotency key folded out of data.
      type: 'SYSTEM_ALERT',
      eventId: null,
    });
  });

  it('accepts the task-contract alias shape (recipientPersonId/body/entityType/entityId)', () => {
    const n = normalizeNotificationPayload({
      recipientPersonId: PERSON_ID,
      title: 'Hi',
      body: 'Hello there',
      entityType: 'deal',
      entityId: 'deal-1',
    });
    expect(n).toEqual({
      personId: PERSON_ID,
      title: 'Hi',
      message: 'Hello there',
      data: { entityType: 'deal', entityId: 'deal-1' },
      // Phase 8: event type / idempotency key folded out of data.
      type: 'SYSTEM_ALERT',
      eventId: null,
    });
  });

  it('allows org-broadcast notifications (no recipient)', () => {
    const n = normalizeNotificationPayload({ title: 'T', message: 'M' });
    expect(n.personId).toBeNull();
  });

  it('rejects empty title / message (non-retryable)', async () => {
    await expectNonRetryable(() => normalizeNotificationPayload({ title: '', message: 'M' }));
    await expectNonRetryable(() => normalizeNotificationPayload({ title: 'T', message: '' }));
  });

  it('rejects malformed personId (non-retryable)', async () => {
    await expectNonRetryable(() =>
      normalizeNotificationPayload({ personId: 'not-a-uuid', title: 'T', message: 'M' }),
    );
  });
});

describe('handleNotification validation', () => {
  it('throws non-retryable on invalid payload without touching the DB', async () => {
    const ctx = makeCtx(makeJob({ type: 'notification', payload: { title: '', message: 'x' } }));
    await expectNonRetryable(() => handleNotification(ctx));
  });
});

describe('assertValidEmailAddress', () => {
  it('accepts normal addresses', () => {
    expect(() => assertValidEmailAddress('ops@example.com')).not.toThrow();
    expect(() => assertValidEmailAddress('first.last+tag@sub.example.co')).not.toThrow();
  });

  it('rejects malformed addresses as non-retryable', async () => {
    for (const bad of ['nope', 'a@b', '@example.com', 'a b@example.com', 'x'.repeat(400)]) {
      await expectNonRetryable(() => assertValidEmailAddress(bad));
    }
  });
});

describe('normalizeEmailPayload', () => {
  it('accepts the canonical shape with text', () => {
    const e = normalizeEmailPayload({
      to: 'ops@example.com',
      subject: 'S',
      text: 'hello',
    });
    expect(e).toEqual({ to: ['ops@example.com'], subject: 'S', text: 'hello', html: undefined });
  });

  it('accepts multiple recipients', () => {
    const e = normalizeEmailPayload({
      to: ['a@example.com', 'b@example.com'],
      subject: 'S',
      html: '<p>hi</p>',
    });
    expect(e.to).toHaveLength(2);
  });

  it('accepts the task-contract alias shape (bodyText/bodyHtml)', () => {
    const e = normalizeEmailPayload({
      to: 'ops@example.com',
      subject: 'S',
      bodyText: 'plain',
      bodyHtml: '<p>rich</p>',
    });
    expect(e.text).toBe('plain');
    expect(e.html).toBe('<p>rich</p>');
  });

  it('rejects payloads with no body at all (non-retryable)', async () => {
    await expectNonRetryable(() => normalizeEmailPayload({ to: 'a@example.com', subject: 'S' }));
  });

  it('rejects invalid recipient addresses (non-retryable)', async () => {
    await expectNonRetryable(() =>
      normalizeEmailPayload({ to: 'not-an-email', subject: 'S', text: 'x' }),
    );
  });
});

describe('handleEmail', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.EMAIL_PROVIDER;
    delete process.env.EMAIL_PROVIDER_API_KEY;
    resendMocks.send.mockReset();
    resendMocks.send.mockResolvedValue({ data: { id: 'msg-test' }, error: null });
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('throws non-retryable on invalid payload before provider check', async () => {
    const ctx = makeCtx(
      makeJob({ type: 'email', payload: { to: 'bad', subject: 'S', text: 'x' } }),
    );
    await expectNonRetryable(() => handleEmail(ctx));
  });

  it('throws EMAIL_PROVIDER_UNCONFIGURED (non-retryable) when no provider is configured', async () => {
    const ctx = makeCtx(
      makeJob({
        type: 'email',
        payload: { to: 'ops@example.com', subject: 'S', text: 'hello' },
      }),
    );
    try {
      await handleEmail(ctx);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).toContain('EMAIL_PROVIDER_UNCONFIGURED');
      expect((err as { code?: string }).code).toBe('CONFIG_ERROR');
      expect(classifyError(err).retryable).toBe(false);
    }
  });

  it('sends through the Resend adapter when EMAIL_PROVIDER=resend is configured', async () => {
    const prevProvider = env.EMAIL_PROVIDER;
    const prevKey = env.EMAIL_PROVIDER_API_KEY;
    const prevFrom = env.EMAIL_FROM;
    env.EMAIL_PROVIDER = 'resend';
    env.EMAIL_PROVIDER_API_KEY = 'test-api-key';
    env.EMAIL_FROM = 'no-reply@example.com';
    try {
      const job = makeJob({
        type: 'email',
        payload: { to: 'ops@example.com', subject: 'S', text: 'hello' },
      });
      await expect(handleEmail(makeCtx(job))).resolves.toBeUndefined();
      expect(resendMocks.send).toHaveBeenCalledTimes(1);
      expect(resendMocks.send).toHaveBeenCalledWith(
        { from: 'no-reply@example.com', to: ['ops@example.com'], subject: 'S', text: 'hello' },
        { idempotencyKey: buildEmailIdempotencyKey(job) },
      );
    } finally {
      env.EMAIL_PROVIDER = prevProvider;
      env.EMAIL_PROVIDER_API_KEY = prevKey;
      env.EMAIL_FROM = prevFrom;
    }
  });

  it('sends through Resend with only RESEND_API_KEY + EMAIL_FROM (the documented configuration)', async () => {
    const prevProvider = env.EMAIL_PROVIDER;
    const prevJobKey = env.EMAIL_PROVIDER_API_KEY;
    const prevResendKey = env.RESEND_API_KEY;
    const prevFrom = env.EMAIL_FROM;
    env.EMAIL_PROVIDER = undefined;
    env.EMAIL_PROVIDER_API_KEY = undefined;
    env.RESEND_API_KEY = 'test-auth-key';
    env.EMAIL_FROM = 'no-reply@example.com';
    try {
      const job = makeJob({
        type: 'email',
        payload: { to: 'ops@example.com', subject: 'Reset', text: 'link' },
      });
      await expect(handleEmail(makeCtx(job))).resolves.toBeUndefined();
      expect(resendMocks.send).toHaveBeenCalledTimes(1);
    } finally {
      env.EMAIL_PROVIDER = prevProvider;
      env.EMAIL_PROVIDER_API_KEY = prevJobKey;
      env.RESEND_API_KEY = prevResendKey;
      env.EMAIL_FROM = prevFrom;
    }
  });

  it('normalises a Resend transport failure to a retryable PROVIDER_ERROR', async () => {
    const prevProvider = env.EMAIL_PROVIDER;
    const prevKey = env.EMAIL_PROVIDER_API_KEY;
    const prevFrom = env.EMAIL_FROM;
    env.EMAIL_PROVIDER = 'resend';
    env.EMAIL_PROVIDER_API_KEY = 'test-api-key';
    env.EMAIL_FROM = 'no-reply@example.com';
    resendMocks.send.mockResolvedValueOnce({
      data: null,
      error: {
        name: 'application_error',
        statusCode: null,
        message: 'Unable to fetch data. The request could not be resolved.',
      },
    });
    try {
      const ctx = makeCtx(
        makeJob({
          type: 'email',
          payload: { to: 'ops@example.com', subject: 'S', text: 'hello' },
        }),
      );
      try {
        await handleEmail(ctx);
        throw new Error('expected throw');
      } catch (err) {
        expect((err as Error).message).toContain('EMAIL_SEND_FAILED');
        expect((err as Error).message).not.toContain('EMAIL_PROVIDER_NOT_IMPLEMENTED');
        expect((err as { code?: string }).code).toBe('PROVIDER_ERROR');
        expect(classifyError(err).retryable).toBe(true);
      }
    } finally {
      env.EMAIL_PROVIDER = prevProvider;
      env.EMAIL_PROVIDER_API_KEY = prevKey;
      env.EMAIL_FROM = prevFrom;
    }
  });

  it('throws EMAIL_PROVIDER_NOT_IMPLEMENTED (non-retryable) for an unknown provider', async () => {
    // Fail closed: a provider name with no adapter must never let the job
    // report success without an actual transmission.
    const prevProvider = env.EMAIL_PROVIDER;
    const prevKey = env.EMAIL_PROVIDER_API_KEY;
    env.EMAIL_PROVIDER = 'smtp';
    env.EMAIL_PROVIDER_API_KEY = 'test-api-key';
    try {
      const ctx = makeCtx(
        makeJob({
          type: 'email',
          payload: { to: 'ops@example.com', subject: 'S', text: 'hello' },
        }),
      );
      try {
        await handleEmail(ctx);
        throw new Error('expected throw');
      } catch (err) {
        expect((err as Error).message).toContain('EMAIL_PROVIDER_NOT_IMPLEMENTED');
        expect((err as { code?: string }).code).toBe('CONFIG_ERROR');
        expect(classifyError(err).retryable).toBe(false);
      }
      expect(resendMocks.send).not.toHaveBeenCalled();
    } finally {
      env.EMAIL_PROVIDER = prevProvider;
      env.EMAIL_PROVIDER_API_KEY = prevKey;
    }
  });
});

describe('buildEmailIdempotencyKey', () => {
  it('is deterministic per job and incorporates the dedup key', () => {
    const job = makeJob({ dedupKey: 'k1' });
    expect(buildEmailIdempotencyKey(job)).toBe(buildEmailIdempotencyKey(job));
    expect(buildEmailIdempotencyKey(job)).toContain(job.id);
    expect(buildEmailIdempotencyKey(job)).toContain('k1');
    expect(buildEmailIdempotencyKey(makeJob({ dedupKey: null }))).toContain('no-dedup');
  });
});

describe('normalizeWebhookPayload', () => {
  it('accepts a minimal webhook payload with defaults', () => {
    const w = normalizeWebhookPayload({ url: 'https://example.com/hook' });
    expect(w.url).toBe('https://example.com/hook');
    expect(w.method).toBe('POST');
    expect(w.timeoutMs).toBe(10000);
    expect(w.signatureSecret).toBeUndefined();
  });

  it('rejects non-http(s) schemes (non-retryable)', async () => {
    await expectNonRetryable(() => normalizeWebhookPayload({ url: 'ftp://example.com/hook' }));
  });

  it('rejects out-of-range timeouts (non-retryable)', async () => {
    await expectNonRetryable(() =>
      normalizeWebhookPayload({ url: 'https://example.com/', timeoutMs: 999999 }),
    );
  });

  it('accepts the task-contract inline signatureSecret (takes precedence over ref)', () => {
    process.env.WEBHOOK_SIGNING_SECRET_ACME = 'from-ref';
    const w = normalizeWebhookPayload({
      url: 'https://example.com/hook',
      signatureSecret: 'inline-secret',
      signatureSecretRef: 'acme',
    });
    expect(w.signatureSecret).toBe('inline-secret');
    delete process.env.WEBHOOK_SIGNING_SECRET_ACME;
  });

  it('resolves signatureSecretRef from the environment (value never in output)', () => {
    process.env.WEBHOOK_SIGNING_SECRET_ACME = 's3cr3t';
    const w = normalizeWebhookPayload({
      url: 'https://example.com/hook',
      signatureSecretRef: 'acme',
    });
    expect(w.signatureSecret).toBe('s3cr3t');
    delete process.env.WEBHOOK_SIGNING_SECRET_ACME;
  });

  it('throws CONFIG_ERROR (non-retryable) when a secret ref is unconfigured', async () => {
    delete process.env.WEBHOOK_SIGNING_SECRET_MISSING;
    await expectNonRetryable(() =>
      normalizeWebhookPayload({
        url: 'https://example.com/hook',
        signatureSecretRef: 'missing',
      }),
    );
  });

  it('strips caller-supplied signature headers (anti-spoofing)', () => {
    const w = normalizeWebhookPayload({
      url: 'https://example.com/hook',
      headers: { 'X-Pravshi-Signature': 'sha256=fake', 'X-Other': 'ok' },
    });
    expect(w.headers['X-Pravshi-Signature']).toBeUndefined();
    expect(w.headers['X-Other']).toBe('ok');
  });
});

describe('signWebhookBody', () => {
  it('produces a deterministic sha256= HMAC', () => {
    const body = Buffer.from('{"a":1}', 'utf8');
    const a = signWebhookBody(body, 'secret');
    const b = signWebhookBody(body, 'secret');
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signWebhookBody(body, 'other')).not.toBe(a);
  });
});

describe('classifyWebhookStatus', () => {
  it('maps 2xx → ok, 4xx → client-error, 5xx/3xx → server-error', () => {
    expect(classifyWebhookStatus(200)).toBe('ok');
    expect(classifyWebhookStatus(201)).toBe('ok');
    expect(classifyWebhookStatus(204)).toBe('ok');
    expect(classifyWebhookStatus(400)).toBe('client-error');
    expect(classifyWebhookStatus(404)).toBe('client-error');
    expect(classifyWebhookStatus(429)).toBe('client-error');
    expect(classifyWebhookStatus(500)).toBe('server-error');
    expect(classifyWebhookStatus(503)).toBe('server-error');
  });
});

describe('normalizeCleanupPayload', () => {
  it('accepts stale_jobs with 90-day default retention', () => {
    const c = normalizeCleanupPayload({ target: 'stale_jobs' });
    expect(c.target).toBe('stale_jobs');
    expect(c.olderThanDays).toBe(90);
    expect(c.dryRun).toBe(false);
  });

  it('accepts expired_leases with default 5-minute staleness', () => {
    const c = normalizeCleanupPayload({ target: 'expired_leases' });
    expect(c.target).toBe('expired_leases');
    expect(c.staleThresholdMs).toBe(5 * 60 * 1000);
  });

  it('honors dryRun and params.staleThresholdMs', () => {
    const c = normalizeCleanupPayload({
      target: 'expired_leases',
      dryRun: true,
      params: { staleThresholdMs: 60_000 },
    });
    expect(c.dryRun).toBe(true);
    expect(c.staleThresholdMs).toBe(60_000);
  });

  it('rejects unknown targets (non-retryable)', async () => {
    await expectNonRetryable(() => normalizeCleanupPayload({ target: 'everything' }));
  });
});

describe('handleCleanup validation', () => {
  it('throws non-retryable on unknown target without touching the DB', async () => {
    const ctx = makeCtx(makeJob({ type: 'cleanup', payload: { target: 'nuke' } }));
    await expectNonRetryable(() => handleCleanup(ctx));
  });
});

describe('handleNotification duplicate dedupe (Phase 8, 0052)', () => {
  const dbMock = vi.mocked(withAuthorizedDb);

  beforeEach(() => {
    dbMock.mockReset();
  });

  it('treats a 23505 from the (org_id, event_id) unique index as success-no-op', async () => {
    // A redelivered event: the earlier attempt already wrote the row, so the
    // (org_id, event_id) unique partial index raises 23505. The DB has
    // already deduped; the job must resolve (no crash, no retry) rather
    // than failing.
    const dbErr = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
    dbMock.mockImplementation(async (_ctx, fn) => {
      await fn({
        execute: async () => {
          throw dbErr;
        },
      } as never);
      return undefined as never;
    });
    const ctx = makeCtx(
      makeJob({
        type: 'notification',
        payload: {
          title: 'Task assigned',
          message: 'You got a task',
          data: { eventId: 'evt-123' },
        },
      }),
    );
    await expect(handleNotification(ctx)).resolves.toBeUndefined();
    expect(dbMock).toHaveBeenCalled();
  });

  it('still throws on non-23505 database errors', async () => {
    const dbErr = Object.assign(new Error('connection reset'), { code: '08006' });
    dbMock.mockImplementation(async (_ctx, fn) => {
      await fn({
        execute: async () => {
          throw dbErr;
        },
      } as never);
      return undefined as never;
    });
    const ctx = makeCtx(
      makeJob({
        type: 'notification',
        payload: { title: 'Task assigned', message: 'You got a task' },
      }),
    );
    await expect(handleNotification(ctx)).rejects.toThrow('connection reset');
  });
});
