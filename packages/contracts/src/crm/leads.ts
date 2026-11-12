/**
 * Pravshi OS — Shared Generic Lead Contract (Layer 2).
 *
 * Owned by packages/contracts; implemented by packages/crm-core.
 * Real estate extensions are defined separately in packages/contracts/products/real-estate/leads.ts.
 */
import { z } from 'zod';
import { UuidSchema } from '../base';

export const LEAD_STAGES = [
  'new',
  'contacted',
  'qualified',
  'nurturing',
  'unqualified',
  'converted',
] as const;
export const LeadStageEnum = z.enum(LEAD_STAGES);
export type LeadStage = z.infer<typeof LeadStageEnum>;

export const LEAD_SOURCES = [
  'website',
  'webhook',
  'whatsapp',
  'portal_99acres',
  'portal_housing',
  'portal_magicbricks',
  'referral',
  'walk_in',
  'campaign',
  'manual',
] as const;
export const LeadSourceEnum = z.enum(LEAD_SOURCES);
export type LeadSource = z.infer<typeof LeadSourceEnum>;

/**
 * Compatibility rule (PR-P1-01 review, F-P118-7): this contract is additive. Every payload valid
 * under the previous version stays valid — no field is removed, renamed or made newly required.
 * Fields the newer model supersedes are kept, marked @deprecated, and stay optional.
 */
export const LeadContractSchema = z.object({
  id: UuidSchema,
  organizationId: UuidSchema,
  fullName: z.string().min(1).max(255),
  primaryPhone: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Must be a valid E.164 phone number'),
  email: z.string().email().nullable().optional(),
  source: LeadSourceEnum,
  sourceSubcategory: z.string().optional(),
  campaignId: z.string().optional(),
  ownerId: UuidSchema.nullable().optional(),
  teamId: UuidSchema.nullable().optional(),
  stage: LeadStageEnum.default('new'),
  /** Always present on leads read from 0089 onwards; optional so earlier payloads still parse. */
  slaDueAt: z.string().datetime().optional(),
  firstContactedAt: z.string().datetime().nullable().optional(),
  firstSuccessfulContactAt: z.string().datetime().nullable().optional(),
  escalatedAt: z.string().datetime().nullable().optional(),
  consentRecordId: UuidSchema.nullable().optional(),
  convertedContactId: UuidSchema.nullable().optional(),
  /** @deprecated Use convertedContactId. Kept for payloads of the previous contract version. */
  conversionContactId: UuidSchema.nullable().optional(),
  /**
   * @deprecated A lead converts to a contact (convertedContactId); deals are linked from the
   * contact. Accepted for payloads of the previous contract version; never populated by 0089.
   */
  conversionDealId: UuidSchema.nullable().optional(),
  convertedAt: z.string().datetime().nullable().optional(),
  mergedIntoLeadId: UuidSchema.nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type LeadContract = z.infer<typeof LeadContractSchema>;

export const LeadCaptureInputSchema = z.object({
  fullName: z.string().min(1).max(255),
  primaryPhone: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Must be a valid E.164 phone number'),
  email: z.string().email().nullable().optional(),
  source: LeadSourceEnum.default('website'),
  sourceSubcategory: z.string().optional(),
  campaignId: z.string().optional(),
  notes: z.string().optional(),
  consentProof: z
    .object({
      channel: z.enum(['whatsapp', 'sms', 'email', 'phone']),
      capturedAt: z.string().datetime(),
      optInText: z.string().min(5),
    })
    .optional(),
});
export type LeadCaptureInput = z.infer<typeof LeadCaptureInputSchema>;
