import { withPermission } from '@/lib/authz/http';
import { listActivities, createActivity } from '@/lib/crm/activities';
import { invalidRequestResponse, noStoreHeaders } from '@/lib/crm/http';

/**
 * /api/crm/activities — collection (Phase 2 Track B).
 * GET  ?search=&limit=&offset=&entityType=&entityId=&type=   activities.view   → { rows, total, limit, offset }
 *      (search matches subject prefix)
 * POST {…activity fields}          activities.create → 201 + the created activity
 */

export const dynamic = 'force-dynamic';

export const GET = withPermission(
  { permission: 'activities.view' },
  async (request, authorization) => {
    try {
      const url = new URL(request.url);
      const page = await listActivities(authorization, {
        search: url.searchParams.get('search') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
        offset: url.searchParams.get('offset') ?? undefined,
        entityType: url.searchParams.get('entityType') ?? undefined,
        entityId: url.searchParams.get('entityId') ?? undefined,
        type: url.searchParams.get('type') ?? undefined,
      });
      return Response.json(page, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const POST = withPermission(
  { permission: 'activities.create' },
  async (request, authorization) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const activity = await createActivity(authorization, body);
      return Response.json(activity, { status: 201, headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
