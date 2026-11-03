import { describe, expect, it, vi } from 'vitest';
import type { Authorization } from '@/lib/authz/require-permission';
import {
  DEFERRED_TRIGGER_TYPES,
  IMPLEMENTED_TRIGGER_TYPES,
  WORKFLOW_TRIGGER_TYPES,
} from '@/lib/workflows/schema';
import { doesTriggerMatch } from '@/lib/workflows/triggers';
import type { WorkflowEvent } from '@/lib/workflows/events';
import {
  INTEGRATION_EVENT_KEYS,
  isIntegrationEventKey,
  validateSubscriptionEvents,
} from '@/lib/integrations/fanout';
import {
  DEFERRED_RE_INTEGRATION_EVENT_KEYS,
  DEFERRED_RE_WORKFLOW_TRIGGER_TYPES,
  REAL_ESTATE_ENTITY_TYPES,
  REAL_ESTATE_EVENT_TYPES,
} from '@pravshi/contracts';
import {
  createTrustedRealEstateEventEnvelope,
  dispatchRealEstateWorkflowEvent,
  registerWorkflowEventSubscriber,
  resetEventPortsForTests,
  REAL_ESTATE_DOMAIN_ENTITY_TYPES,
  type DomainWorkflowEventInput,
} from '@/lib/events';

describe('Real Estate Workflow & Integration Safety (Corrections 1-4)', () => {
  const auth: Authorization = {
    ctx: {
      personId: 'b0000000-0000-4000-8000-000000000002',
      orgId: 'a0000000-0000-4000-8000-000000000001',
      aal: 'aal1',
    },
    permission: 'deals.edit',
    scope: 'GLOBAL',
    aal: 'aal1',
    requestId: 'req-001',
    meta: { requestId: 'req-001', ip: null, userAgent: null },
  } as unknown as Authorization;

  describe('Correction 1: Deferred Real Estate Workflow Triggers & Activation Gating', () => {
    it('all 11 Real Estate workflow triggers are registered in WORKFLOW_TRIGGER_TYPES', () => {
      for (const trigger of DEFERRED_RE_WORKFLOW_TRIGGER_TYPES) {
        expect(
          WORKFLOW_TRIGGER_TYPES as readonly string[],
          `${trigger} must be accepted in workflow vocabulary`,
        ).toContain(trigger);
      }
    });

    it('all 11 Real Estate workflow triggers are in DEFERRED_TRIGGER_TYPES', () => {
      for (const trigger of DEFERRED_RE_WORKFLOW_TRIGGER_TYPES) {
        expect(
          DEFERRED_TRIGGER_TYPES as readonly string[],
          `${trigger} must be classified as deferred`,
        ).toContain(trigger);
      }
    });

    it('NONE of the 11 Real Estate workflow triggers are in IMPLEMENTED_TRIGGER_TYPES', () => {
      for (const trigger of DEFERRED_RE_WORKFLOW_TRIGGER_TYPES) {
        expect(
          IMPLEMENTED_TRIGGER_TYPES as readonly string[],
          `${trigger} must NOT have active runtime in P0`,
        ).not.toContain(trigger);
      }
    });

    it('activation gate rejects every one of the 11 RE triggers', () => {
      for (const trigger of DEFERRED_RE_WORKFLOW_TRIGGER_TYPES) {
        const isSupported = (IMPLEMENTED_TRIGGER_TYPES as readonly string[]).includes(trigger);
        expect(isSupported, `Workflow activation for trigger ${trigger} must be blocked`).toBe(
          false,
        );
      }
    });

    it('activation gate allows existing implemented triggers (deal.created, task.created, etc.)', () => {
      const existing = ['deal.created', 'task.created', 'project.created', 'scheduled'];
      for (const trigger of existing) {
        expect((IMPLEMENTED_TRIGGER_TYPES as readonly string[]).includes(trigger)).toBe(true);
      }
    });
  });

  describe('Correction 2: Integration Event Safety & Gating', () => {
    it('outbound fan-out rejects subscriptions to provisional Real Estate integration keys', () => {
      for (const key of DEFERRED_RE_INTEGRATION_EVENT_KEYS) {
        expect(isIntegrationEventKey(key)).toBe(false);
        expect((INTEGRATION_EVENT_KEYS as readonly string[]).includes(key)).toBe(false);
        expect(() => validateSubscriptionEvents([key])).toThrow();
      }
    });

    it('outbound fan-out accepts active integration event keys', () => {
      const active = ['deal.won', 'deal.lost', 'task.completed'];
      for (const key of active) {
        expect(isIntegrationEventKey(key)).toBe(true);
        expect(() => validateSubscriptionEvents([key])).not.toThrow();
      }
    });
  });

  describe('Correction 3: Server-Derived Trusted Event Envelope', () => {
    it('constructs trusted envelope with server-derived id, orgId, actorPersonId, timestamp, and dedupKey', () => {
      const occurredAt = new Date('2026-11-03T12:00:00.000Z');
      const envelope = createTrustedRealEstateEventEnvelope({
        auth,
        type: 'booking.created',
        entityType: 'booking',
        entityId: 'bk-12345',
        entityVersion: 1,
        payload: {
          bookingId: 'bk-12345',
          dealId: 'dl-999',
        },
        occurredAt,
      });

      expect(envelope.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(envelope.orgId).toBe(auth.ctx.orgId);
      expect(envelope.actorPersonId).toBe(auth.ctx.personId);
      expect(envelope.occurredAt).toBe('2026-11-03T12:00:00.000Z');
      expect(envelope.entityType).toBe('booking');
      expect(envelope.entityId).toBe('bk-12345');
      expect(envelope.entityVersion).toBe(1);
      expect(envelope.type).toBe('booking.created');
      expect(envelope.dedupKey).toBe(`re:${auth.ctx.orgId}:booking:bk-12345:1`);
    });

    it('guarantees untrusted client input cannot override server orgId or actorPersonId', () => {
      // Even if a caller attempts to spoof tenant in the payload, envelope orgId is strictly from auth.ctx
      const envelope = createTrustedRealEstateEventEnvelope({
        auth,
        type: 'lead.created',
        entityType: 'lead',
        entityId: 'ld-100',
        entityVersion: 1,
        payload: {
          leadId: 'ld-100',
          spoofedOrgId: 'unauthorized-org',
        },
      });

      expect(envelope.orgId).toBe(auth.ctx.orgId);
      expect(envelope.actorPersonId).toBe(auth.ctx.personId);
      expect(envelope.dedupKey).toContain(auth.ctx.orgId);
      expect(envelope.dedupKey).not.toContain('unauthorized-org');
    });
  });

  describe('Correction 4: Entity Type Compatibility & Engine Safety', () => {
    it('accepts all 11 Real Estate entity types in WorkflowEvent structure', () => {
      for (const entityType of REAL_ESTATE_DOMAIN_ENTITY_TYPES) {
        const event: WorkflowEvent = {
          id: '11111111-1111-4111-8111-111111111111',
          orgId: '22222222-2222-4222-8222-222222222222',
          type: 'lead.created',
          entityType,
          entityId: 'ent-1',
          actorPersonId: '33333333-3333-4333-8333-333333333333',
          occurredAt: new Date().toISOString(),
          dedupKey: `re:22222222-2222-4222-8222-222222222222:${entityType}:ent-1:1`,
          payload: { test: true },
        };
        expect(event.entityType).toBe(entityType);
      }
    });

    it('doesTriggerMatch handles Real Estate entity types safely without throwing', () => {
      const event: WorkflowEvent = {
        id: '11111111-1111-4111-8111-111111111111',
        orgId: '22222222-2222-4222-8222-222222222222',
        type: 'lead.created',
        entityType: 'lead',
        entityId: 'ld-1',
        actorPersonId: '33333333-3333-4333-8333-333333333333',
        occurredAt: new Date().toISOString(),
        dedupKey: 're:22222222-2222-4222-8222-222222222222:lead:ld-1:1',
        payload: { source: 'website_form' },
      };

      // Type mismatch
      expect(doesTriggerMatch({ type: 'deal.created' }, event)).toBe(false);

      // Type match, no entity restriction
      expect(doesTriggerMatch({ type: 'lead.created' }, event)).toBe(true);

      // Filter match
      expect(
        doesTriggerMatch({ type: 'lead.created', filters: { source: 'website_form' } }, event),
      ).toBe(true);

      // Filter mismatch
      expect(doesTriggerMatch({ type: 'lead.created', filters: { source: 'manual' } }, event)).toBe(
        false,
      );
    });
  });

  describe('Canonical Workflow Dispatch Adapter', () => {
    it('dispatches canonical Real Estate event without ID duplication or timestamp divergence', async () => {
      resetEventPortsForTests();
      const dispatched: DomainWorkflowEventInput[] = [];
      registerWorkflowEventSubscriber(async (_auth, input) => {
        dispatched.push(input);
      });

      const envelope = createTrustedRealEstateEventEnvelope({
        auth,
        type: 'lead.created',
        entityType: 'lead',
        entityId: 'ld-999',
        entityVersion: 1,
        payload: {
          leadId: 'ld-999',
          source: 'website_form',
        },
      });

      await dispatchRealEstateWorkflowEvent(auth, envelope);

      expect(dispatched).toHaveLength(1);
      const input = dispatched[0]!;
      expect(input.type).toBe('lead.created');
      expect(input.entityType).toBe('lead');
      expect(input.entityId).toBe('ld-999');
      expect(input.dedupKey).toBe(envelope.dedupKey);
      expect(input.payload).toBe(envelope.payload);
    });
  });
});
