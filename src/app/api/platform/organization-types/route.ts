import { json } from '@/lib/platform/guard';
import { platformRoute } from '@/lib/platform/http';
import { listOrganizationTypes } from '@/lib/platform/service';

export const dynamic = 'force-dynamic';

/** GET /api/platform/organization-types — the types an organization may be provisioned with. */
export const GET = platformRoute(
  { operation: 'platform.organization.list', permission: 'platform.organizations.view' },
  async (_req, ctx) => json(200, { types: await listOrganizationTypes(ctx) }),
);
