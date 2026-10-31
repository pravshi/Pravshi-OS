import { z } from 'zod';
import { json } from '@/lib/platform/guard';
import { BadRequest, platformRoute, readJson } from '@/lib/platform/http';
import { listOrganizations } from '@/lib/platform/service';
import { provisionAndEmail } from '@/lib/platform/org-admin-setup';

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
 * of a completed request answers 200 {replayed: true} and sends nothing (re-issue instead). The
 * first administrator's setup link is emailed to them (email only); the 201 answer says whether
 * the email was accepted, to whom, and when the link expires — never the link. Without email
 * delivery configured: 503 EMAIL_NOT_CONFIGURED before anything is created.
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
    const result = await provisionAndEmail(ctx, parsed.data);
    if (result.replayed) return json(200, { replayed: true, orgId: result.orgId });
    // The setup link went to the first administrator by email only; it is never in an answer.
    return json(201, result);
  },
);
