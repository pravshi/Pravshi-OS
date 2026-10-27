import { z } from 'zod';
import { json } from '@/lib/platform/guard';
import { BadRequest, orgAdminSetupLink, platformRoute, readJson } from '@/lib/platform/http';
import { listOrganizations, provisionOrganization } from '@/lib/platform/service';

export const dynamic = 'force-dynamic';

/** GET /api/platform/organizations — organization metadata only (platform.organizations.view). */
export const GET = platformRoute(
  { operation: 'platform.organization.list', permission: 'platform.organizations.view' },
  async (_req, ctx) => json(200, { organizations: await listOrganizations(ctx) }),
);

const Provision = z.strictObject({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  name: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .max(63)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
  timezone: z.string().min(1).max(64),
  typeKey: z.string().min(1).max(64),
  adminFullName: z.string().trim().min(1).max(200),
  adminEmail: z.string().trim().email().max(254),
});

/**
 * POST /api/platform/organizations — provision an organization and its first administrator
 * (platform.organizations.create; step-up; 20 an hour). Idempotent by idempotencyKey: a retry
 * of a completed request answers 200 {replayed: true} and does not show the setup link again
 * (re-issue it instead). The first administrator's setup link is in the 201 answer, once.
 */
export const POST = platformRoute(
  {
    operation: 'platform.organization.provision',
    permission: 'platform.organizations.create',
    stepUp: true,
    rateLimit: { max: 20, windowSeconds: 3600 },
  },
  async (req, ctx) => {
    const parsed = Provision.safeParse(await readJson(req));
    if (!parsed.success) throw new BadRequest(String(parsed.error.issues[0]?.path[0] ?? ''));
    const result = await provisionOrganization(ctx, parsed.data);
    if (result.replayed) return json(200, { replayed: true, orgId: result.orgId });
    return json(201, {
      replayed: false,
      orgId: result.orgId,
      setupLink: orgAdminSetupLink(result.setupToken),
      setupExpiresAt: result.setupExpiresAt,
    });
  },
);
