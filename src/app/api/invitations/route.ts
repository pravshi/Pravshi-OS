import { env } from '@/env';
import { withPermission } from '@/lib/authz/http';
import { createInvitation, InvitationError } from '@/lib/invitations/service';
import { CreateInvitationSchema, type CreateInvitationInput } from '@/lib/invitations/schema';
import { buildInviteUrl } from '@/lib/invitations/tokens';
import { sendInvitationEmail } from '@/lib/invitations/email';

export const dynamic = 'force-dynamic';

/**
 * POST /api/invitations — issue an invitation. users.create, the same key that governs
 * creating a user account, because that is what this is.
 *
 * The invitation row is the source of truth; the email is best-effort. The response
 * always carries the accept URL (and the token, to the authorizing admin's own session)
 * so a failed or unconfigured email never strands an invitation.
 */
export const POST = withPermission(
  // GLOBAL, matching the database: the invitations RLS policies require
  // scope_for('users.create') = 'GLOBAL', so the denial happens here cleanly
  // instead of as a database error later.
  { permission: 'users.create', minScope: 'GLOBAL' },
  async (request, authorization) => {
    let input: CreateInvitationInput;
    try {
      input = CreateInvitationSchema.parse(await request.json());
    } catch {
      return Response.json(
        { error: 'INVALID_REQUEST', message: 'The invitation details are invalid.' },
        { status: 400 },
      );
    }

    try {
      const invitation = await createInvitation(authorization, input);
      const acceptUrl = buildInviteUrl(env.APP_URL, invitation.token);

      const emailSent = await sendInvitationEmail({
        to: invitation.email,
        orgName: invitation.orgName,
        inviterName: invitation.inviterName,
        acceptUrl,
        expiresAt: invitation.expiresAt,
      });

      return Response.json(
        {
          status: 'CREATED',
          invitation: {
            id: invitation.id,
            code: invitation.code,
            email: invitation.email,
            expiresAt: invitation.expiresAt.toISOString(),
          },
          acceptUrl,
          token: invitation.token,
          emailSent,
        },
        { status: 201, headers: { 'Cache-Control': 'no-store' } },
      );
    } catch (e) {
      if (e instanceof InvitationError) {
        const status =
          e.code === 'INVITATION_ALREADY_LIVE' || e.code === 'EMAIL_HAS_LOGIN' ? 409 : 400;
        return Response.json(
          { error: e.code, message: e.message },
          { status, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      throw e;
    }
  },
);
