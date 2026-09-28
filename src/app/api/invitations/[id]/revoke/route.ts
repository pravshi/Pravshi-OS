import { withPermission } from '@/lib/authz/http';
import { revokeInvitation, InvitationError } from '@/lib/invitations/service';
import { RevokeInvitationSchema } from '@/lib/invitations/schema';
import { clientIp } from '@/lib/auth/login-events';
import { checkIpRateLimit, ipRateLimitKey } from '@/lib/auth/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * POST /api/invitations/[id]/revoke — revoke an unaccepted invitation. users.create.
 * Idempotent: revoking twice succeeds. Revoking an accepted invitation fails — that
 * login exists now, and ending it is users.suspend.
 *
 * Rate limited to 30 a minute per IP, like the other mutating invitation routes.
 */
export const POST = withPermission(
  // GLOBAL, matching the database: revoke_invitation runs as the inviter's
  // organization and the invitations policies require users.create at GLOBAL.
  { permission: 'users.create', minScope: 'GLOBAL' },
  async (request, authorization, params) => {
    if (!(await checkIpRateLimit(ipRateLimitKey('invite:revoke', clientIp(request)), 30, 60))) {
      return Response.json({ error: 'RATE_LIMITED' }, { status: 429 });
    }

    const parsed = RevokeInvitationSchema.safeParse({ id: params.id });
    if (!parsed.success) {
      return Response.json(
        { error: 'INVALID_REQUEST', message: 'The invitation id is invalid.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    try {
      await revokeInvitation(authorization, parsed.data.id);
      return Response.json({ status: 'REVOKED' }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (e) {
      if (e instanceof InvitationError) {
        const status = e.code === 'INVITATION_NOT_FOUND' ? 404 : 400;
        return Response.json(
          { error: e.code, message: e.message },
          { status, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      throw e;
    }
  },
);
