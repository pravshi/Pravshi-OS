/**
 * Pravshi OS — CRM Attribution Governance Contract (Layer 2).
 *
 * Governs the correction of a lead's marketing origin (source, sub-category, campaign).
 * Founder decisions of 2026-11-06, enforced by migration 0089:
 *   - permissions: leads.attribution.request to ask, leads.attribution.approve to decide (approve
 *     or reject), leads.attribution.single_manager for the single-manager exception;
 *   - organization policy: TWO_PERSON (default) or SINGLE_MANAGER — there is no OFF value;
 *   - founder decisions F-SEC-12/F-SEC-13 (2026-11-07): the policy is changed only through
 *     settings.manage_attribution_policy (SUPER_ADMIN, not ADMIN) with step-up MFA; enabling
 *     SINGLE_MANAGER needs a second administrator's approval; returning to TWO_PERSON applies at
 *     once; using the exception also needs step-up MFA; every step is audited;
 *   - founder decisions F-SEC-19..F-SEC-23 (2026-11-08): step-up MFA means a session minted by a
 *     second-factor verification within the last ATTRIBUTION_STEP_UP_MAX_AGE_SECONDS, proven to the
 *     database by the SHA-256 of the caller's own session token — the server supplies it from the
 *     verified session, never from client input, so it is not part of these input schemas. It is
 *     required for every policy step, every correction approval and every use of the exception.
 *     Policy administration needs GLOBAL scope; approvers must be independent of the requester;
 *     requests expire after ATTRIBUTION_REQUEST_EXPIRY_DAYS and the requester is re-checked at
 *     approval;
 *   - a rejection needs a reason and never changes the lead's attribution.
 */
import { z } from 'zod';
import { UuidSchema } from '../base';

export const ATTRIBUTION_FIELDS = ['source', 'source_subcategory', 'campaign_id'] as const;
export const AttributionFieldEnum = z.enum(ATTRIBUTION_FIELDS);
export type AttributionField = z.infer<typeof AttributionFieldEnum>;

export const ATTRIBUTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export const AttributionStatusEnum = z.enum(ATTRIBUTION_STATUSES);
export type AttributionStatus = z.infer<typeof AttributionStatusEnum>;

/** The only two organization policies. Absent or any other stored value means TWO_PERSON. */
export const ATTRIBUTION_POLICIES = ['TWO_PERSON', 'SINGLE_MANAGER'] as const;
export const AttributionPolicyEnum = z.enum(ATTRIBUTION_POLICIES);
export type AttributionPolicy = z.infer<typeof AttributionPolicyEnum>;

export const ATTRIBUTION_PERMISSIONS = {
  request: 'leads.attribution.request',
  approve: 'leads.attribution.approve',
  singleManager: 'leads.attribution.single_manager',
  managePolicy: 'settings.manage_attribution_policy',
} as const;

/** Step-up MFA window: the approving session must have been minted by MFA this recently. */
export const ATTRIBUTION_STEP_UP_MAX_AGE_SECONDS = 300;

/** A pending correction or policy-change request older than this can never be approved. */
export const ATTRIBUTION_REQUEST_EXPIRY_DAYS = 7;

/** Minimum length of a rejection reason (the database enforces the same rule). */
export const ATTRIBUTION_REJECTION_REASON_MIN = 5;

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
  /** Set only on approval, and then equal to decidedByPersonId. */
  approvedByPersonId: UuidSchema.nullable().optional(),
  /** Who decided the request — approved or rejected. */
  decidedByPersonId: UuidSchema.nullable().optional(),
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

export const ReviewAttributionCorrectionInputSchema = z
  .object({
    correctionId: UuidSchema,
    decision: z.enum(['APPROVE', 'REJECT']),
    rejectionReason: z.string().trim().min(ATTRIBUTION_REJECTION_REASON_MIN).optional(),
  })
  .refine((v) => v.decision !== 'REJECT' || v.rejectionReason !== undefined, {
    message: 'A rejection requires a reason',
    path: ['rejectionReason'],
  });
export type ReviewAttributionCorrectionInput = z.infer<
  typeof ReviewAttributionCorrectionInputSchema
>;

/** Minimum length of a policy-change reason (the database enforces the same rule). */
export const ATTRIBUTION_POLICY_REASON_MIN = 10;

/** request_attribution_policy_change(policy, reason). */
export const RequestAttributionPolicyChangeInputSchema = z.object({
  policy: AttributionPolicyEnum,
  reason: z.string().trim().min(ATTRIBUTION_POLICY_REASON_MIN),
});
export type RequestAttributionPolicyChangeInput = z.infer<
  typeof RequestAttributionPolicyChangeInputSchema
>;

/** approve_ / reject_attribution_policy_change: by an administrator other than the requester. */
export const DecideAttributionPolicyChangeInputSchema = z
  .object({
    changeId: UuidSchema,
    decision: z.enum(['APPROVE', 'REJECT']),
    rejectionReason: z.string().trim().min(ATTRIBUTION_REJECTION_REASON_MIN).optional(),
  })
  .refine((v) => v.decision !== 'REJECT' || v.rejectionReason !== undefined, {
    message: 'A rejection requires a reason',
    path: ['rejectionReason'],
  });
export type DecideAttributionPolicyChangeInput = z.infer<
  typeof DecideAttributionPolicyChangeInputSchema
>;
