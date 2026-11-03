/**
 * Pravshi OS — Real Estate Site Visit Contracts (Layer 3).
 *
 * Enforces start < end timing, privacy-preserving verification proofs (DPDP Act),
 * and strict server-authoritative 24-hour outcome discipline derivation.
 */
import { z } from 'zod';
import { UuidSchema } from '../../base';

export const SITE_VISIT_STATUSES = [
  'scheduled',
  'rescheduled',
  'confirmed',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
] as const;
export const SiteVisitStatusEnum = z.enum(SITE_VISIT_STATUSES);
export type SiteVisitStatus = z.infer<typeof SiteVisitStatusEnum>;

export const CLIENT_INTEREST_LEVELS = ['high', 'medium', 'low', 'lost'] as const;
export const ClientInterestLevelEnum = z.enum(CLIENT_INTEREST_LEVELS);
export type ClientInterestLevel = z.infer<typeof ClientInterestLevelEnum>;

export const SiteVisitScheduleSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    leadId: UuidSchema,
    propertyOrProjectId: UuidSchema,
    inventoryAtomId: UuidSchema.optional(),
    assignedAgentId: UuidSchema,
    scheduledStartTime: z.string().datetime(),
    scheduledEndTime: z.string().datetime(),
    pickupRequired: z.boolean().default(false),
    pickupAddress: z.string().optional(),
    companionCount: z.number().int().nonnegative().default(0),
    status: SiteVisitStatusEnum.default('scheduled'),
  })
  .refine(
    (data) =>
      new Date(data.scheduledEndTime).getTime() > new Date(data.scheduledStartTime).getTime(),
    {
      message: 'scheduledEndTime must be strictly later than scheduledStartTime',
      path: ['scheduledEndTime'],
    },
  );
export type SiteVisitSchedule = z.infer<typeof SiteVisitScheduleSchema>;

/**
 * Privacy-Preserving Verification Proof (DPDP Act Compliant)
 */
export const VerificationProofDataSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('otp'),
    telecomMessageRef: z.string().min(5),
    verifiedTokenSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'Must be a 64-character SHA-256 hash of token'),
    verifiedAt: z.string().datetime(),
  }),
  z.object({
    method: z.literal('geo_checkin'),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyMeters: z.number().positive(),
    distanceFromPropertyMeters: z.number().nonnegative(),
  }),
  z.object({
    method: z.literal('agent_pin'),
    agentUserId: UuidSchema,
    pinHashSha256: z.string().regex(/^[a-f0-9]{64}$/, 'Must be a 64-character SHA-256 hash of PIN'),
  }),
  z.object({
    method: z.literal('manual_override'),
    overrideAuthorizedByUserId: UuidSchema,
    overrideReason: z
      .string()
      .min(15, 'Manual override reason must be at least 15 characters of justification'),
  }),
]);
export type VerificationProofData = z.infer<typeof VerificationProofDataSchema>;

/**
 * Client submission payload: strictly omits isCompletedWithin24Hours.
 * Clients cannot supply timing claims.
 */
export const SiteVisitOutcomeInputSchema = z
  .object({
    siteVisitId: UuidSchema,
    completedAt: z.string().datetime(),
    outcomeStatus: z.enum(['completed', 'cancelled', 'no_show']),
    verificationProof: VerificationProofDataSchema,
    interestLevel: ClientInterestLevelEnum,
    feedbackNotes: z.string().min(10, 'Feedback must provide at least 10 characters of detail'),
    nextFollowUpDate: z.string().datetime().optional(),
  })
  .refine(
    (data) => new Date(data.completedAt).getTime() <= Date.now() + 60000, // allow 1 min clock skew
    {
      message: 'completedAt cannot be in the future',
      path: ['completedAt'],
    },
  );
export type SiteVisitOutcomeInput = z.infer<typeof SiteVisitOutcomeInputSchema>;

/**
 * Authoritative Server Record: isCompletedWithin24Hours is derived exclusively on the server.
 */
export const SiteVisitOutcomeRecordSchema = SiteVisitOutcomeInputSchema.extend({
  isCompletedWithin24Hours: z.boolean(),
  serverRecordedAt: z.string().datetime(),
});
export type SiteVisitOutcomeRecord = z.infer<typeof SiteVisitOutcomeRecordSchema>;
