/**
 * Real Estate Contracts — Domain Events, Webhook Projections & Envelope (Layer 3).
 *
 * Reconciled against Document B §9.2 ("Event inventory (cross-module)", pages 54–57).
 * Pure schema and contract definitions without database, network, or server dependencies.
 */
import { z } from 'zod';
import { CalendarDateSchema, MoneyPaiseSchema, UuidSchema } from '../../base';

// ── 1. The Authoritative 26-Event Catalogue ──────────────────────────────────────────────

export const REAL_ESTATE_EVENT_TYPES = [
  // 1. Lead lifecycle (Producer: M1)
  'lead.created',
  'lead.assigned',
  'lead.converted',
  // 2. Consent ledger (Producer: M2)
  'consent.withdrawn',
  // 3. Site visit (Producer: M8)
  'visit.scheduled',
  'visit.completed',
  // 4. Inventory atom locking & availability (Producer: M15)
  'inventory.hold',
  'inventory.block',
  'inventory.release',
  // 5. Booking & RERA gate (Producer: M24)
  'booking.created',
  'booking.cancelled',
  // 6. Payment & collections (Producer: M26)
  'payment.received',
  'payment.reconciled',
  'payment.reversed',
  // 7. Demand letters (Producer: M26)
  'demand.issued',
  // 8. Commission & brokerage (Producer: M13)
  'commission.accrued',
  'commission.approved',
  'commission.paid',
  'commission.clawed-back',
  // 9. Channel Partner claims (Producer: M12)
  'cp.claim.registered',
  'cp.claim.expired',
  'cp.claim.disputed',
  // 10. Messaging suppression audit (Producer: M20 via M31)
  'message.send.suppressed',
  // 11. Template operations (Producer: M36)
  'template.applied',
  'template.rolled-back',
  // 12. Security & governance stream (Producer: M36 audit service)
  'audit.recorded',
] as const;

export type RealEstateEventType = (typeof REAL_ESTATE_EVENT_TYPES)[number];
export const RealEstateEventTypeSchema = z.enum(REAL_ESTATE_EVENT_TYPES);

/**
 * 11 Real Estate workflow trigger event types.
 * Registered in the workflow vocabulary; runtime activation remains DEFERRED in P0.
 */
export const DEFERRED_RE_WORKFLOW_TRIGGER_TYPES = [
  'lead.created',
  'lead.assigned',
  'lead.converted',
  'visit.scheduled',
  'visit.completed',
  'booking.created',
  'booking.cancelled',
  'payment.reconciled',
  'demand.issued',
  'commission.approved',
  'cp.claim.disputed',
] as const;

export type DeferredRealEstateWorkflowTriggerType =
  (typeof DEFERRED_RE_WORKFLOW_TRIGGER_TYPES)[number];

/**
 * 6 Outbound integration webhook event keys.
 * Contracts & safe projections defined in P0; delivery remains DISABLED in fan-out.
 */
export const DEFERRED_RE_INTEGRATION_EVENT_KEYS = [
  'lead.converted',
  'visit.completed',
  'booking.created',
  'booking.cancelled',
  'payment.reconciled',
  'commission.paid',
] as const;

export type DeferredRealEstateIntegrationEventKey =
  (typeof DEFERRED_RE_INTEGRATION_EVENT_KEYS)[number];

// ── 2. Entity Types ─────────────────────────────────────────────────────────────────────

export const REAL_ESTATE_ENTITY_TYPES = [
  'lead',
  'consent',
  'visit',
  'inventory_atom',
  'booking',
  'payment',
  'demand',
  'commission',
  'cp_claim',
  'template',
  'audit',
] as const;

export type RealEstateEntityType = (typeof REAL_ESTATE_ENTITY_TYPES)[number];
export const RealEstateEntityTypeSchema = z.enum(REAL_ESTATE_ENTITY_TYPES);

// ── 3. Exact 26 Domain Event Payload Schemas ────────────────────────────────────────────

// 1. lead.created
export const LeadCreatedPayloadSchema = z.strictObject({
  leadId: z.string().min(1),
  source: z.enum(['website_form', 'manual', 'channel_partner', 'portal_import', 'campaign']),
  projectInterest: z.string().min(1).optional(),
  phoneMasked: z.string().min(1).optional(), // Masked in logs (e.g. '******1234')
  consentState: z.enum(['opted_in', 'pending', 'exempt']),
});
export type LeadCreatedPayload = z.infer<typeof LeadCreatedPayloadSchema>;

// 2. lead.assigned
export const LeadAssignedPayloadSchema = z.strictObject({
  leadId: z.string().min(1),
  previousOwnerId: z.string().min(1).nullable(),
  newOwnerId: z.string().min(1),
  assignmentRule: z.string().min(1),
  reason: z.string().min(1),
});
export type LeadAssignedPayload = z.infer<typeof LeadAssignedPayloadSchema>;

// 3. lead.converted
export const LeadConvertedPayloadSchema = z.strictObject({
  leadId: z.string().min(1),
  contactId: z.string().min(1),
  dealId: z.string().min(1),
  convertedAt: z.string().datetime(),
});
export type LeadConvertedPayload = z.infer<typeof LeadConvertedPayloadSchema>;

// 4. consent.withdrawn
export const ConsentWithdrawnPayloadSchema = z.strictObject({
  contactId: z.string().min(1),
  channel: z.enum(['whatsapp', 'sms', 'email', 'phone_call']),
  purpose: z.enum(['marketing', 'transactional', 'site_visit', 'all']),
  withdrawnAt: z.string().datetime(),
  source: z.string().min(1),
});
export type ConsentWithdrawnPayload = z.infer<typeof ConsentWithdrawnPayloadSchema>;

// 5. visit.scheduled
export const VisitScheduledPayloadSchema = z.strictObject({
  visitId: z.string().min(1),
  leadOrDealId: z.string().min(1),
  unitOrPropertyId: z.string().min(1),
  slotStart: z.string().datetime(),
  slotEnd: z.string().datetime(),
  agentId: z.string().min(1),
  customerId: z.string().min(1),
});
export type VisitScheduledPayload = z.infer<typeof VisitScheduledPayloadSchema>;

// 6. visit.completed
export const VisitCompletedPayloadSchema = z.strictObject({
  visitId: z.string().min(1),
  outcome: z.enum(['interested', 'not_interested', 'rescheduled_needed', 'token_offered']),
  occurredAt: z.string().datetime(),
  loggedAt: z.string().datetime(),
  nextStep: z.string().optional(),
});
export type VisitCompletedPayload = z.infer<typeof VisitCompletedPayloadSchema>;

// 7. inventory.hold
export const InventoryHoldPayloadSchema = z.strictObject({
  unitId: z.string().min(1),
  previousState: z.string().min(1),
  newState: z.literal('hold'),
  holderId: z.string().min(1),
  reason: z.string().min(1),
  actorId: z.string().min(1),
  expiresAt: z.string().datetime(),
});
export type InventoryHoldPayload = z.infer<typeof InventoryHoldPayloadSchema>;

// 8. inventory.block
export const InventoryBlockPayloadSchema = z.strictObject({
  unitId: z.string().min(1),
  previousState: z.string().min(1),
  newState: z.literal('blocked'),
  holderId: z.string().min(1),
  reason: z.string().min(1),
  actorId: z.string().min(1),
});
export type InventoryBlockPayload = z.infer<typeof InventoryBlockPayloadSchema>;

// 9. inventory.release
export const InventoryReleasePayloadSchema = z.strictObject({
  unitId: z.string().min(1),
  previousState: z.string().min(1),
  newState: z.literal('available'),
  holderId: z.string().min(1).nullable(),
  reason: z.string().min(1),
  actorId: z.string().min(1),
});
export type InventoryReleasePayload = z.infer<typeof InventoryReleasePayloadSchema>;

// 10. booking.created
export const BookingCreatedPayloadSchema = z.strictObject({
  bookingId: z.string().min(1),
  dealId: z.string().min(1),
  unitId: z.string().min(1),
  costSheetVersion: z.number().int().min(1),
  collectedPercentageBasisPoints: z.number().int().min(0).max(10000), // e.g. 1000 = 10.00%
  agreementState: z.enum(['pending', 'drafted', 'registered']),
  gateState: z.enum(['token_paid', 'under_ten_percent', 'rera_ten_percent_passed']),
});
export type BookingCreatedPayload = z.infer<typeof BookingCreatedPayloadSchema>;

// 11. booking.cancelled
export const BookingCancelledPayloadSchema = z.strictObject({
  bookingId: z.string().min(1),
  reason: z.enum([
    'buyer_withdrawal',
    'loan_rejection',
    'developer_cancellation',
    'mutual_agreement',
  ]),
  settlementState: z.enum(['pending', 'opened', 'refunded', 'forfeited']),
  refundReference: z.string().optional(),
});
export type BookingCancelledPayload = z.infer<typeof BookingCancelledPayloadSchema>;

// 12. payment.received
export const PaymentReceivedPayloadSchema = z.strictObject({
  receiptId: z.string().min(1),
  bookingId: z.string().min(1),
  scheduleLineId: z.string().min(1),
  amountPaise: MoneyPaiseSchema,
  mode: z.enum(['neft', 'rtgs', 'imps', 'upi', 'cheque']),
  utrReference: z.string().min(1),
  reconciliationState: z.enum(['unreconciled', 'matched', 'manual_review']),
});
export type PaymentReceivedPayload = z.infer<typeof PaymentReceivedPayloadSchema>;

// 13. payment.reconciled
export const PaymentReconciledPayloadSchema = z.strictObject({
  receiptId: z.string().min(1),
  demandLineId: z.string().min(1),
  evidenceReference: z.string().min(1),
  accountingEntryReference: z.string().min(1),
  reconcilerId: z.string().min(1),
});
export type PaymentReconciledPayload = z.infer<typeof PaymentReconciledPayloadSchema>;

// 14. payment.reversed
export const PaymentReversedPayloadSchema = z.strictObject({
  originalReceiptId: z.string().min(1),
  reversalReceiptId: z.string().min(1),
  reason: z.string().min(1),
  approverId: z.string().min(1),
});
export type PaymentReversedPayload = z.infer<typeof PaymentReversedPayloadSchema>;

// 15. demand.issued
export const DemandIssuedPayloadSchema = z.strictObject({
  demandId: z.string().min(1),
  bookingId: z.string().min(1),
  scheduleLineId: z.string().min(1),
  amountPaise: MoneyPaiseSchema,
  reraRegistrationNumber: z.string().min(1),
  issueDate: CalendarDateSchema,
});
export type DemandIssuedPayload = z.infer<typeof DemandIssuedPayloadSchema>;

// 16. commission.accrued
export const CommissionAccruedPayloadSchema = z.strictObject({
  commissionId: z.string().min(1),
  dealOrBookingId: z.string().min(1),
  slabVersion: z.number().int().min(1),
  collectionAmountPaise: MoneyPaiseSchema,
  state: z.literal('accrued'),
  approverId: z.string().min(1).nullable(),
  calculationSnapshotReference: z.string().min(1),
});
export type CommissionAccruedPayload = z.infer<typeof CommissionAccruedPayloadSchema>;

// 17. commission.approved
export const CommissionApprovedPayloadSchema = z.strictObject({
  commissionId: z.string().min(1),
  dealOrBookingId: z.string().min(1),
  slabVersion: z.number().int().min(1),
  collectionAmountPaise: MoneyPaiseSchema,
  state: z.literal('approved'),
  approverId: z.string().min(1),
  calculationSnapshotReference: z.string().min(1),
});
export type CommissionApprovedPayload = z.infer<typeof CommissionApprovedPayloadSchema>;

// 18. commission.paid
export const CommissionPaidPayloadSchema = z.strictObject({
  commissionId: z.string().min(1),
  dealOrBookingId: z.string().min(1),
  slabVersion: z.number().int().min(1),
  collectionAmountPaise: MoneyPaiseSchema,
  state: z.literal('paid'),
  approverId: z.string().min(1),
  payoutReference: z.string().min(1),
});
export type CommissionPaidPayload = z.infer<typeof CommissionPaidPayloadSchema>;

// 19. commission.clawed-back
export const CommissionClawedBackPayloadSchema = z.strictObject({
  commissionId: z.string().min(1),
  dealOrBookingId: z.string().min(1),
  reason: z.string().min(1),
  approverId: z.string().min(1),
  compensatingReference: z.string().min(1),
});
export type CommissionClawedBackPayload = z.infer<typeof CommissionClawedBackPayloadSchema>;

// 20. cp.claim.registered
export const CpClaimRegisteredPayloadSchema = z.strictObject({
  claimId: z.string().min(1),
  cpId: z.string().min(1),
  leadId: z.string().min(1),
  projectId: z.string().min(1),
  serverTimestamp: z.string().datetime(),
  windowStart: z.string().datetime(),
  windowExpiry: z.string().datetime(),
});
export type CpClaimRegisteredPayload = z.infer<typeof CpClaimRegisteredPayloadSchema>;

// 21. cp.claim.expired
export const CpClaimExpiredPayloadSchema = z.strictObject({
  claimId: z.string().min(1),
  cpId: z.string().min(1),
  leadId: z.string().min(1),
  projectId: z.string().min(1),
  serverTimestamp: z.string().datetime(),
  expiryReason: z.enum(['window_elapsed', 'manual_invalidation', 'conflict_resolved']),
});
export type CpClaimExpiredPayload = z.infer<typeof CpClaimExpiredPayloadSchema>;

// 22. cp.claim.disputed
export const CpClaimDisputedPayloadSchema = z.strictObject({
  claimId: z.string().min(1),
  cpId: z.string().min(1),
  leadId: z.string().min(1),
  projectId: z.string().min(1),
  serverTimestamp: z.string().datetime(),
  disputeReason: z.string().min(1),
});
export type CpClaimDisputedPayload = z.infer<typeof CpClaimDisputedPayloadSchema>;

// 23. message.send.suppressed
export const MessageSendSuppressedPayloadSchema = z.strictObject({
  messageId: z.string().min(1),
  recordId: z.string().min(1),
  channel: z.enum(['whatsapp', 'sms', 'email']),
  suppressionReason: z.enum([
    'consent_withdrawn',
    'opt_out',
    'rate_budget_exceeded',
    'dnd_quiet_hours',
  ]),
  templateId: z.string().min(1),
  attemptedAt: z.string().datetime(),
});
export type MessageSendSuppressedPayload = z.infer<typeof MessageSendSuppressedPayloadSchema>;

// 24. template.applied
export const TemplateAppliedPayloadSchema = z.strictObject({
  orgId: z.string().uuid(),
  templateKey: z.string().min(1),
  version: z.string().min(1),
  diffSummary: z.string().min(1),
  applierId: z.string().min(1),
  activationChecklistState: z.enum(['pending', 'verified']),
});
export type TemplateAppliedPayload = z.infer<typeof TemplateAppliedPayloadSchema>;

// 25. template.rolled-back
export const TemplateRolledBackPayloadSchema = z.strictObject({
  orgId: z.string().uuid(),
  templateKey: z.string().min(1),
  version: z.string().min(1),
  diffSummary: z.string().min(1),
  applierId: z.string().min(1),
});
export type TemplateRolledBackPayload = z.infer<typeof TemplateRolledBackPayloadSchema>;

// 26. audit.recorded
export const AuditRecordedPayloadSchema = z.strictObject({
  auditId: z.string().min(1),
  orgId: z.string().uuid(),
  actorId: z.string().min(1),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  beforeStateHash: z.string().optional(),
  afterStateHash: z.string().optional(),
  timestamp: z.string().datetime(),
});
export type AuditRecordedPayload = z.infer<typeof AuditRecordedPayloadSchema>;

// ── 4. Customer-Safe Integration Webhook Projections ────────────────────────────────────

/**
 * Lead Converted Webhook Payload.
 * Customer-facing allowlist: strictly omits phone, email, name, and agent notes.
 */
export const RealEstateLeadConvertedWebhookPayloadSchema = z.strictObject({
  leadId: z.string().min(1),
  contactId: z.string().min(1),
  dealId: z.string().min(1),
  convertedAt: z.string().datetime(),
});
export type RealEstateLeadConvertedWebhookPayload = z.infer<
  typeof RealEstateLeadConvertedWebhookPayloadSchema
>;

/**
 * Site Visit Completed Webhook Payload.
 * Customer-facing allowlist: strictly omits GPS coordinates and client signatures.
 */
export const RealEstateVisitCompletedWebhookPayloadSchema = z.strictObject({
  visitId: z.string().min(1),
  listingId: z.string().min(1),
  leadOrContactId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  interestLevel: z.enum(['high', 'medium', 'low', 'not_interested']),
  completedAt: z.string().datetime(),
});
export type RealEstateVisitCompletedWebhookPayload = z.infer<
  typeof RealEstateVisitCompletedWebhookPayloadSchema
>;

/**
 * Booking Created Webhook Payload.
 * Customer-facing allowlist: strictly omits margins, banking tokens, and KYC PAN.
 */
export const RealEstateBookingCreatedWebhookPayloadSchema = z.strictObject({
  bookingId: z.string().min(1),
  dealId: z.string().min(1),
  unitId: z.string().min(1),
  agreementState: z.enum(['pending', 'drafted', 'registered']),
  gateState: z.enum(['token_paid', 'under_ten_percent', 'rera_ten_percent_passed']),
  createdAt: z.string().datetime(),
});
export type RealEstateBookingCreatedWebhookPayload = z.infer<
  typeof RealEstateBookingCreatedWebhookPayloadSchema
>;

/**
 * Booking Cancelled Webhook Payload.
 * Customer-facing allowlist: strictly omits bank account numbers and internal dispute memos.
 */
export const RealEstateBookingCancelledWebhookPayloadSchema = z.strictObject({
  bookingId: z.string().min(1),
  reason: z.enum([
    'buyer_withdrawal',
    'loan_rejection',
    'developer_cancellation',
    'mutual_agreement',
  ]),
  settlementState: z.enum(['pending', 'opened', 'refunded', 'forfeited']),
  cancelledAt: z.string().datetime(),
});
export type RealEstateBookingCancelledWebhookPayload = z.infer<
  typeof RealEstateBookingCancelledWebhookPayloadSchema
>;

/**
 * Payment Reconciled Webhook Payload.
 * Customer-facing allowlist: strictly omits full UTRs, cheque scans, and bank account numbers.
 */
export const RealEstatePaymentReconciledWebhookPayloadSchema = z.strictObject({
  receiptId: z.string().min(1),
  demandLineId: z.string().min(1),
  amountPaise: MoneyPaiseSchema,
  reconciledAt: z.string().datetime(),
});
export type RealEstatePaymentReconciledWebhookPayload = z.infer<
  typeof RealEstatePaymentReconciledWebhookPayloadSchema
>;

/**
 * Commission Paid Webhook Payload.
 * Customer-facing allowlist: strictly omits CP PAN, bank account, and TDS breakdown.
 */
export const RealEstateCommissionPaidWebhookPayloadSchema = z.strictObject({
  commissionId: z.string().min(1),
  dealId: z.string().min(1),
  bookingId: z.string().min(1),
  amountPaise: MoneyPaiseSchema,
  state: z.literal('paid'),
  paidAt: z.string().datetime(),
});
export type RealEstateCommissionPaidWebhookPayload = z.infer<
  typeof RealEstateCommissionPaidWebhookPayloadSchema
>;

// ── 5. Canonical Real Estate Domain Event Envelope ──────────────────────────────────────

/**
 * Canonical envelope schema for all Real Estate domain events.
 * Carries server-verified tenant and actor context alongside the validated payload.
 */
export const RealEstateDomainEventEnvelopeSchema = z.strictObject({
  id: UuidSchema,
  orgId: UuidSchema,
  actorPersonId: z.string().min(1),
  occurredAt: z.string().datetime(),
  entityType: RealEstateEntityTypeSchema,
  entityId: z.string().min(1),
  entityVersion: z.number().int().min(1),
  type: RealEstateEventTypeSchema,
  dedupKey: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type RealEstateDomainEventEnvelope<
  TType extends RealEstateEventType = RealEstateEventType,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = {
  readonly id: string;
  readonly orgId: string;
  readonly actorPersonId: string;
  readonly occurredAt: string;
  readonly entityType: RealEstateEntityType;
  readonly entityId: string;
  readonly entityVersion: number;
  readonly type: TType;
  readonly dedupKey: string;
  readonly payload: TPayload;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

// ── 6. Deterministic Deduplication Helper Contract ──────────────────────────────────────

/**
 * Generates a tenant-scoped deterministic deduplication key for Real Estate domain events.
 * Guarantees cross-tenant isolation and per-occurrence uniqueness.
 *
 * Example: `buildRealEstateDedupKey('org-123', 'booking', 'b-456', 2)`
 *       -> `'re:org-123:booking:b-456:2'`
 */
export function buildRealEstateDedupKey(
  orgId: string,
  entityType: string,
  entityId: string,
  versionOrAction: string | number,
): string {
  return ['re', orgId, entityType, entityId, String(versionOrAction)]
    .filter((p) => p !== '')
    .join(':');
}
