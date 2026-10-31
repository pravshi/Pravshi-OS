import { json } from '@/lib/platform/guard';
import { BadRequest, platformRoute, segment } from '@/lib/platform/http';
import { isUuid } from '@/lib/platform/service';
import { reissueAndEmail } from '@/lib/platform/org-admin-setup';

export const dynamic = 'force-dynamic';

/**
 * POST /api/platform/organizations/{orgId}/admin-setup — re-issue the first administrator's
 * setup link: a new 72-hour link replaces the old one (which stops working at once) and is
 * emailed to the recipient the database recorded — email only; the answer never carries it.
 * platform.organizations.assign_initial_admin; step-up; 20 an hour. 409 once setup is complete
 * or the organization is not ACTIVE; 503 EMAIL_NOT_CONFIGURED before anything changes.
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
    return json(200, await reissueAndEmail(ctx, orgId));
  },
);
