import { json } from '@/lib/platform/guard';
import { BadRequest, orgAdminSetupLink, platformRoute, segment } from '@/lib/platform/http';
import { isUuid, reissueOrgAdminSetup } from '@/lib/platform/service';

export const dynamic = 'force-dynamic';

/**
 * POST /api/platform/organizations/{orgId}/admin-setup — re-issue the first administrator's
 * setup link: a new 72-hour token replaces the old one, which stops working at once.
 * platform.organizations.assign_initial_admin; step-up; 20 an hour. The link is in the answer,
 * once. Refused (409) once the administrator has completed setup or the organization is not
 * ACTIVE.
 */
export const POST = platformRoute(
  {
    operation: 'platform.organization.admin_setup_reissue',
    permission: 'platform.organizations.assign_initial_admin',
    stepUp: true,
    rateLimit: { max: 20, windowSeconds: 3600 },
  },
  async (req, ctx) => {
    const orgId = segment(req, 'organizations');
    if (!isUuid(orgId)) throw new BadRequest('orgId');
    const r = await reissueOrgAdminSetup(ctx, orgId);
    return json(200, {
      setupLink: orgAdminSetupLink(r.setupToken),
      setupExpiresAt: r.setupExpiresAt,
    });
  },
);
