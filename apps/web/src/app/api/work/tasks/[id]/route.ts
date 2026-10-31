import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { deleteTask, getTask, updateTask } from '@/lib/work/tasks';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/work/http';

/**
 * /api/work/tasks/[id] — single task (Phase 4).
 * GET    tasks.view   → the task, or 404 when invisible
 * PATCH  tasks.edit   → { title?, description?, status?, priority?, dueDate?,
 *                        assigneePersonId?, projectId? } → 200 + the updated task
 * DELETE tasks.delete → 200 { ok: true } (soft delete: deleted_at = now())
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const GET = withPermission<{ id: string }>(
  { permission: 'tasks.view' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const task = await getTask(authorization, id);
      return Response.json(task, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const PATCH = withPermission<{ id: string }>(
  { permission: 'tasks.edit' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const id = uuid.parse(params.id);
      const task = await updateTask(authorization, id, body);
      return Response.json(task, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const DELETE = withPermission<{ id: string }>(
  { permission: 'tasks.delete' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      await deleteTask(authorization, id);
      return Response.json({ ok: true }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
