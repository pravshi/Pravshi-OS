import { z } from 'zod';
import { json } from '@/lib/platform/guard';
import { BadRequest, platformRoute, readJson, segment } from '@/lib/platform/http';
import { isUuid, revokeAdmin } from '@/lib/platform/service';

export const dynamic = 'force-dynamic';

const Reason = z.strictObject({ reason: z.string().trim().min(3).max(500) });

/**
 * POST /api/platform/admins/{adminId}/revoke — body {"reason"}. Revokes the administrator and
 * ends every session of their login in the same transaction. Never yourself; never the last
 * active holder of platform.admins.manage. platform.admins.manage; step-up; 10 an hour.
 */
export const POST = platformRoute(
  {
    operation: 'platform.admin.revoke',
    permission: 'platform.admins.manage',
    stepUp: true,
    rateLimit: { max: 10, windowSeconds: 3600 },
  },
  async (req, ctx) => {
    const adminId = segment(req, 'admins');
    if (!isUuid(adminId)) throw new BadRequest('adminId');
    const parsed = Reason.safeParse(await readJson(req));
    if (!parsed.success) throw new BadRequest('reason');
    await revokeAdmin(ctx, adminId, parsed.data.reason);
    return json(200, { status: 'REVOKED' });
  },
);
