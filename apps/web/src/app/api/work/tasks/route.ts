import { withPermission } from '@/lib/authz/http';
import { listTasks, createTask } from '@/lib/work/tasks';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/work/http';

/**
 * /api/work/tasks — collection (Phase 4).
 * GET  ?search=&limit=&offset=&projectId=&status=&priority=&assigneePersonId=
 *      &sort=&order=         tasks.view   → { rows, total, limit, offset }
 *      (search matches title prefix; every filter is validated; sort is an
 *       allowlist — sort ∈ title|status|priority|dueDate|createdAt|updatedAt)
 * POST { title, projectId?, description?, status?, priority?, dueDate?,
 *        assigneePersonId? } tasks.create → 201 + the task
 */

export const dynamic = 'force-dynamic';

export const GET = withPermission({ permission: 'tasks.view' }, async (request, authorization) => {
  try {
    const url = new URL(request.url);
    const page = await listTasks(authorization, {
      search: url.searchParams.get('search') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      offset: url.searchParams.get('offset') ?? undefined,
      projectId: url.searchParams.get('projectId') ?? undefined,
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
});

export const POST = withPermission(
  { permission: 'tasks.create' },
  async (request, authorization) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const task = await createTask(authorization, body);
      return Response.json(task, { status: 201, headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
