import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { deleteWorkflow, getWorkflow, updateWorkflow } from '@/lib/workflows/service';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/workflows/http';

/**
 * /api/workflows/[id] — single workflow definition (Phase 5).
 * GET    workflows.view   → the workflow, or 404 when invisible
 * PATCH  workflows.edit   → { name?, description?, trigger?, conditions?, actions? }
 *                             → 200 + the updated workflow (bumps version)
 * DELETE workflows.delete → 200 { ok: true } (soft delete: deleted_at = now())
 *
 * Status changes go through the dedicated activate/pause endpoints; the per-record
 * workflow target probes the row under the caller's RLS (step 5).
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

const viewSpec = {
  permission: 'workflows.view',
  target: (params: { id: string }) => ({ entity: 'workflow', id: params.id }) as const,
};
const editSpec = {
  permission: 'workflows.edit',
  target: (params: { id: string }) => ({ entity: 'workflow', id: params.id }) as const,
};
const deleteSpec = {
  permission: 'workflows.delete',
  target: (params: { id: string }) => ({ entity: 'workflow', id: params.id }) as const,
};

export const GET = withPermission<{ id: string }>(
  viewSpec,
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const workflow = await getWorkflow(authorization, id);
      return Response.json(workflow, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const PATCH = withPermission<{ id: string }>(
  editSpec,
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const id = uuid.parse(params.id);
      const workflow = await updateWorkflow(authorization, id, body);
      return Response.json(workflow, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const DELETE = withPermission<{ id: string }>(
  deleteSpec,
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      await deleteWorkflow(authorization, id);
      return Response.json({ ok: true }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
