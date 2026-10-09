import { describe, expect, it, vi } from 'vitest';

// handlers.ts registers its handlers at module load; stub the registry
// (the handlers-ssrf.test.ts pattern) so importing it stays DB-free.
vi.mock('../../src/lib/jobs/worker', () => ({
  registerHandler: vi.fn(),
}));

import {
  INTEGRATION_EVENT_KEYS,
  WORKFLOW_ACTION_EVENT_KEY,
  buildEventEnvelope,
  buildFanoutDedupKey,
  isIntegrationEventKey,
  selectSubscriptionsForEvent,
  validateSubscriptionEvents,
} from '@/lib/integrations/fanout';
import {
  DELIVERIES_SUBSCRIPTION_FK,
  assertSubscriptionUrlAllowed,
  generateSigningSecret,
  isDeliveryHistoryConflict,
  toSubscriptionSummary,
} from '@/lib/integrations/subscriptions';
import { isIntegrationsError } from '@/lib/integrations/errors';
import { decryptSecret, encryptSecret, serialiseEnvelope } from '@/lib/integrations/secrets';
import { normalizeWebhookPayload } from '@/lib/jobs/handlers';
import { WebhookPayloadSchema } from '@/lib/jobs/types';
import { ACTION_REGISTRY, REGISTRY_DEFERRED_ACTION_TYPES } from '@/lib/workflows/actions';
import { ActionConfigSchema, WebhookActionParamsSchema } from '@/lib/workflows/schema';

/**
 * Outbound webhooks unit suite (Phase 10, Wave W-out). DB-free by design —
 * the Nov-1 rule forbids local database connections, so this suite covers
 * exactly the pure logic: the event catalogue, envelope shaping, dedup
 * keys, subscription matching, signing-secret generation and the
 * once-only DTO shaping, the create-time SSRF fail-fast (static check
 * only — the delivery-time guard has its own suite,
 * tests/jobs/handlers-ssrf.test.ts), the job payload contract, and the
 * workflow `webhook` action's save-time + registry enablement. Everything
 * that touches Postgres (subscription CRUD under RLS, fan-out enqueue,
 * handler-side secret resolution) is covered by the CI-run DB suites
 * (Wave J).
 */

const SUB_ID = '11111111-1111-4111-8111-111111111111';
const SUB_ID_2 = '22222222-2222-4222-8222-222222222222';
const DELIVERY_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '44444444-4444-4444-8444-444444444444';

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('event catalogue', () => {
  it('is exactly the five keys with verified emission points', () => {
    expect([...INTEGRATION_EVENT_KEYS]).toEqual([
      'workflow.completed',
      'workflow.failed',
      'deal.won',
      'deal.lost',
      'task.completed',
    ]);
    // The workflow-action deliveries marker is NOT a subscribable key.
    expect(isIntegrationEventKey(WORKFLOW_ACTION_EVENT_KEY)).toBe(false);
  });

  it('recognises catalogue keys and rejects everything else', () => {
    for (const key of INTEGRATION_EVENT_KEYS) expect(isIntegrationEventKey(key)).toBe(true);
    for (const bad of [
      'deal.closed',
      'task.done',
      'workflow.succeeded',
      '',
      'DEAL.WON',
      null,
      42,
    ]) {
      expect(isIntegrationEventKey(bad)).toBe(false);
    }
  });

  it('validateSubscriptionEvents accepts catalogue keys, rejects unknown/duplicate/empty', () => {
    expect(validateSubscriptionEvents(['deal.won', 'task.completed'])).toEqual([
      'deal.won',
      'task.completed',
    ]);
    for (const bad of [
      [],
      ['deal.won', 'deal.won'],
      ['deal.closed'],
      ['workflow.completed', 'x'],
    ]) {
      const error = caught(() => validateSubscriptionEvents(bad));
      expect(isIntegrationsError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('VALIDATION');
    }
  });

  it('selectSubscriptionsForEvent keeps only active subscribers to the event', () => {
    const rows = [
      {
        id: SUB_ID,
        url: 'https://a.example/hook',
        active: true,
        events: ['deal.won', 'deal.lost'],
      },
      { id: SUB_ID_2, url: 'https://b.example/hook', active: false, events: ['deal.won'] },
      {
        id: DELIVERY_ID,
        url: 'https://c.example/hook',
        active: true,
        events: ['task.completed'],
      },
    ];
    expect(selectSubscriptionsForEvent(rows, 'deal.won')).toEqual([
      { id: SUB_ID, url: 'https://a.example/hook', active: true },
    ]);
    expect(selectSubscriptionsForEvent(rows, 'workflow.failed')).toEqual([]);
  });
});

describe('event envelope', () => {
  it('shapes { id, type, created_at, org_id, data } with id = the delivery id', () => {
    const occurredAt = new Date('2026-10-09T10:00:00.000Z');
    const envelope = buildEventEnvelope({
      deliveryId: DELIVERY_ID,
      eventKey: 'deal.won',
      orgId: ORG_ID,
      data: { deal_id: 'd1', value: '100' },
      occurredAt,
    });
    expect(envelope).toEqual({
      id: DELIVERY_ID,
      type: 'deal.won',
      created_at: '2026-10-09T10:00:00.000Z',
      org_id: ORG_ID,
      data: { deal_id: 'd1', value: '100' },
    });
    expect(Object.keys(envelope)).toEqual(['id', 'type', 'created_at', 'org_id', 'data']);
  });
});

describe('fan-out dedup keys', () => {
  it('are deterministic per (event, subscription, event instance)', () => {
    const a = buildFanoutDedupKey('deal.won', SUB_ID, 'deal_stage_history:h1');
    const b = buildFanoutDedupKey('deal.won', SUB_ID, 'deal_stage_history:h1');
    expect(a).toBe(b);
    expect(a).toBe(`wh:deal.won:${SUB_ID}:deal_stage_history:h1`);
    expect(buildFanoutDedupKey('deal.won', SUB_ID_2, 'deal_stage_history:h1')).not.toBe(a);
    expect(buildFanoutDedupKey('deal.lost', SUB_ID, 'deal_stage_history:h1')).not.toBe(a);
    expect(buildFanoutDedupKey('deal.won', SUB_ID, 'deal_stage_history:h2')).not.toBe(a);
  });

  it('bound overlong keys to the 256-char cap without losing distinctness', () => {
    const long1 = buildFanoutDedupKey('task.completed', SUB_ID, 'x'.repeat(400));
    const long2 = buildFanoutDedupKey('task.completed', SUB_ID, 'y'.repeat(400));
    expect(long1.length).toBeLessThanOrEqual(256);
    expect(long2.length).toBeLessThanOrEqual(256);
    expect(long1).not.toBe(long2);
    expect(buildFanoutDedupKey('task.completed', SUB_ID, 'x'.repeat(400))).toBe(long1);
  });
});

describe('signing secrets and the once-only DTO', () => {
  it('generates 256-bit base64url secrets, unique per call', () => {
    const a = generateSigningSecret();
    const b = generateSigningSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it('round-trips through the vault envelope (create → handler resolution shape)', () => {
    const source = { INTEGRATIONS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
    const secret = generateSigningSecret();
    const stored = serialiseEnvelope(encryptSecret(secret, source));
    expect(stored).not.toContain(secret);
    expect(decryptSecret(stored, source)).toBe(secret);
  });

  it('shapes summaries with no secret material of any kind', () => {
    const row = {
      id: SUB_ID,
      url: 'https://example.com/hook',
      events: ['deal.won'],
      active: true,
      signingSecretCiphertext: 'intg.v1.abc.def.ghi',
      createdBy: '55555555-5555-4555-8555-555555555555',
      createdAt: new Date('2026-10-09T00:00:00.000Z'),
      updatedAt: new Date('2026-10-09T00:00:00.000Z'),
    };
    const summary = toSubscriptionSummary(row);
    expect(summary.hasSigningSecret).toBe(true);
    expect(Object.keys(summary).sort()).toEqual(
      [
        'active',
        'createdAt',
        'createdBy',
        'events',
        'hasSigningSecret',
        'id',
        'updatedAt',
        'url',
      ].sort(),
    );
    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain('intg.v1');
    expect(serialised.toLowerCase()).not.toContain('ciphertext');
    expect(serialised.toLowerCase()).not.toContain('nonce');

    const bare = toSubscriptionSummary({ ...row, signingSecretCiphertext: null });
    expect(bare.hasSigningSecret).toBe(false);
  });
});

describe('subscription URL fail-fast (static SSRF check only)', () => {
  const blocked: Array<[string, string]> = [
    ['http://127.0.0.1/hook', 'loopback literal'],
    ['http://10.0.0.5/hook', 'private 10/8'],
    ['http://172.16.0.1/hook', 'private 172.16/12'],
    ['http://192.168.1.1/hook', 'private 192.168/16'],
    ['http://169.254.169.254/latest/meta-data', 'link-local metadata'],
    ['http://[::1]/hook', 'IPv6 loopback'],
    ['http://localhost/hook', 'localhost'],
    ['http://app.internal/hook', '.internal suffix'],
    ['http://intranet/hook', 'single-label hostname'],
    ['ftp://example.com/hook', 'non-http scheme'],
    ['https://user:pass@example.com/hook', 'userinfo'],
    ['not a url', 'unparseable'],
  ];
  it.each(blocked)('rejects %s (%s)', (url) => {
    const error = caught(() => assertSubscriptionUrlAllowed(url));
    expect(isIntegrationsError(error)).toBe(true);
    expect((error as { code: string }).code).toBe('VALIDATION');
  });

  const allowed = [
    'https://example.com/hook',
    'https://hooks.example.com:8443/path?q=1',
    'http://8.8.8.8/hook',
  ];
  it.each(allowed)('allows %s', (url) => {
    expect(() => assertSubscriptionUrlAllowed(url)).not.toThrow();
  });
});

describe('webhook job payload contract', () => {
  it('accepts a subscription delivery payload (ids + url + envelope body)', () => {
    const parsed = WebhookPayloadSchema.parse({
      subscriptionId: SUB_ID,
      deliveryId: DELIVERY_ID,
      url: 'https://example.com/hook',
      body: { id: DELIVERY_ID, type: 'deal.won', created_at: 'x', org_id: ORG_ID, data: {} },
    });
    expect(parsed.subscriptionId).toBe(SUB_ID);
    expect(parsed.deliveryId).toBe(DELIVERY_ID);
  });

  it('keeps the legacy env-ref payload shape working', () => {
    const parsed = WebhookPayloadSchema.parse({
      url: 'https://example.com/hook',
      body: { hello: 'world' },
      signatureSecretRef: 'PARTNER_A',
    });
    expect(parsed.signatureSecretRef).toBe('PARTNER_A');
    expect(parsed.subscriptionId).toBeUndefined();
  });

  it('rejects a secret smuggled in as a payload field, and a malformed subscriptionId', () => {
    expect(() =>
      WebhookPayloadSchema.parse({ url: 'https://example.com/hook', signingSecret: 'x' }),
    ).toThrow();
    expect(() =>
      WebhookPayloadSchema.parse({ url: 'https://example.com/hook', subscriptionId: 'nope' }),
    ).toThrow();
  });

  it('normalizeWebhookPayload carries the ids and strips spoofed signature headers', () => {
    const normalized = normalizeWebhookPayload({
      subscriptionId: SUB_ID,
      deliveryId: DELIVERY_ID,
      url: 'https://example.com/hook',
      headers: { 'x-pravshi-signature': 'sha256=forged', 'x-pravshi-timestamp': '1', 'x-ok': '1' },
      body: { id: DELIVERY_ID },
    });
    expect(normalized.subscriptionId).toBe(SUB_ID);
    expect(normalized.deliveryId).toBe(DELIVERY_ID);
    expect(normalized.headers).toEqual({ 'x-ok': '1' });
    expect(normalized.signatureSecret).toBeUndefined();
  });
});

describe('workflow webhook action enablement', () => {
  it('is implemented in the registry; only run_ai_action remains deferred', () => {
    expect(ACTION_REGISTRY.webhook.implemented).toBe(true);
    expect(REGISTRY_DEFERRED_ACTION_TYPES).toEqual(['run_ai_action']);
  });

  it('save-time params enforce exactly one addressing mode', () => {
    expect(
      WebhookActionParamsSchema.safeParse({ subscriptionId: SUB_ID, body: { a: 1 } }).success,
    ).toBe(true);
    expect(WebhookActionParamsSchema.safeParse({ url: 'https://example.com/hook' }).success).toBe(
      true,
    );
    expect(
      WebhookActionParamsSchema.safeParse({
        url: 'https://example.com/hook',
        signatureSecretRef: 'REF',
      }).success,
    ).toBe(true);
    expect(WebhookActionParamsSchema.safeParse({}).success).toBe(false);
    expect(
      WebhookActionParamsSchema.safeParse({ subscriptionId: SUB_ID, url: 'https://example.com' })
        .success,
    ).toBe(false);
    expect(
      WebhookActionParamsSchema.safeParse({
        subscriptionId: SUB_ID,
        signatureSecretRef: 'REF',
      }).success,
    ).toBe(false);
  });

  it('ActionConfigSchema accepts webhook actions and still rejects run_ai_action', () => {
    expect(
      ActionConfigSchema.safeParse({
        type: 'webhook',
        params: { subscriptionId: SUB_ID, body: { deal_id: 'x' } },
      }).success,
    ).toBe(true);
    expect(
      ActionConfigSchema.safeParse({ type: 'webhook', params: { url: 'https://example.com/h' } })
        .success,
    ).toBe(true);
    expect(ActionConfigSchema.safeParse({ type: 'webhook', params: {} }).success).toBe(false);
    expect(ActionConfigSchema.safeParse({ type: 'run_ai_action', params: {} }).success).toBe(false);
  });
});

describe('delete-with-delivery-history conflict detection', () => {
  /** A pg-shaped driver error: SQLSTATE + constraint travel together. */
  const pgError = (code: string, constraint?: string) =>
    Object.assign(new Error('driver error'), constraint ? { code, constraint } : { code });
  /** drizzle wraps the driver error as `cause` (the repo's sqlstateOf precedent). */
  const wrapped = (inner: unknown) => Object.assign(new Error('query failed'), { cause: inner });

  it('maps a 23503 on the deliveries FK to a conflict — direct and drizzle-wrapped', () => {
    expect(isDeliveryHistoryConflict(pgError('23503', DELIVERIES_SUBSCRIPTION_FK))).toBe(true);
    expect(isDeliveryHistoryConflict(wrapped(pgError('23503', DELIVERIES_SUBSCRIPTION_FK)))).toBe(
      true,
    );
  });

  it('falls back to the code alone when no constraint name is available', () => {
    expect(isDeliveryHistoryConflict(pgError('23503'))).toBe(true);
    expect(isDeliveryHistoryConflict(wrapped(pgError('23503')))).toBe(true);
  });

  it('does NOT map a 23503 raised by a different constraint', () => {
    expect(
      isDeliveryHistoryConflict(pgError('23503', 'integration_webhook_deliveries_job_id_fkey')),
    ).toBe(false);
    expect(
      isDeliveryHistoryConflict(
        wrapped(pgError('23503', 'integration_webhook_subscriptions_org_id_fkey')),
      ),
    ).toBe(false);
  });

  it('does NOT map other SQLSTATEs or generic errors', () => {
    expect(isDeliveryHistoryConflict(pgError('23505', DELIVERIES_SUBSCRIPTION_FK))).toBe(false);
    expect(isDeliveryHistoryConflict(new Error('boom'))).toBe(false);
    expect(isDeliveryHistoryConflict(null)).toBe(false);
    expect(isDeliveryHistoryConflict('23503')).toBe(false);
  });
});
