import { z } from 'zod';
import { INVITATION_TOKEN_PATTERN } from './tokens';

/**
 * Invitation input schemas, shared with the client. Everything untrusted is validated
 * here, at the boundary, before the service sees it.
 */

const email = z.string().trim().email().max(254);
const uuid = z.string().uuid();

/** Engagement types the invitee can be engaged as. Mirrors public.engagement_type. */
export const ENGAGEMENT_TYPES = [
  'EMPLOYEE',
  'INTERN',
  'TRAINEE',
  'CONTRACTOR',
  'CONSULTANT',
  'PART_TIME',
  'TEMPORARY',
] as const;

export const CreateInvitationSchema = z.strictObject({
  email,
  /** Roles the accepted invitation confers. At least one — a login with no roles is a dead end. */
  roleIds: z.array(uuid).min(1).max(20),
  /** Optional link to an existing person (a candidate being hired). */
  personId: uuid.optional(),
  /** Days until expiry. Bounded: an invitation is not a standing offer. */
  expiresInDays: z.number().int().min(1).max(30).default(7),
  /**
   * The engagement the acceptance creates. Required when the invitee has no live
   * engagement (always the case for a brand-new person): without it the new login
   * would authenticate but see no business data, because authz.is_active() needs
   * an engagement. Ignored when the linked person already holds one.
   */
  engagementType: z.enum(ENGAGEMENT_TYPES).optional(),
  departmentId: uuid.optional(),
  /** First day of the engagement. Defaults to the acceptance day. */
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD').optional(),
});

export type CreateInvitationInput = z.infer<typeof CreateInvitationSchema>;

export const AcceptInvitationSchema = z.strictObject({
  token: z.string().regex(INVITATION_TOKEN_PATTERN),
  fullName: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(256),
});

export type AcceptInvitationInput = z.infer<typeof AcceptInvitationSchema>;

export const RevokeInvitationSchema = z.strictObject({
  id: uuid,
});
