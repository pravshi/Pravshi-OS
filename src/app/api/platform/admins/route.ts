import { z } from 'zod';
import { json } from '@/lib/platform/guard';
import { BadRequest, platformRoute, platformSetupLink, readJson } from '@/lib/platform/http';
import { inviteAdmin, listAdmins } from '@/lib/platform/service';

export const dynamic = 'force-dynamic';

/** GET /api/platform/admins — every platform administrator (platform.admins.manage). */
export const GET = platformRoute(
  { operation: 'platform.admin.list', permission: 'platform.admins.manage' },
  async (_req, ctx) => json(200, { admins: await listAdmins(ctx) }),
);

const PERMISSION_KEYS = [
  'platform.organizations.view',
  'platform.organizations.create',
  'platform.organizations.assign_initial_admin',
  'platform.organizations.suspend',
  'platform.organizations.reactivate',
  'platform.audit.view',
  'platform.admins.manage',
] as const;

const Invite = z.strictObject({
  email: z.string().trim().email().max(254),
  fullName: z.string().trim().min(1).max(200),
  permissions: z.array(z.enum(PERMISSION_KEYS)).max(PERMISSION_KEYS.length),
});

/**
 * POST /api/platform/admins — invite a platform administrator (platform.admins.manage;
 * step-up; 10 an hour). They always receive the two view permissions, plus only those
 * requested — never one the inviter does not hold. The setup link is in the answer, once.
 */
export const POST = platformRoute(
  {
    operation: 'platform.admin.invite',
    permission: 'platform.admins.manage',
    stepUp: true,
    rateLimit: { max: 10, windowSeconds: 3600 },
  },
  async (req, ctx) => {
    const parsed = Invite.safeParse(await readJson(req));
    if (!parsed.success) throw new BadRequest(String(parsed.error.issues[0]?.path[0] ?? ''));
    const r = await inviteAdmin(ctx, parsed.data);
    return json(201, {
      adminId: r.adminId,
      setupLink: platformSetupLink(r.setupToken),
      setupExpiresAt: r.setupExpiresAt,
    });
  },
);
