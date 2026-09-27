import { z } from 'zod';
import { INVITATION_TOKEN_PATTERN } from './tokens';

/**
 * Invitation input schemas, shared with the client. Everything untrusted is validated
 * here, at the boundary, before the service sees it.
 */

const email = z.string().trim().email().max(254);
const uuid = z.string().uuid();

export const CreateInvitationSchema = z.strictObject({
  email,
  /** Roles the accepted invitation confers. At least one — a login with no roles is a dead end. */
  roleIds: z.array(uuid).min(1).max(20),
  /** Optional link to an existing person (a candidate being hired). */
  personId: uuid.optional(),
  /** Days until expiry. Bounded: an invitation is not a standing offer. */
  expiresInDays: z.number().int().min(1).max(30).default(7),
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
