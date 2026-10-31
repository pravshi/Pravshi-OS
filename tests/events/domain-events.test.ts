import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Redesign Step 6 — the domain-event ports (src/lib/events) and their composition root.
 *
 * The port carries the guarantees ADR-005 gave the direct calls it replaced: awaited inline, the
 * SAME Authorization object, never throws, and — new with the indirection — loud when unwired. No
 * database access: the subscribers here are fakes (the composition-root tests import `@/env`, so they
 * need the usual test environment variables); the real ones are exercised by the workflow,
 * integration and CRM suites, which now reach them through the port.
 */

const sentry = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));
vi.mock('@/lib/observability/report', () => sentry);

import {
  DOMAIN_INTEGRATION_EVENT_KEYS,
  DOMAIN_WORKFLOW_EVENT_TYPES,
  buildDedupKey,
  dispatchWorkflowEvent,
  emitIntegrationEvent,
  registerIntegrationEventSubscriber,
  registerWorkflowEventSubscriber,
  registeredEventPorts,
  resetEventPortsForTests,
  type DomainWorkflowEventInput,
} from '@/lib/events';
import type { Authorization } from '@/lib/authz/require-permission';

const auth = {
  ctx: { personId: 'p-1', orgId: 'o-1', aal: 'aal1' },
  permission: 'deals.edit',
  scope: 'GLOBAL',
  aal: 'aal1',
  requestId: 'r-1',
  meta: { requestId: 'r-1', ip: null, userAgent: null },
} as unknown as Authorization;

const event: DomainWorkflowEventInput = {
  type: 'deal.created',
  entityType: 'deal',
  entityId: 'd-1',
  dedupKey: buildDedupKey('deal', 'd-1'),
  payload: { title: 'Acme' },
};

beforeEach(() => {
  resetEventPortsForTests();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('workflow port', () => {
  it('hands the event and the SAME Authorization object to the subscriber', async () => {
    const seen: Array<[Authorization, DomainWorkflowEventInput]> = [];
    registerWorkflowEventSubscriber(async (a, e) => {
      seen.push([a, e]);
    });
    await dispatchWorkflowEvent(auth, event);
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe(auth); // the depth guard's WeakMap fallback is keyed on this object
    expect(seen[0]![1]).toBe(event);
  });

  it('is awaited inline: the subscriber has finished when the call returns (ADR-005 D1)', async () => {
    let done = false;
    registerWorkflowEventSubscriber(async () => {
      await new Promise((r) => setTimeout(r, 25));
      done = true;
    });
    await dispatchWorkflowEvent(auth, event);
    expect(done).toBe(true);
  });

  it('never rejects when the subscriber throws, and reports it (ADR-005 D3)', async () => {
    registerWorkflowEventSubscriber(async () => {
      throw new Error('engine exploded');
    });
    await expect(dispatchWorkflowEvent(auth, event)).resolves.toBeUndefined();
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('with NO subscriber: resolves, and reports EVERY undelivered event (fail loud, not silent)', async () => {
    await expect(dispatchWorkflowEvent(auth, event)).resolves.toBeUndefined();
    await expect(dispatchWorkflowEvent(auth, event)).resolves.toBeUndefined();
    expect(sentry.captureMessage).toHaveBeenCalledTimes(2);
    expect(sentry.captureMessage.mock.calls[0]![0]).toContain('no workflow dispatcher');
    expect(console.error).toHaveBeenCalled();
  });

  it('registering again replaces the subscriber, it never stacks', async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    registerWorkflowEventSubscriber(first);
    registerWorkflowEventSubscriber(second);
    await dispatchWorkflowEvent(auth, event);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('refuses a subscriber that is not a function', () => {
    expect(() => registerWorkflowEventSubscriber('x' as never)).toThrow(TypeError);
    expect(() => registerIntegrationEventSubscriber(undefined as never)).toThrow(TypeError);
  });
});

describe('integration port', () => {
  it('passes the key, the data and the options through verbatim, with the same Authorization', async () => {
    const calls: unknown[][] = [];
    registerIntegrationEventSubscriber(async (...args) => {
      calls.push(args);
    });
    const data = { deal_id: 'd-1', value: 10 };
    const options = { eventInstanceId: 'stage:d-1:won' };
    await emitIntegrationEvent(auth, 'deal.won', data, options);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(auth);
    expect(calls[0]!.slice(1)).toEqual(['deal.won', data, options]);
    expect(calls[0]![2]).toBe(data);
  });

  it('never rejects when the fan-out throws; with NO subscriber it resolves and reports each time', async () => {
    registerIntegrationEventSubscriber(async () => {
      throw new Error('fan-out exploded');
    });
    await expect(emitIntegrationEvent(auth, 'task.completed', {})).resolves.toBeUndefined();
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);

    resetEventPortsForTests();
    vi.clearAllMocks();
    await expect(emitIntegrationEvent(auth, 'deal.lost', {})).resolves.toBeUndefined();
    await expect(emitIntegrationEvent(auth, 'deal.lost', {})).resolves.toBeUndefined();
    expect(sentry.captureMessage).toHaveBeenCalledTimes(2);
    expect(sentry.captureMessage.mock.calls[0]![0]).toContain('no integration fan-out');
  });
});

describe('the registry', () => {
  it('is process-wide: a second copy of the module (another bundle) sees the same subscribers', async () => {
    const subscriber = vi.fn(async () => undefined);
    registerWorkflowEventSubscriber(subscriber);
    vi.resetModules();
    const copy = await import('@/lib/events');
    expect(copy.registeredEventPorts()).toEqual({ workflow: true, integration: false });
    await copy.dispatchWorkflowEvent(auth, event);
    expect(subscriber).toHaveBeenCalledTimes(1);
  });

  it('reports which ports are wired, and resetEventPortsForTests clears both', () => {
    expect(registeredEventPorts()).toEqual({ workflow: false, integration: false });
    registerWorkflowEventSubscriber(async () => undefined);
    registerIntegrationEventSubscriber(async () => undefined);
    expect(registeredEventPorts()).toEqual({ workflow: true, integration: true });
    resetEventPortsForTests();
    expect(registeredEventPorts()).toEqual({ workflow: false, integration: false });
  });

  it('buildDedupKey joins the non-empty parts with a colon', () => {
    expect(buildDedupKey('deal_stage_history', 'abc')).toBe('deal_stage_history:abc');
    expect(buildDedupKey('a', '', 'b')).toBe('a:b');
  });
});

describe('the composition root', () => {
  it('registers BOTH ports, forwarding to the real dispatcher and the real fan-out with the same arguments', async () => {
    const workflowSpy = vi.fn(async (..._args: unknown[]) => undefined);
    const fanoutSpy = vi.fn(async (..._args: unknown[]) => undefined);
    vi.resetModules();
    resetEventPortsForTests();
    vi.doMock('@/lib/workflows/events', () => ({ dispatchWorkflowEvent: workflowSpy }));
    vi.doMock('@/lib/integrations/fanout', () => ({ emitIntegrationEvent: fanoutSpy }));
    try {
      const events = await import('@/lib/events');
      expect(events.registeredEventPorts()).toEqual({ workflow: false, integration: false });
      await import('@/lib/composition/domain-events');
      expect(events.registeredEventPorts()).toEqual({ workflow: true, integration: true });

      await events.dispatchWorkflowEvent(auth, event);
      expect(workflowSpy).toHaveBeenCalledTimes(1);
      expect(workflowSpy.mock.calls[0]![0]).toBe(auth);
      expect(workflowSpy.mock.calls[0]![1]).toBe(event);

      const data = { deal_id: 'd-1' };
      const options = { eventInstanceId: 'x' };
      await events.emitIntegrationEvent(auth, 'deal.won', data, options);
      expect(fanoutSpy).toHaveBeenCalledTimes(1);
      expect(fanoutSpy.mock.calls[0]).toEqual([auth, 'deal.won', data, options]);
      expect(fanoutSpy.mock.calls[0]![0]).toBe(auth);
    } finally {
      vi.doUnmock('@/lib/workflows/events');
      vi.doUnmock('@/lib/integrations/fanout');
      vi.resetModules();
    }
  });

  it('only sends vocabulary the subscribers understand (runtime twin of the compile-time check)', async () => {
    const { WORKFLOW_TRIGGER_TYPES } = await import('@/lib/workflows/schema');
    const { INTEGRATION_EVENT_KEYS } = await import('@/lib/integrations/fanout');
    for (const type of DOMAIN_WORKFLOW_EVENT_TYPES) {
      expect(
        WORKFLOW_TRIGGER_TYPES as readonly string[],
        `${type} is not a trigger type`,
      ).toContain(type);
    }
    for (const key of DOMAIN_INTEGRATION_EVENT_KEYS) {
      expect(INTEGRATION_EVENT_KEYS as readonly string[], `${key} is not an event key`).toContain(
        key,
      );
    }
  });
});
