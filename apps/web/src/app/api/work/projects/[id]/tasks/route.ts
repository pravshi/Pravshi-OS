import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { listProjectTasks } from '@/lib/work/tasks';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/work/http';

/**
 * /api/work/projects/[id]/tasks — tasks in one project (Phase 4).
 * GET ?search=&limit=&offset=&status=&priority=&assigneePersonId=&sort=&order=
 *      tasks.view → { rows, total, limit, offset }
 *      (projectId is forced from the path; an invisible project 404s)
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const GET = withPermission<{ id: string }>(
  { permission: 'tasks.view' },
  async (request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const url = new URL(request.url);
      const page = await listProjectTasks(authorization, id, {
        search: url.searchParams.get('search') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
        offset: url.searchParams.get('offset') ?? undefined,
        status: url.searchParams.get('status') ?? undefined,
        priority: url.searchParams.get('priority') ?? undefined,
        assigneePersonId: url.searchParams.get('assigneePersonId') ?? undefined,
        sort: url.searchParams.get('sort') ?? undefined,
        order: url.searchParams.get('order') ?? undefined,
      });
      return Response.json(page, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
