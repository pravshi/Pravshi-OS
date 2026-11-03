import { describe, expect, it } from 'vitest';
import {
  REAL_ESTATE_EVENT_TYPES,
  DEFERRED_RE_WORKFLOW_TRIGGER_TYPES,
  DEFERRED_RE_INTEGRATION_EVENT_KEYS,
  REAL_ESTATE_ENTITY_TYPES,
  LeadCreatedPayloadSchema,
  LeadAssignedPayloadSchema,
  LeadConvertedPayloadSchema,
  ConsentWithdrawnPayloadSchema,
  VisitScheduledPayloadSchema,
  VisitCompletedPayloadSchema,
  InventoryHoldPayloadSchema,
  InventoryBlockPayloadSchema,
  InventoryReleasePayloadSchema,
  BookingCreatedPayloadSchema,
  BookingCancelledPayloadSchema,
  PaymentReceivedPayloadSchema,
  PaymentReconciledPayloadSchema,
  PaymentReversedPayloadSchema,
  DemandIssuedPayloadSchema,
  CommissionAccruedPayloadSchema,
  CommissionApprovedPayloadSchema,
  CommissionPaidPayloadSchema,
  CommissionClawedBackPayloadSchema,
  CpClaimRegisteredPayloadSchema,
  CpClaimExpiredPayloadSchema,
  CpClaimDisputedPayloadSchema,
  MessageSendSuppressedPayloadSchema,
  TemplateAppliedPayloadSchema,
  TemplateRolledBackPayloadSchema,
  AuditRecordedPayloadSchema,
  RealEstateLeadConvertedWebhookPayloadSchema,
  RealEstateVisitCompletedWebhookPayloadSchema,
  RealEstateBookingCreatedWebhookPayloadSchema,
  RealEstateBookingCancelledWebhookPayloadSchema,
  RealEstatePaymentReconciledWebhookPayloadSchema,
  RealEstateCommissionPaidWebhookPayloadSchema,
  RealEstateDomainEventEnvelopeSchema,
  buildRealEstateDedupKey,
} from '@pravshi/contracts';

describe('Real Estate Domain Event Catalogue & Contracts', () => {
  it('contains exactly 26 distinct event types across the 18 groups', () => {
    expect(REAL_ESTATE_EVENT_TYPES).toHaveLength(26);
    expect(new Set(REAL_ESTATE_EVENT_TYPES).size).toBe(26);
  });

  it('contains exactly 11 deferred workflow triggers', () => {
    expect(DEFERRED_RE_WORKFLOW_TRIGGER_TYPES).toHaveLength(11);
    for (const type of DEFERRED_RE_WORKFLOW_TRIGGER_TYPES) {
      expect(REAL_ESTATE_EVENT_TYPES).toContain(type);
    }
  });

  it('contains exactly 6 deferred integration event keys', () => {
    expect(DEFERRED_RE_INTEGRATION_EVENT_KEYS).toHaveLength(6);
    for (const key of DEFERRED_RE_INTEGRATION_EVENT_KEYS) {
      expect(REAL_ESTATE_EVENT_TYPES).toContain(key);
    }
  });

  it('contains exactly 11 domain entity types', () => {
    expect(REAL_ESTATE_ENTITY_TYPES).toHaveLength(11);
    expect(new Set(REAL_ESTATE_ENTITY_TYPES).size).toBe(11);
  });

  describe('26 Event Payload Schemas Validation', () => {
    it('1. lead.created validates positive and negative payloads', () => {
      const valid = {
        leadId: 'lead-001',
        source: 'website_form',
        projectInterest: 'Tower A',
        phoneMasked: '******9876',
        consentState: 'opted_in',
      };
      expect(LeadCreatedPayloadSchema.parse(valid)).toEqual(valid);

      expect(() =>
        LeadCreatedPayloadSchema.parse({
          ...valid,
          source: 'invalid_source',
        }),
      ).toThrow();
    });

    it('2. lead.assigned validates assignment transitions', () => {
      const valid = {
        leadId: 'lead-001',
        previousOwnerId: null,
        newOwnerId: 'agent-123',
        assignmentRule: 'round_robin',
        reason: 'Initial assignment',
      };
      expect(LeadAssignedPayloadSchema.parse(valid)).toEqual(valid);

      expect(() =>
        LeadAssignedPayloadSchema.parse({
          ...valid,
          newOwnerId: '',
        }),
      ).toThrow();
    });

    it('3. lead.converted validates terminal conversion facts', () => {
      const valid = {
        leadId: 'lead-001',
        contactId: 'contact-001',
        dealId: 'deal-001',
        convertedAt: new Date().toISOString(),
      };
      expect(LeadConvertedPayloadSchema.parse(valid)).toEqual(valid);

      expect(() =>
        LeadConvertedPayloadSchema.parse({
          ...valid,
          convertedAt: 'not-a-date',
        }),
      ).toThrow();
    });

    it('4. consent.withdrawn validates suppression payload', () => {
      const valid = {
        contactId: 'c-100',
        channel: 'whatsapp',
        purpose: 'marketing',
        withdrawnAt: new Date().toISOString(),
        source: 'user_optout_sms',
      };
      expect(ConsentWithdrawnPayloadSchema.parse(valid)).toEqual(valid);

      expect(() =>
        ConsentWithdrawnPayloadSchema.parse({
          ...valid,
          channel: 'smoke_signals',
        }),
      ).toThrow();
    });

    it('5. visit.scheduled validates appointment slot data', () => {
      const valid = {
        visitId: 'v-100',
        leadOrDealId: 'deal-100',
        unitOrPropertyId: 'unit-100',
        slotStart: new Date(Date.now() + 3600000).toISOString(),
        slotEnd: new Date(Date.now() + 7200000).toISOString(),
        agentId: 'agent-01',
        customerId: 'cust-01',
      };
      expect(VisitScheduledPayloadSchema.parse(valid)).toEqual(valid);
    });

    it('6. visit.completed validates single-write outcome', () => {
      const valid = {
        visitId: 'v-100',
        outcome: 'interested',
        occurredAt: new Date().toISOString(),
        loggedAt: new Date().toISOString(),
        nextStep: 'Send price sheet',
      };
      expect(VisitCompletedPayloadSchema.parse(valid)).toEqual(valid);

      expect(() =>
        VisitCompletedPayloadSchema.parse({
          ...valid,
          outcome: 'unknown_state',
        }),
      ).toThrow();
    });

    it('7. inventory.hold validates hold state and expiry', () => {
      const valid = {
        unitId: 'u-500',
        previousState: 'available',
        newState: 'hold',
        holderId: 'agent-10',
        reason: 'Cheque token collection',
        actorId: 'agent-10',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      };
      expect(InventoryHoldPayloadSchema.parse(valid)).toEqual(valid);

      expect(() =>
        InventoryHoldPayloadSchema.parse({
          ...valid,
          newState: 'blocked',
        }),
      ).toThrow();
    });

    it('8. inventory.block validates administrative block', () => {
      const valid = {
        unitId: 'u-500',
        previousState: 'available',
        newState: 'blocked',
        holderId: 'admin-01',
        reason: 'Developer management quota',
        actorId: 'admin-01',
      };
      expect(InventoryBlockPayloadSchema.parse(valid)).toEqual(valid);
    });

    it('9. inventory.release validates release to available', () => {
      const valid = {
        unitId: 'u-500',
        previousState: 'hold',
        newState: 'available',
        holderId: null,
        reason: 'Hold token expired',
        actorId: 'system_cron',
      };
      expect(InventoryReleasePayloadSchema.parse(valid)).toEqual(valid);
    });

    it('10. booking.created validates financial percentage and RERA gate state', () => {
      const valid = {
        bookingId: 'bk-100',
        dealId: 'dl-100',
        unitId: 'un-100',
        costSheetVersion: 1,
        collectedPercentageBasisPoints: 1000, // 10.00%
        agreementState: 'pending',
        gateState: 'rera_ten_percent_passed',
      };
      expect(BookingCreatedPayloadSchema.parse(valid)).toEqual(valid);

      expect(() =>
        BookingCreatedPayloadSchema.parse({
          ...valid,
          collectedPercentageBasisPoints: 10001, // exceeds 100%
        }),
      ).toThrow();
    });

    it('11. booking.cancelled validates controlled reasons and settlement state', () => {
      const valid = {
        bookingId: 'bk-100',
        reason: 'buyer_withdrawal',
        settlementState: 'opened',
        refundReference: 'REF-9876',
      };
      expect(BookingCancelledPayloadSchema.parse(valid)).toEqual(valid);

      expect(() =>
        BookingCancelledPayloadSchema.parse({
          ...valid,
          reason: 'unauthorized_reason',
        }),
      ).toThrow();
    });

    it('12. payment.received enforces safe integer paise and UTR reference', () => {
      const valid = {
        receiptId: 'rcpt-100',
        bookingId: 'bk-100',
        scheduleLineId: 'sch-1',
        amountPaise: 50000000, // ₹5,00,000.00
        mode: 'rtgs',
        utrReference: 'HDFC2611030001',
        reconciliationState: 'unreconciled',
      };
      expect(PaymentReceivedPayloadSchema.parse(valid)).toEqual(valid);

      // Rejects float paise
      expect(() =>
        PaymentReceivedPayloadSchema.parse({
          ...valid,
          amountPaise: 50000.5,
        }),
      ).toThrow();

      // Rejects negative paise
      expect(() =>
        PaymentReceivedPayloadSchema.parse({
          ...valid,
          amountPaise: -100,
        }),
      ).toThrow();

      // Rejects overflow > Number.MAX_SAFE_INTEGER
      expect(() =>
        PaymentReceivedPayloadSchema.parse({
          ...valid,
          amountPaise: Number.MAX_SAFE_INTEGER + 1,
        }),
      ).toThrow();
    });

    it('13. payment.reconciled validates accounting references and reconciler identity', () => {
      const valid = {
        receiptId: 'rcpt-100',
        demandLineId: 'dmd-1',
        evidenceReference: 'doc-bank-stmt-01',
        accountingEntryReference: 'tally-voucher-500',
        reconcilerId: 'finance-user-01',
      };
      expect(PaymentReconciledPayloadSchema.parse(valid)).toEqual(valid);
    });

    it('14. payment.reversed validates compensating reversal metadata', () => {
      const valid = {
        originalReceiptId: 'rcpt-100',
        reversalReceiptId: 'rcpt-rev-100',
        reason: 'Bounced cheque',
        approverId: 'finance-head-01',
      };
      expect(PaymentReversedPayloadSchema.parse(valid)).toEqual(valid);
    });

    it('15. demand.issued validates RERA registration and safe paise amount', () => {
      const valid = {
        demandId: 'dmd-500',
        bookingId: 'bk-100',
        scheduleLineId: 'sch-2',
        amountPaise: 100000000, // ₹10,00,000.00
        reraRegistrationNumber: 'P02400001234',
        issueDate: '2026-11-03',
      };
      expect(DemandIssuedPayloadSchema.parse(valid)).toEqual(valid);

      // Invalid calendar date rejected
      expect(() =>
        DemandIssuedPayloadSchema.parse({
          ...valid,
          issueDate: '2026-02-31',
        }),
      ).toThrow();
    });

    it('16. commission.accrued validates calculation snapshot pointer and safe paise', () => {
      const valid = {
        commissionId: 'comm-100',
        dealOrBookingId: 'bk-100',
        slabVersion: 1,
        collectionAmountPaise: 25000000,
        state: 'accrued',
        approverId: null,
        calculationSnapshotReference: 'snap-comm-100-v1',
      };
      expect(CommissionAccruedPayloadSchema.parse(valid)).toEqual(valid);
    });

    it('17. commission.approved requires approver identity', () => {
      const valid = {
        commissionId: 'comm-100',
        dealOrBookingId: 'bk-100',
        slabVersion: 1,
        collectionAmountPaise: 25000000,
        state: 'approved',
        approverId: 'sales-director-01',
        calculationSnapshotReference: 'snap-comm-100-v1',
      };
      expect(CommissionApprovedPayloadSchema.parse(valid)).toEqual(valid);

      expect(() =>
        CommissionApprovedPayloadSchema.parse({
          ...valid,
          approverId: '',
        }),
      ).toThrow();
    });

    it('18. commission.paid requires payout reference', () => {
      const valid = {
        commissionId: 'comm-100',
        dealOrBookingId: 'bk-100',
        slabVersion: 1,
        collectionAmountPaise: 25000000,
        state: 'paid',
        approverId: 'sales-director-01',
        payoutReference: 'BANK-PAYOUT-456',
      };
      expect(CommissionPaidPayloadSchema.parse(valid)).toEqual(valid);
    });

    it('19. commission.clawed-back validates compensating reference', () => {
      const valid = {
        commissionId: 'comm-100',
        dealOrBookingId: 'bk-100',
        reason: 'Booking cancelled prior to agreement',
        approverId: 'managing-director-01',
        compensatingReference: 'CN-2026-001',
      };
      expect(CommissionClawedBackPayloadSchema.parse(valid)).toEqual(valid);
    });

    it('20. cp.claim.registered validates server timestamps and protection window', () => {
      const valid = {
        claimId: 'clm-100',
        cpId: 'cp-agency-01',
        leadId: 'ld-100',
        projectId: 'prj-100',
        serverTimestamp: new Date().toISOString(),
        windowStart: new Date().toISOString(),
        windowExpiry: new Date(Date.now() + 90 * 86400000).toISOString(),
      };
      expect(CpClaimRegisteredPayloadSchema.parse(valid)).toEqual(valid);
    });

    it('21. cp.claim.expired validates expiry reason', () => {
      const valid = {
        claimId: 'clm-100',
        cpId: 'cp-agency-01',
        leadId: 'ld-100',
        projectId: 'prj-100',
        serverTimestamp: new Date().toISOString(),
        expiryReason: 'window_elapsed',
      };
      expect(CpClaimExpiredPayloadSchema.parse(valid)).toEqual(valid);
    });

    it('22. cp.claim.disputed validates dispute reason', () => {
      const valid = {
        claimId: 'clm-100',
        cpId: 'cp-agency-01',
        leadId: 'ld-100',
        projectId: 'prj-100',
        serverTimestamp: new Date().toISOString(),
        disputeReason: 'Direct walk-in registered prior to CP registration',
      };
      expect(CpClaimDisputedPayloadSchema.parse(valid)).toEqual(valid);
    });

    it('23. message.send.suppressed validates suppression reason and template ID', () => {
      const valid = {
        messageId: 'msg-100',
        recordId: 'lead-100',
        channel: 'whatsapp',
        suppressionReason: 'consent_withdrawn',
        templateId: 'tpl-property-brochure',
        attemptedAt: new Date().toISOString(),
      };
      expect(MessageSendSuppressedPayloadSchema.parse(valid)).toEqual(valid);
    });

    it('24. template.applied validates idempotent application metadata', () => {
      const valid = {
        orgId: '3f68a78a-c452-473d-9cb1-e01da13d5236',
        templateKey: 'real_estate_brokerage',
        version: '1.0.0',
        diffSummary: 'Provisioned 5 pipelines and 12 custom fields',
        applierId: 'admin-01',
        activationChecklistState: 'verified',
      };
      expect(TemplateAppliedPayloadSchema.parse(valid)).toEqual(valid);
    });

    it('25. template.rolled-back validates rollback metadata', () => {
      const valid = {
        orgId: '3f68a78a-c452-473d-9cb1-e01da13d5236',
        templateKey: 'real_estate_brokerage',
        version: '1.0.0',
        diffSummary: 'Restored previous configuration snapshot',
        applierId: 'admin-01',
      };
      expect(TemplateRolledBackPayloadSchema.parse(valid)).toEqual(valid);
    });

    it('26. audit.recorded validates append-only stream event', () => {
      const valid = {
        auditId: 'aud-100',
        orgId: '3f68a78a-c452-473d-9cb1-e01da13d5236',
        actorId: 'usr-100',
        action: 'pricing.update',
        entityType: 'unit',
        entityId: 'un-100',
        beforeStateHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        afterStateHash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
        timestamp: new Date().toISOString(),
      };
      expect(AuditRecordedPayloadSchema.parse(valid)).toEqual(valid);
    });
  });

  describe('Customer-Safe Integration Webhook Projections (Strict Allowlists)', () => {
    it('lead.converted webhook projection strictly rejects PII and extra fields', () => {
      const clean = {
        leadId: 'lead-100',
        contactId: 'contact-200',
        dealId: 'deal-300',
        convertedAt: new Date().toISOString(),
      };
      expect(RealEstateLeadConvertedWebhookPayloadSchema.parse(clean)).toEqual(clean);

      // Rejects phone numbers, emails, customer names
      expect(() =>
        RealEstateLeadConvertedWebhookPayloadSchema.parse({
          ...clean,
          phone: '+919876543210',
        }),
      ).toThrow();
      expect(() =>
        RealEstateLeadConvertedWebhookPayloadSchema.parse({
          ...clean,
          customerEmail: 'investor@example.com',
        }),
      ).toThrow();
    });

    it('visit.completed webhook projection strictly rejects GPS coordinates and signatures', () => {
      const clean = {
        visitId: 'v-100',
        listingId: 'lst-100',
        leadOrContactId: 'c-100',
        rating: 5,
        interestLevel: 'high',
        completedAt: new Date().toISOString(),
      };
      expect(RealEstateVisitCompletedWebhookPayloadSchema.parse(clean)).toEqual(clean);

      expect(() =>
        RealEstateVisitCompletedWebhookPayloadSchema.parse({
          ...clean,
          latitude: 17.385,
          longitude: 78.4867,
        }),
      ).toThrow();
    });

    it('booking.created webhook projection strictly rejects margin tokens and KYC PAN', () => {
      const clean = {
        bookingId: 'bk-100',
        dealId: 'dl-100',
        unitId: 'un-100',
        agreementState: 'pending',
        gateState: 'token_paid',
        createdAt: new Date().toISOString(),
      };
      expect(RealEstateBookingCreatedWebhookPayloadSchema.parse(clean)).toEqual(clean);

      expect(() =>
        RealEstateBookingCreatedWebhookPayloadSchema.parse({
          ...clean,
          panCardNumber: 'ABCDE1234F',
          developerCommissionMargin: 200000,
        }),
      ).toThrow();
    });

    it('booking.cancelled webhook projection strictly rejects bank account details', () => {
      const clean = {
        bookingId: 'bk-100',
        reason: 'loan_rejection',
        settlementState: 'refunded',
        cancelledAt: new Date().toISOString(),
      };
      expect(RealEstateBookingCancelledWebhookPayloadSchema.parse(clean)).toEqual(clean);

      expect(() =>
        RealEstateBookingCancelledWebhookPayloadSchema.parse({
          ...clean,
          refundBankAccount: '123456789012',
          refundIfsc: 'HDFC0001234',
        }),
      ).toThrow();
    });

    it('payment.reconciled webhook projection strictly rejects full UTR and payer bank details', () => {
      const clean = {
        receiptId: 'rcpt-100',
        demandLineId: 'dmd-100',
        amountPaise: 5000000,
        reconciledAt: new Date().toISOString(),
      };
      expect(RealEstatePaymentReconciledWebhookPayloadSchema.parse(clean)).toEqual(clean);

      expect(() =>
        RealEstatePaymentReconciledWebhookPayloadSchema.parse({
          ...clean,
          rawUtrString: 'RAW-UTR-LEAK',
        }),
      ).toThrow();
    });

    it('commission.paid webhook projection strictly rejects CP PAN and TDS breakdown', () => {
      const clean = {
        commissionId: 'comm-100',
        dealId: 'dl-100',
        bookingId: 'bk-100',
        amountPaise: 7500000,
        state: 'paid',
        paidAt: new Date().toISOString(),
      };
      expect(RealEstateCommissionPaidWebhookPayloadSchema.parse(clean)).toEqual(clean);

      expect(() =>
        RealEstateCommissionPaidWebhookPayloadSchema.parse({
          ...clean,
          cpPan: 'AAAAA9999Z',
          tdsPaise: 750000,
        }),
      ).toThrow();
    });
  });

  describe('Deduplication Stability, Non-Collision & Tenant Isolation', () => {
    it('produces identical dedupKey for the same tenant, entity, and version', () => {
      const key1 = buildRealEstateDedupKey('org-123', 'booking', 'b-456', 1);
      const key2 = buildRealEstateDedupKey('org-123', 'booking', 'b-456', 1);
      expect(key1).toBe('re:org-123:booking:b-456:1');
      expect(key1).toBe(key2);
    });

    it('guarantees tenant isolation: different orgs with same entityId NEVER collide', () => {
      const orgA = buildRealEstateDedupKey('org-A', 'booking', 'b-456', 1);
      const orgB = buildRealEstateDedupKey('org-B', 'booking', 'b-456', 1);
      expect(orgA).not.toBe(orgB);
      expect(orgA).toBe('re:org-A:booking:b-456:1');
      expect(orgB).toBe('re:org-B:booking:b-456:1');
    });

    it('guarantees distinct occurrences have distinct keys across versions and entities', () => {
      const v1 = buildRealEstateDedupKey('org-123', 'booking', 'b-456', 1);
      const v2 = buildRealEstateDedupKey('org-123', 'booking', 'b-456', 2);
      const otherEntity = buildRealEstateDedupKey('org-123', 'payment', 'b-456', 1);

      expect(v1).not.toBe(v2);
      expect(v1).not.toBe(otherEntity);
    });
  });

  describe('Canonical Event Envelope Schema', () => {
    it('validates a complete canonical Real Estate domain event envelope', () => {
      const envelope = {
        id: '272332bf-94c6-4d04-807a-d790d938aa82',
        orgId: '3f68a78a-c452-473d-9cb1-e01da13d5236',
        actorPersonId: 'usr-456',
        occurredAt: new Date().toISOString(),
        entityType: 'booking',
        entityId: 'bk-100',
        entityVersion: 1,
        type: 'booking.created',
        dedupKey: 're:3f68a78a-c452-473d-9cb1-e01da13d5236:booking:bk-100:1',
        payload: {
          bookingId: 'bk-100',
          dealId: 'dl-100',
        },
      };

      expect(RealEstateDomainEventEnvelopeSchema.parse(envelope)).toEqual(envelope);
    });

    it('rejects envelope with non-UUID id or orgId', () => {
      const invalid = {
        id: 'not-a-uuid',
        orgId: 'not-a-uuid',
        actorPersonId: 'usr-456',
        occurredAt: new Date().toISOString(),
        entityType: 'booking',
        entityId: 'bk-100',
        entityVersion: 1,
        type: 'booking.created',
        dedupKey: 'dedup-1',
        payload: {},
      };

      expect(() => RealEstateDomainEventEnvelopeSchema.parse(invalid)).toThrow();
    });

    it('rejects envelope with non-positive or non-integer entityVersion', () => {
      const base = {
        id: '272332bf-94c6-4d04-807a-d790d938aa82',
        orgId: '3f68a78a-c452-473d-9cb1-e01da13d5236',
        actorPersonId: 'usr-456',
        occurredAt: new Date().toISOString(),
        entityType: 'booking',
        entityId: 'bk-100',
        type: 'booking.created',
        dedupKey: 'dedup-1',
        payload: {},
      };

      expect(() =>
        RealEstateDomainEventEnvelopeSchema.parse({
          ...base,
          entityVersion: 0,
        }),
      ).toThrow();

      expect(() =>
        RealEstateDomainEventEnvelopeSchema.parse({
          ...base,
          entityVersion: 1.5,
        }),
      ).toThrow();
    });
  });
});
