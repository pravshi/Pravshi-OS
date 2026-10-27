import { json } from '@/lib/platform/guard';
import { BadRequest, platformRoute, platformSetupLink, segment } from '@/lib/platform/http';
import { isUuid, reissueAdminSetup } from '@/lib/platform/service';

export const dynamic = 'force-dynamic';

/**
 * POST /api/platform/admins/{adminId}/setup — a new 72-hour setup link for an invited
 * administrator who never used theirs; the old link stops working, the recipient is the
 * invitation's. platform.admins.manage; step-up; 10 an hour. The link is in the answer, once.
 * An administrator who already has a login is recovered by the operator (break glass).
 */
export const POST = platformRoute(
  {
    operation: 'platform.admin.setup_reissue',
    permission: 'platform.admins.manage',
    stepUp: true,
    rateLimit: { max: 10, windowSeconds: 3600 },
  },
  async (req, ctx) => {
    const adminId = segment(req, 'admins');
    if (!isUuid(adminId)) throw new BadRequest('adminId');
    const r = await reissueAdminSetup(ctx, adminId);
    return json(200, {
      setupLink: platformSetupLink(r.setupToken),
      setupExpiresAt: r.setupExpiresAt,
    });
  },
);
