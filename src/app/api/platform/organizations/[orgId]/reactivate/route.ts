import { json } from '@/lib/platform/guard';
import { platformRoute } from '@/lib/platform/http';
import { changeStatus } from '../status';

export const dynamic = 'force-dynamic';

/**
 * POST /api/platform/organizations/{orgId}/reactivate — body {"reason"} (3-500 characters).
 * platform.organizations.reactivate; step-up; 30 an hour.
 */
export const POST = platformRoute(
  {
    operation: 'platform.organization.reactivate',
    permission: 'platform.organizations.reactivate',
    stepUp: true,
    rateLimit: { max: 30, windowSeconds: 3600 },
  },
  async (req, ctx) => json(200, { status: await changeStatus(req, ctx, 'ACTIVE') }),
);
