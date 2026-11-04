/**
 * Pravshi OS — CRM Attribution Governance Contract (Layer 2).
 *
 * Governs two-person marketing origin correction workflows.
 */
import { z } from 'zod';
import { UuidSchema } from '../base';

export const ATTRIBUTION_FIELDS = ['source', 'source_subcategory', 'campaign_id'] as const;
export const AttributionFieldEnum = z.enum(ATTRIBUTION_FIELDS);
export type AttributionField = z.infer<typeof AttributionFieldEnum>;

export const ATTRIBUTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export const AttributionStatusEnum = z.enum(ATTRIBUTION_STATUSES);
export type AttributionStatus = z.infer<typeof AttributionStatusEnum>;

export const AttributionCorrectionSchema = z.object({
  id: UuidSchema,
  organizationId: UuidSchema,
  leadId: UuidSchema,
  fieldName: AttributionFieldEnum,
  oldValue: z.string().nullable().optional(),
  newValue: z.string().min(1),
  reason: z.string().min(10, 'Reason must be at least 10 characters explaining correction'),
  status: AttributionStatusEnum.default('PENDING'),
  requestedByPersonId: UuidSchema,
  approvedByPersonId: UuidSchema.nullable().optional(),
  requestedAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable().optional(),
  rejectionReason: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AttributionCorrection = z.infer<typeof AttributionCorrectionSchema>;

export const RequestAttributionCorrectionInputSchema = z.object({
  leadId: UuidSchema,
  fieldName: AttributionFieldEnum,
  newValue: z.string().min(1),
  reason: z.string().min(10, 'Reason must be at least 10 characters explaining correction'),
});
export type RequestAttributionCorrectionInput = z.infer<
  typeof RequestAttributionCorrectionInputSchema
>;

export const ReviewAttributionCorrectionInputSchema = z.object({
  correctionId: UuidSchema,
  decision: z.enum(['APPROVE', 'REJECT']),
  rejectionReason: z.string().min(5).optional(),
});
export type ReviewAttributionCorrectionInput = z.infer<
  typeof ReviewAttributionCorrectionInputSchema
>;
