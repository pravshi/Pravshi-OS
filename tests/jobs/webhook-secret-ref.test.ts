/**
 * B3 — deployment signing secrets are not available to webhook jobs.
 *
 * Every webhook job is enqueued under a tenant's authority (the workflow action, the
 * subscription fan-out), so a `signatureSecretRef` (env WEBHOOK_SIGNING_SECRET_<REF>) in a
 * job payload let a tenant have its own URL signed with a deployment secret. Proven here,
 * with DNS and node:http(s) faked so no connection is ever opened:
 *   - enqueue's payload schema refuses the ref, and an inline secret;
 *   - a job stored before B3 that still carries the ref fails non-retryably, before any DNS
 *     lookup or request, even when the referenced deployment secret IS configured — it is
 *     neither signed with it nor sent unsigned in its place;
 *   - a subscription delivery is still signed with the subscription's own secret, resolved
 *     in the worker (the database read and decryption are stubbed);
 *   - a URL delivery without a subscription is sent unsigned.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/jobs/handler-registry', () => ({
  registerHandler: vi.fn(),
}));

type LookupFn = (
  hostname: string,
  options: { all?: boolean },
  callback: (err: Error | null, address: unknown, family?: number) => void,
) => void;

const { dnsLookup, requests, resolveDelivery } = vi.hoisted(() => ({
  dnsLookup: vi.fn(),
  requests: [] as Array<{ url: string; headers: Record<string, string>; body: string }>,
  resolveDelivery: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({ lookup: dnsLookup, default: { lookup: dnsLookup } }));

function fakeRequest(
  url: URL,
  options: { headers: Record<string, string>; lookup: LookupFn },
  onResponse: (res: EventEmitter & { statusCode: number; headers: object }) => void,
) {
  const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const chunks: Buffer[] = [];
  req.setTimeout = () => req;
  req.destroy = (err?: Error) => req.emit('error', err ?? new Error('destroyed'));
  req.write = (c: Buffer) => chunks.push(c);
  req.end = () => {
    requests.push({
      url: url.toString(),
      headers: { ...options.headers },
      body: Buffer.concat(chunks).toString(),
    });
    const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
    queueMicrotask(() => {
      onResponse(res);
      res.emit('end');
    });
  };
  return req;
}

vi.mock('node:http', () => ({ request: fakeRequest, default: { request: fakeRequest } }));
vi.mock('node:https', () => ({ request: fakeRequest, default: { request: fakeRequest } }));

// The subscription's secret: the worker-plane read (0059 definer) and the vault decryption.
vi.mock('../../src/lib/db/worker-pool', () => ({
  withWorkerContext: (_ctx: unknown, _item: unknown, fn: (tx: unknown) => unknown) =>
    fn({ execute: resolveDelivery }),
}));
vi.mock('../../src/lib/integrations/secrets', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  decryptSecret: (ciphertext: string) => `plain-of-${ciphertext}`,
}));

import { classifyError } from '../../src/lib/jobs/retry';
import {
  handleWebhook,
  normalizeWebhookPayload,
  signWebhookBody,
} from '../../apps/worker/src/handlers';
import { WebhookPayloadSchema } from '../../src/lib/jobs/types';
import type { JobExecutionContext } from '../../src/lib/jobs/handler-registry';

const SUB_ID = '0b5c8f5e-7a8f-4c1e-9d3e-2f6a1b9c4d70';
const DEPLOYMENT_SECRET = 'test-only-deployment-signing-value';

function run(payload: Record<string, unknown>) {
  const ctx = {
    job: { id: '00000000-0000-4000-8000-000000000001', orgId: 'org', payload },
    auth: { ctx: {} },
    signal: new AbortController().signal,
    workerId: 'worker-test',
  } as unknown as JobExecutionContext;
  return handleWebhook(ctx);
}

async function failure(fn: () => unknown): Promise<{ code: string; message: string }> {
  try {
    await fn();
  } catch (error) {
    const classified = classifyError(error);
    expect(classified.retryable).toBe(false);
    return { code: classified.code, message: (error as Error).message };
  }
  throw new Error('expected a failure');
}

beforeEach(() => {
  requests.length = 0;
  dnsLookup.mockReset();
  dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  resolveDelivery.mockReset();
  // A configured deployment secret: the refusal must not depend on it being absent.
  process.env.WEBHOOK_SIGNING_SECRET_ACME = DEPLOYMENT_SECRET;
});
afterEach(() => {
  delete process.env.WEBHOOK_SIGNING_SECRET_ACME;
});

describe('enqueue: the webhook payload schema', () => {
  it('refuses a deployment signatureSecretRef', () => {
    const parsed = WebhookPayloadSchema.safeParse({
      url: 'https://hooks.example.com/x',
      signatureSecretRef: 'ACME',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses one alongside a subscriptionId, and an inline secret', () => {
    for (const payload of [
      { url: 'https://hooks.example.com/x', subscriptionId: SUB_ID, signatureSecretRef: 'ACME' },
      { url: 'https://hooks.example.com/x', signatureSecret: 'inline' },
    ]) {
      expect(WebhookPayloadSchema.safeParse(payload).success).toBe(false);
    }
  });

  it('still accepts the URL and subscription shapes', () => {
    expect(WebhookPayloadSchema.safeParse({ url: 'https://hooks.example.com/x' }).success).toBe(
      true,
    );
    expect(
      WebhookPayloadSchema.safeParse({ url: 'https://hooks.example.com/x', subscriptionId: SUB_ID })
        .success,
    ).toBe(true);
  });
});

describe('handler: a job stored before B3 with a signatureSecretRef', () => {
  it('normalizeWebhookPayload refuses it (VALIDATION_ERROR, non-retryable), naming no secret', async () => {
    const { code, message } = await failure(() =>
      normalizeWebhookPayload({ url: 'https://hooks.example.com/x', signatureSecretRef: 'acme' }),
    );
    expect(code).toBe('VALIDATION_ERROR');
    expect(message).toMatch(/signatureSecretRef is not supported/);
    expect(message).not.toContain(DEPLOYMENT_SECRET);
  });

  it('refuses it whatever the value — empty, unconfigured or not a string', async () => {
    for (const ref of ['', 'unconfigured', 42, null]) {
      const { code } = await failure(() =>
        normalizeWebhookPayload({ url: 'https://hooks.example.com/x', signatureSecretRef: ref }),
      );
      expect(code).toBe('VALIDATION_ERROR');
    }
  });

  it('handleWebhook fails before any DNS lookup or request — nothing is sent', async () => {
    const { code } = await failure(() =>
      run({ url: 'https://hooks.example.com/x', body: { a: 1 }, signatureSecretRef: 'acme' }),
    );
    expect(code).toBe('VALIDATION_ERROR');
    expect(dnsLookup).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it('a subscription delivery carrying one is refused too, and never sent', async () => {
    resolveDelivery.mockResolvedValue({
      rows: [{ is_active: true, signing_secret_ciphertext: 'cipher' }],
    });
    const { code } = await failure(() =>
      run({
        url: 'https://hooks.example.com/x',
        subscriptionId: SUB_ID,
        signatureSecretRef: 'acme',
      }),
    );
    expect(code).toBe('VALIDATION_ERROR');
    expect(requests).toHaveLength(0);
  });
});

describe('handler: legitimate deliveries', () => {
  it('a subscription delivery is signed with the subscription’s own secret', async () => {
    resolveDelivery.mockResolvedValue({
      rows: [{ is_active: true, signing_secret_ciphertext: 'cipher' }],
    });
    await run({ url: 'https://hooks.example.com/x', subscriptionId: SUB_ID, body: { a: 1 } });
    expect(resolveDelivery).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    const sent = requests[0]!;
    expect(sent.headers['x-pravshi-signature']).toBe(
      signWebhookBody(Buffer.from(sent.body), 'plain-of-cipher'),
    );
    expect(sent.headers['x-pravshi-signature']).not.toBe(
      signWebhookBody(Buffer.from(sent.body), DEPLOYMENT_SECRET),
    );
  });

  it('a URL delivery without a subscription is sent unsigned', async () => {
    await run({ url: 'https://hooks.example.com/x', body: { a: 1 } });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers['x-pravshi-signature']).toBeUndefined();
  });
});
