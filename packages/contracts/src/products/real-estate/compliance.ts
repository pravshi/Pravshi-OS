/**
 * Pravshi OS — Real Estate Regulatory Compliance Contracts (Layer 3).
 *
 * Enforces contract-level fail-closed safety: unverified rules (PENDING_LEGAL_VERIFICATION)
 * and untrusted evidence can NEVER enforce hard_block. Hard blocking requires formal
 * counsel evidence AND a trusted server authorization stamp.
 */
import { z } from 'zod';
import { UuidSchema, CalendarDateSchema } from '../../base';
import { JurisdictionCodeSchema } from './jurisdiction';

export const RULE_VERIFICATION_STATUSES = [
  'PENDING_LEGAL_VERIFICATION',
  'VERIFIED_LEGAL_COUNSEL',
  'NOT_APPLICABLE',
] as const;
export const RuleVerificationStatusEnum = z.enum(RULE_VERIFICATION_STATUSES);
export type RuleVerificationStatus = z.infer<typeof RuleVerificationStatusEnum>;

export const ENFORCEMENT_BEHAVIORS = [
  'hard_block',
  'warning',
  'advisory',
  'disabled',
] as const;
export const EnforcementBehaviorEnum = z.enum(ENFORCEMENT_BEHAVIORS);
export type EnforcementBehavior = z.infer<typeof EnforcementBehaviorEnum>;

export const APPLICABLE_WORKFLOWS = [
  'project_publish',
  'agent_onboarding',
  'booking_advance',
  'agreement_generation',
  'demand_issuance',
  'commission_disbursement',
] as const;
export const ApplicableWorkflowEnum = z.enum(APPLICABLE_WORKFLOWS);
export type ApplicableWorkflow = z.infer<typeof ApplicableWorkflowEnum>;

/**
 * Raw submitted legal evidence.
 * Presence of these details DOES NOT constitute legal verification by itself.
 */
export const LegalVerificationDetailsSchema = z.object({
  verifiedByCounselName: z.string().min(3, 'Counsel name is required'),
  barCouncilRegistrationNumber: z.string().min(5, 'Valid Bar Council registration required'),
  legalOpinionDocumentRef: z.string().min(5, 'Legal opinion document reference is required'),
  opinionDocumentSha256: z.string().regex(/^[a-f0-9]{64}$/, 'Must be a 64-char lowercase SHA-256 hash of signed opinion'),
  verifiedAt: z.string().datetime(),
  statutoryGazetteReference: z.string().min(5, 'Official Gazette or statutory notification citation required'),
  verifiedScope: z.string().min(10, 'Specific scope of legal verification required'),
});
export type LegalVerificationDetails = z.infer<typeof LegalVerificationDetailsSchema>;

/**
 * Trusted server-authoritative approval stamp.
 * Recorded only via platform administrator review and verified audit logging.
 */
export const ServerLegalApprovalStampSchema = z.object({
  platformReviewerUserId: UuidSchema,
  verifiedAuditLogId: UuidSchema,
  trustedVerificationTimestamp: z.string().datetime(),
  verificationTrustStatus: z.enum(['UNVERIFIED', 'SUBMITTED', 'VERIFIED_TRUSTED']),
});
export type ServerLegalApprovalStamp = z.infer<typeof ServerLegalApprovalStampSchema>;

export const RegulatoryRuleContractSchema = z
  .object({
    jurisdiction: JurisdictionCodeSchema,
    ruleIdentifier: z.string().min(3).max(100),
    sourceReference: z.string().min(3).max(255),
    effectiveDate: CalendarDateSchema,
    verificationStatus: RuleVerificationStatusEnum.default('PENDING_LEGAL_VERIFICATION'),
    applicableWorkflow: ApplicableWorkflowEnum,
    enforcementBehavior: EnforcementBehaviorEnum.default('advisory'),
    parameters: z.record(z.string(), z.unknown()).default({}),
    submittedEvidence: LegalVerificationDetailsSchema.nullable().optional(),
    serverApprovalStamp: ServerLegalApprovalStampSchema.nullable().optional(),
  })
  .refine(
    (rule) => {
      // Invariant 1: Rules with PENDING_LEGAL_VERIFICATION must NEVER be allowed to hard_block
      if (rule.verificationStatus === 'PENDING_LEGAL_VERIFICATION') {
        return rule.enforcementBehavior !== 'hard_block';
      }
      return true;
    },
    {
      message: 'SAFETY VIOLATION: A regulatory rule with PENDING_LEGAL_VERIFICATION cannot enforce hard_block. Verified legal counsel is required.',
      path: ['enforcementBehavior'],
    }
  )
  .refine(
    (rule) => {
      // Invariant 2: hard_block enforcement strictly requires VERIFIED_LEGAL_COUNSEL with a VERIFIED_TRUSTED server approval stamp
      if (rule.enforcementBehavior === 'hard_block') {
        return (
          rule.verificationStatus === 'VERIFIED_LEGAL_COUNSEL' &&
          rule.submittedEvidence !== null &&
          rule.submittedEvidence !== undefined &&
          rule.serverApprovalStamp?.verificationTrustStatus === 'VERIFIED_TRUSTED'
        );
      }
      return true;
    },
    {
      message: 'hard_block enforcement strictly requires VERIFIED_LEGAL_COUNSEL with verified submittedEvidence AND a VERIFIED_TRUSTED server approval stamp.',
      path: ['enforcementBehavior'],
    }
  )
  .refine(
    (rule) => {
      // Invariant 3: NOT_APPLICABLE rules must be disabled
      if (rule.verificationStatus === 'NOT_APPLICABLE') {
        return rule.enforcementBehavior === 'disabled';
      }
      return true;
    },
    {
      message: 'Rules marked NOT_APPLICABLE must have enforcementBehavior set to disabled.',
      path: ['enforcementBehavior'],
    }
  );

export type RegulatoryRuleContract = z.infer<typeof RegulatoryRuleContractSchema>;

export const JurisdictionComplianceConfigSchema = z.object({
  jurisdiction: JurisdictionCodeSchema,
  jurisdictionName: z.string(),
  reraAuthorityName: z.string(),
  reraPortalUrl: z.string().url(),
  projectRegistrationNumberPattern: z.string(),
  agentLicenseNumberPattern: z.string(),
  rules: z.array(RegulatoryRuleContractSchema),
  requiredDocumentsByWorkflow: z.record(ApplicableWorkflowEnum, z.array(z.string())),
});
export type JurisdictionComplianceConfig = z.infer<typeof JurisdictionComplianceConfigSchema>;
