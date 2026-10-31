import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { getPipeline, updatePipeline, deletePipeline } from '@/lib/crm/pipelines';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/crm/http';

/**
 * /api/crm/pipelines/[id] — single pipeline (Phase 3).
 * GET    pipelines.view   → the pipeline with its stages in position order,
 *                           or 404 when invisible/deleted
 * PATCH  pipelines.edit   → 200 + the pipeline with its stages
 *        (promoting a second live default is 400 INVALID_REQUEST)
 * DELETE pipelines.delete → 200 { ok: true } (soft delete; 400 when live
 *        deals reference the pipeline)
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const GET = withPermission<{ id: string }>(
  { permission: 'pipelines.view' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const pipeline = await getPipeline(authorization, id);
      return Response.json(pipeline, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const PATCH = withPermission<{ id: string }>(
  { permission: 'pipelines.edit' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const id = uuid.parse(params.id);
      const pipeline = await updatePipeline(authorization, id, body);
      return Response.json(pipeline, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const DELETE = withPermission<{ id: string }>(
  { permission: 'pipelines.delete' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      await deletePipeline(authorization, id);
      return Response.json({ ok: true }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
