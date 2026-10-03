import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { moveTask } from '@/lib/work/tasks';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/work/http';

/**
 * /api/work/tasks/[id]/move — kanban status move (Phase 4).
 * POST { status }  tasks.edit → 200 { ok, taskId, fromStatus, toStatus }
 *
 * Changes ONLY status (todo/in_progress/done). project_id is not accepted —
 * cross-project moves are forbidden here; use PATCH with projectId instead.
 * Moving to the status the task is already in is a no-op that still answers
 * 200. An invisible task is concealed as 404.
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const POST = withPermission<{ id: string }>(
  { permission: 'tasks.edit' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const id = uuid.parse(params.id);
      const result = await moveTask(authorization, id, body);
      return Response.json(result, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
