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
  slaDueAt: z.string().datetime(),
  firstContactedAt: z.string().datetime().nullable().optional(),
  firstSuccessfulContactAt: z.string().datetime().nullable().optional(),
  escalatedAt: z.string().datetime().nullable().optional(),
  consentRecordId: UuidSchema.nullable().optional(),
  convertedContactId: UuidSchema.nullable().optional(),
  /** Backwards compatibility alias for convertedContactId */
  conversionContactId: UuidSchema.nullable().optional(),
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
