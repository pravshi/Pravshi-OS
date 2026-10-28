import { z } from 'zod';
import { json } from '@/lib/platform/guard';
import { BadRequest, platformRoute, readJson, segment } from '@/lib/platform/http';
import { isUuid } from '@/lib/platform/service';
import { revokeOrgAdminSetup } from '@/lib/platform/org-admin-setup';

export const dynamic = 'force-dynamic';

const Reason = z.strictObject({ reason: z.string().trim().min(3).max(500) });

/**
 * POST /api/platform/organizations/{orgId}/admin-setup/revoke — body {"reason"}. Ends the
 * pending first-administrator link without issuing another (0087); re-issue afterwards sends a
 * new one. platform.organizations.assign_initial_admin; step-up; 20 an hour; audited.
 */
export const POST = platformRoute(
  {
    operation: 'platform.organization.admin_setup_revoke',
    permission: 'platform.organizations.assign_initial_admin',
    stepUp: true,
    rateLimit: { max: 20, windowSeconds: 3600 },
  },
  async (req, ctx) => {
    const orgId = segment(req, 'organizations');
    if (!isUuid(orgId)) throw new BadRequest('orgId');
    const parsed = Reason.safeParse(await readJson(req));
    if (!parsed.success) throw new BadRequest('reason');
    return json(200, await revokeOrgAdminSetup(ctx, orgId, parsed.data.reason));
  },
);
