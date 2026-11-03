/**
 * Pravshi OS — Real Estate Financial & Transaction Contracts (Layer 3).
 *
 * Enforces safe integer paise representations, aggregate overflow bounds against
 * Number.MAX_SAFE_INTEGER, canonical cost sheet hash formats, and booking consistency.
 */
import { z } from 'zod';
import { UuidSchema, MoneyPaiseSchema, CalendarDateSchema } from '../../base';

export const PricingStructureSchema = z
  .object({
    baseAmountPaise: MoneyPaiseSchema,
    floorRisePaise: MoneyPaiseSchema.default(0),
    preferentialLocationChargePaise: MoneyPaiseSchema.default(0),
    amenitiesChargePaise: MoneyPaiseSchema.default(0),
    clubhouseMembershipChargePaise: MoneyPaiseSchema.default(0),
    carParkingChargesPaise: MoneyPaiseSchema.default(0),
    statutoryTaxesEstimatedPaise: MoneyPaiseSchema.default(0),
    grossTotalPaise: MoneyPaiseSchema,
  })
  .refine(
    (p) => {
      const components = [
        p.baseAmountPaise,
        p.floorRisePaise,
        p.preferentialLocationChargePaise,
        p.amenitiesChargePaise,
        p.clubhouseMembershipChargePaise,
        p.carParkingChargesPaise,
        p.statutoryTaxesEstimatedPaise,
      ];
      let sum = 0;
      for (const amount of components) {
        if (sum > Number.MAX_SAFE_INTEGER - amount) {
          return false; // Aggregate overflow beyond safe integers
        }
        sum += amount;
      }
      return sum === p.grossTotalPaise && Number.isSafeInteger(sum);
    },
    {
      message:
        'FINANCIAL INTEGRITY ERROR: grossTotalPaise must equal component sum without aggregate overflow beyond MAX_SAFE_INTEGER',
      path: ['grossTotalPaise'],
    },
  );
export type PricingStructure = z.infer<typeof PricingStructureSchema>;

/**
 * Cost Sheet Snapshot with canonical payload hash format validation.
 *
 * NOTE ON CRYPTOGRAPHIC VERIFICATION:
 * Validating that snapshotHash matches /^[a-f0-9]{64}$/ is a contract-level syntax check only.
 * Actual cryptographic verification (RFC 8785 deterministic JSON canonicalization of
 * { costSheetId, inventoryAtomId, pricing, approvedByUserId, validUntil } and SHA-256 hashing)
 * is performed by the transactional domain service.
 */
export const CostSheetSnapshotSchema = z.object({
  costSheetId: UuidSchema,
  inventoryAtomId: UuidSchema,
  snapshotHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'Must be a 64-character lowercase SHA-256 hash of canonicalized JSON'),
  pricing: PricingStructureSchema,
  approvedByUserId: UuidSchema,
  validUntil: z.string().datetime(),
});
export type CostSheetSnapshot = z.infer<typeof CostSheetSnapshotSchema>;

export const BOOKING_STATUSES = [
  'token_received',
  'allotment_issued',
  'agreement_pending',
  'agreement_registered',
  'cancelled',
  'refunded',
  'completed',
] as const;
export const BookingStatusEnum = z.enum(BOOKING_STATUSES);
export type BookingStatus = z.infer<typeof BookingStatusEnum>;

export const STATUTORY_GATE_STATUSES = ['cleared', 'warning', 'blocked', 'exempted'] as const;
export const StatutoryGateStatusEnum = z.enum(STATUTORY_GATE_STATUSES);
export type StatutoryGateStatus = z.infer<typeof StatutoryGateStatusEnum>;

export const BookingContractSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    dealId: UuidSchema,
    inventoryAtomId: UuidSchema,
    buyerContactId: UuidSchema,
    channelPartnerId: UuidSchema.nullable().optional(),
    status: BookingStatusEnum,
    costSheetSnapshot: CostSheetSnapshotSchema,
    totalAgreedValuePaise: MoneyPaiseSchema,
    cumulativeCollectionsPaise: MoneyPaiseSchema.default(0),
    registeredAgreementDate: CalendarDateSchema.nullable().optional(),
    registeredAgreementNumber: z.string().nullable().optional(),
    statutoryGateStatus: StatutoryGateStatusEnum,
    statutoryGateDetails: z.array(z.string()).default([]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .refine((b) => b.totalAgreedValuePaise === b.costSheetSnapshot.pricing.grossTotalPaise, {
    message: 'totalAgreedValuePaise must exactly match costSheetSnapshot.pricing.grossTotalPaise',
    path: ['totalAgreedValuePaise'],
  })
  .refine((b) => b.cumulativeCollectionsPaise <= b.totalAgreedValuePaise, {
    message: 'cumulativeCollectionsPaise cannot exceed totalAgreedValuePaise',
    path: ['cumulativeCollectionsPaise'],
  })
  .refine(
    (b) => {
      if (b.status === 'agreement_registered') {
        return (
          b.registeredAgreementNumber !== null &&
          b.registeredAgreementNumber !== undefined &&
          b.registeredAgreementNumber.trim().length > 0 &&
          b.registeredAgreementDate !== null &&
          b.registeredAgreementDate !== undefined
        );
      }
      return true;
    },
    {
      message:
        'agreement_registered status requires non-empty registeredAgreementNumber and valid registeredAgreementDate',
      path: ['registeredAgreementNumber'],
    },
  );
export type BookingContract = z.infer<typeof BookingContractSchema>;
