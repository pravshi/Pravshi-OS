import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { listStages, createStage } from '@/lib/crm/pipelines';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/crm/http';

/**
 * /api/crm/pipelines/[id]/stages — stages of one pipeline (Phase 3).
 * GET  pipelines.view          → the pipeline's stages in position order,
 *                                 or 404 when the pipeline is invisible/deleted
 * POST { name, position?, probability?, color?, isWon?, isLost? }
 *      pipeline_stages.manage  → 201 + the created stage
 *      (position defaults to max+1; a taken explicit position is 400)
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const GET = withPermission<{ id: string }>(
  { permission: 'pipelines.view' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const stages = await listStages(authorization, id);
      return Response.json(stages, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const POST = withPermission<{ id: string }>(
  { permission: 'pipeline_stages.manage' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const id = uuid.parse(params.id);
      const stage = await createStage(authorization, id, body);
      return Response.json(stage, { status: 201, headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
