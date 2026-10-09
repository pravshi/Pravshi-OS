/**
 * Frontend integrations UI tests (Phase 10, Wave G).
 *
 * Covers the UI↔API contract surface owned by G: the pure shaping logic
 * in src/components/integrations/integrations-client.ts (form body
 * builders, status shaping, wire converters), the config-field
 * descriptors pinned against the REAL provider registry (a descriptor
 * key the provider schema would reject fails here, not in production),
 * the envelope → IntegrationsApiError mapping the components toast
 * from, and the pure merge core of the executions read model
 * (src/lib/integrations/executions.ts).
 *
 * Pure unit level — fetch is stubbed; no database, no Neon. The
 * DB-backed route/service coverage lives in the Wave J security suite
 * and the DB suites; this file follows the tests/ai/frontend-ai-ui
 * precedent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCreateConnectionBody,
  buildUpdateConnectionBody,
  cleanConfigValues,
  configFieldsForProvider,
  connectionStatusMeta,
  createConnection,
  dismissSecret,
  executionKindLabel,
  executionStatusTone,
  fetchSubscriptions,
  IntegrationsApiError,
  revealSecret,
  toConnectionWire,
  toExecutionWire,
  toSubscriptionWire,
  toggleEventSelection,
} from '@/components/integrations/integrations-client';
import { validateConnectionConfig } from '@/lib/integrations/connections';
import {
  inboundToExecution,
  jobToExecution,
  mergeExecutionRows,
  type IntegrationExecution,
} from '@/lib/integrations/executions';
import { getProviderDefinition, listProviderDefinitions } from '@/lib/integrations/providers';
import type { IntegrationConnectionSummary } from '@/lib/integrations/connections';
import type { WebhookSubscriptionSummary } from '@/lib/integrations/subscriptions';

const CONNECTION_ID = '9b7e1c2a-5f6d-4c8a-b3d2-1e0f9a8b7c6d';
const SUBSCRIPTION_ID = '8a6d2b1c-4e5f-4a9b-8c3d-2f1a0b9c8d7e';

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ── Config cleaning + body builders ─────────────────────────────────────── */

describe('cleanConfigValues', () => {
  it('drops blank strings, trims kept strings, passes booleans through', () => {
    expect(
      cleanConfigValues({ fromAddress: '  a@b.co ', fromName: '   ', outboundEnabled: false }),
    ).toEqual({ fromAddress: 'a@b.co', outboundEnabled: false });
  });
});

describe('buildCreateConnectionBody', () => {
  it('carries the Tier V secret only when one was typed', () => {
    expect(
      buildCreateConnectionBody('webhooks', {
        displayName: ' Hooks ',
        configValues: { outboundEnabled: true },
        secret: 's3cr3t',
      }),
    ).toEqual({
      providerKey: 'webhooks',
      displayName: 'Hooks',
      config: { outboundEnabled: true },
      secret: 's3cr3t',
    });
    expect(
      buildCreateConnectionBody('email', {
        displayName: 'Email',
        configValues: { fromAddress: '' },
        secret: '',
      }),
    ).toEqual({ providerKey: 'email', displayName: 'Email' });
  });
});

const connectionWire = {
  id: CONNECTION_ID,
  providerKey: 'email',
  displayName: 'Email',
  status: 'CONNECTED' as const,
  config: { fromAddress: 'a@b.co' },
  hasCredential: true,
  maskedCredentialRef: '…_KEY',
  connectedBy: null,
  lastHealthAt: null,
  lastErrorCode: null,
  createdAt: '2026-10-09T00:00:00.000Z',
  updatedAt: '2026-10-09T00:00:00.000Z',
};

describe('buildUpdateConnectionBody', () => {
  it('returns null when nothing changed', () => {
    expect(
      buildUpdateConnectionBody(connectionWire, {
        displayName: 'Email',
        configValues: { fromAddress: 'a@b.co' },
        secret: '',
      }),
    ).toBeNull();
  });

  it('includes only the changed fields', () => {
    expect(
      buildUpdateConnectionBody(connectionWire, {
        displayName: 'Email',
        configValues: { fromAddress: 'a@b.co', fromName: 'Pravshi' },
        secret: '',
      }),
    ).toEqual({ config: { fromAddress: 'a@b.co', fromName: 'Pravshi' } });
    expect(
      buildUpdateConnectionBody(connectionWire, {
        displayName: 'Renamed',
        configValues: { fromAddress: 'a@b.co' },
        secret: '',
      }),
    ).toEqual({ displayName: 'Renamed' });
  });
});

describe('toggleEventSelection', () => {
  it('adds without duplicating and removes', () => {
    expect(toggleEventSelection(['deal.won'], 'task.completed', true)).toEqual([
      'deal.won',
      'task.completed',
    ]);
    expect(toggleEventSelection(['deal.won'], 'deal.won', true)).toEqual(['deal.won']);
    expect(toggleEventSelection(['deal.won', 'deal.lost'], 'deal.won', false)).toEqual([
      'deal.lost',
    ]);
  });
});

/* ── Display shaping ─────────────────────────────────────────────────────── */

describe('status shaping', () => {
  it('maps every connection status to a label and tone', () => {
    expect(connectionStatusMeta('CONNECTED')).toEqual({ label: 'Connected', tone: 'success' });
    expect(connectionStatusMeta('DISCONNECTED').tone).toBe('muted');
    expect(connectionStatusMeta('ERROR').tone).toBe('danger');
    expect(connectionStatusMeta('NOT_CONFIGURED').tone).toBe('warning');
  });

  it('maps job and inbound statuses onto tones', () => {
    expect(executionStatusTone('succeeded')).toBe('success');
    expect(executionStatusTone('PROCESSED')).toBe('success');
    expect(executionStatusTone('dead_letter')).toBe('danger');
    expect(executionStatusTone('REJECTED_SIGNATURE')).toBe('danger');
    expect(executionStatusTone('running')).toBe('warning');
    expect(executionStatusTone('DUPLICATE')).toBe('muted');
    expect(executionStatusTone('cancelled')).toBe('muted');
  });

  it('labels every execution kind', () => {
    expect(executionKindLabel('webhook_delivery')).toBe('Webhook delivery');
    expect(executionKindLabel('email')).toBe('Email');
    expect(executionKindLabel('inbound_event')).toBe('Inbound event');
  });
});

/* ── Config field descriptors vs the real registry ───────────────────────── */

describe('PROVIDER_CONFIG_FIELDS against the provider registry', () => {
  it('has descriptors for every registered provider, and only for those', () => {
    for (const definition of listProviderDefinitions()) {
      expect(configFieldsForProvider(definition.key).length).toBeGreaterThan(0);
    }
    expect(configFieldsForProvider('no-such-provider')).toEqual([]);
  });

  it('every descriptor key is accepted by the provider config schema', () => {
    for (const definition of listProviderDefinitions()) {
      const sample: Record<string, unknown> = {};
      for (const field of configFieldsForProvider(definition.key)) {
        sample[field.key] =
          field.kind === 'checkbox' ? true : field.kind === 'email' ? 'a@b.co' : 'Sample';
      }
      // Throws IntegrationsError VALIDATION on any drift.
      expect(validateConnectionConfig(definition, sample)).toEqual(sample);
    }
  });

  it('checkbox descriptors exist exactly for boolean config keys', () => {
    const webhooks = getProviderDefinition('webhooks');
    expect(webhooks).not.toBeNull();
    const fields = configFieldsForProvider('webhooks');
    expect(fields.every((f) => f.kind === 'checkbox')).toBe(true);
    expect(fields.map((f) => f.key).sort()).toEqual(['inboundEnabled', 'outboundEnabled']);
  });
});

/* ── Wire converters ─────────────────────────────────────────────────────── */

describe('wire converters', () => {
  it('toConnectionWire emits exactly the wire field set with ISO dates', () => {
    const summary: IntegrationConnectionSummary = {
      id: CONNECTION_ID,
      providerKey: 'email',
      displayName: 'Email',
      status: 'CONNECTED',
      config: { fromAddress: 'a@b.co' },
      hasCredential: true,
      maskedCredentialRef: '…_KEY',
      connectedBy: null,
      lastHealthAt: new Date('2026-10-09T10:00:00.000Z'),
      lastErrorCode: null,
      createdAt: new Date('2026-10-09T09:00:00.000Z'),
      updatedAt: new Date('2026-10-09T09:30:00.000Z'),
    };
    const wire = toConnectionWire(summary);
    expect(Object.keys(wire).sort()).toEqual(
      [
        'id',
        'providerKey',
        'displayName',
        'status',
        'config',
        'hasCredential',
        'maskedCredentialRef',
        'connectedBy',
        'lastHealthAt',
        'lastErrorCode',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(wire.lastHealthAt).toBe('2026-10-09T10:00:00.000Z');
    expect(JSON.stringify(wire)).not.toContain('ciphertext');
  });

  it('toSubscriptionWire never carries the signing secret', () => {
    const summary: WebhookSubscriptionSummary = {
      id: SUBSCRIPTION_ID,
      url: 'https://example.com/hook',
      events: ['deal.won'],
      active: true,
      hasSigningSecret: true,
      createdBy: null,
      createdAt: new Date('2026-10-09T09:00:00.000Z'),
      updatedAt: new Date('2026-10-09T09:00:00.000Z'),
    };
    const wire = toSubscriptionWire(summary);
    expect(wire.hasSigningSecret).toBe(true);
    expect(Object.keys(wire)).not.toContain('signingSecret');
    expect(JSON.stringify(wire)).not.toContain('ciphertext');
  });
});

/* ── Envelope → error mapping (stubbed fetch) ────────────────────────────── */

describe('integrations client error mapping', () => {
  it('maps a 503 NOT_CONFIGURED envelope onto the typed error', async () => {
    stubFetch(503, {
      error: { code: 'NOT_CONFIGURED', message: 'This integration is not configured.' },
    });
    await expect(
      createConnection({ providerKey: 'webhooks', displayName: 'Hooks', secret: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED', status: 503 });
  });

  it('maps a 409 onto CONFLICT with the server message', async () => {
    stubFetch(409, {
      error: {
        code: 'CONFLICT',
        message: 'An integration connection already exists for this provider.',
      },
    });
    const error = await createConnection({ providerKey: 'email', displayName: 'Email' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(IntegrationsApiError);
    expect((error as IntegrationsApiError).code).toBe('CONFLICT');
    expect((error as IntegrationsApiError).message).toContain('already exists');
  });

  it('sends the active filter as a query string for subscription lists', async () => {
    const fetchMock = stubFetch(200, { rows: [], total: 0, limit: 50, offset: 0 });
    await fetchSubscriptions(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/integrations/webhooks?active=true',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });
});

/* ── One-time secret state ───────────────────────────────────────────────── */

describe('one-time secret reveal state', () => {
  it('reveal carries label/secret/hint and dismiss drops to null', () => {
    const revealed = revealSecret('Signing secret', 'abc123', 'Store it.');
    expect(revealed).toEqual({ label: 'Signing secret', secret: 'abc123', hint: 'Store it.' });
    expect(dismissSecret()).toBeNull();
  });
});

/* ── Executions pure core ────────────────────────────────────────────────── */

const T1 = new Date('2026-10-09T09:00:00.000Z');
const T2 = new Date('2026-10-09T10:00:00.000Z');
const T3 = new Date('2026-10-09T11:00:00.000Z');

describe('executions row shaping', () => {
  it('shapes a webhook job with its delivery link enrichment', () => {
    const execution = jobToExecution({
      id: 'job-1',
      type: 'webhook',
      status: 'failed',
      errorCode: 'HTTP_500',
      attempts: 3,
      createdAt: T1,
      updatedAt: T2,
      eventKey: 'deal.won',
      subscriptionId: SUBSCRIPTION_ID,
      targetUrl: 'https://example.com/hook',
    });
    expect(execution.kind).toBe('webhook_delivery');
    expect(execution.providerKey).toBe('webhooks');
    expect(execution.jobId).toBe('job-1');
    expect(execution.eventKey).toBe('deal.won');
    expect(execution.targetUrl).toBe('https://example.com/hook');
  });

  it('shapes an email job and an inbound event with the right nulls', () => {
    const email = jobToExecution({
      id: 'job-2',
      type: 'email',
      status: 'succeeded',
      errorCode: null,
      attempts: 1,
      createdAt: T1,
      updatedAt: T1,
      eventKey: null,
      subscriptionId: null,
      targetUrl: null,
    });
    expect(email.kind).toBe('email');
    expect(email.providerKey).toBe('email');

    const inbound = inboundToExecution({
      id: 'evt-1',
      providerKey: 'webhooks',
      connectionId: CONNECTION_ID,
      externalEventId: 'ext-42',
      status: 'PROCESSED',
      receivedAt: T2,
      processedAt: T3,
    });
    expect(inbound.kind).toBe('inbound_event');
    expect(inbound.eventKey).toBe('ext-42');
    expect(inbound.jobId).toBeNull();
    expect(inbound.attempts).toBeNull();
    expect(inbound.updatedAt).toEqual(T3);
  });
});

describe('mergeExecutionRows', () => {
  const row = (id: string, at: Date): IntegrationExecution => ({
    id,
    kind: 'email',
    status: 'succeeded',
    providerKey: 'email',
    eventKey: null,
    subscriptionId: null,
    connectionId: null,
    jobId: id,
    targetUrl: null,
    errorCode: null,
    attempts: 1,
    occurredAt: at,
    updatedAt: at,
  });

  it('sorts newest first with a total id-descending tiebreak', () => {
    const merged = mergeExecutionRows([row('a', T2), row('c', T1), row('b', T2)], 3, 50, 0);
    expect(merged.rows.map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(merged.total).toBe(3);
  });

  it('slices the requested page after sorting', () => {
    const merged = mergeExecutionRows([row('a', T1), row('b', T2), row('c', T3)], 30, 2, 1);
    expect(merged.rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(merged.total).toBe(30);
    expect(merged.limit).toBe(2);
    expect(merged.offset).toBe(1);
  });

  it('toExecutionWire serialises dates to ISO strings', () => {
    const wire = toExecutionWire(row('job-9', T1));
    expect(wire.occurredAt).toBe(T1.toISOString());
    expect(wire.updatedAt).toBe(T1.toISOString());
  });
});
