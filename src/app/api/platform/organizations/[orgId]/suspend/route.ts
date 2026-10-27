import { json } from '@/lib/platform/guard';
import { platformRoute } from '@/lib/platform/http';
import { changeStatus } from '../status';

export const dynamic = 'force-dynamic';

/**
 * POST /api/platform/organizations/{orgId}/suspend — body {"reason"} (3-500 characters).
 * platform.organizations.suspend; step-up; 30 an hour. Suspending an already suspended
 * organization answers {status: "UNCHANGED"} and writes no second audit entry.
 */
export const POST = platformRoute(
  {
    operation: 'platform.organization.suspend',
    permission: 'platform.organizations.suspend',
    stepUp: true,
    rateLimit: { max: 30, windowSeconds: 3600 },
  },
  async (req, ctx) => json(200, { status: await changeStatus(req, ctx, 'SUSPENDED') }),
);
