import { withPermission } from '@/lib/authz/http';
import { listMyTasks } from '@/lib/work/tasks';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/work/http';

/**
 * /api/work/tasks/mine — tasks assigned to the caller (Phase 4).
 * GET ?search=&limit=&offset=&projectId=&status=&priority=&sort=&order=
 *     tasks.view → { rows, total, limit, offset }
 *     (assignee is forced to the caller's person id)
 */

export const dynamic = 'force-dynamic';

export const GET = withPermission({ permission: 'tasks.view' }, async (request, authorization) => {
  try {
    const url = new URL(request.url);
    const page = await listMyTasks(authorization, {
      search: url.searchParams.get('search') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      offset: url.searchParams.get('offset') ?? undefined,
      projectId: url.searchParams.get('projectId') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      priority: url.searchParams.get('priority') ?? undefined,
      sort: url.searchParams.get('sort') ?? undefined,
      order: url.searchParams.get('order') ?? undefined,
    });
    return Response.json(page, { headers: noStoreHeaders });
  } catch (error) {
    const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
    if (invalid) return invalid;
    throw error;
  }
});
