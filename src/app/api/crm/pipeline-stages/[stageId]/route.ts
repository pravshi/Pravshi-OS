import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { updateStage, deleteStage } from '@/lib/crm/pipelines';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/crm/http';

/**
 * /api/crm/pipeline-stages/[stageId] — single pipeline stage (Phase 3).
 * PATCH  pipeline_stages.manage → 200 + the updated stage
 *        (rename / recolor / re-probability / reorder / terminal flags)
 * DELETE pipeline_stages.manage → 400 INVALID_REQUEST: stages are append-only
 *        at runtime (migration 0037 revokes DELETE from the runtime roles and
 *        installs no DELETE policy — there is no privileged delete path for
 *        the service to call). 400 as well when live deals reference the
 *        stage; 404 when the stage is invisible.
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const PATCH = withPermission<{ stageId: string }>(
  { permission: 'pipeline_stages.manage' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const stageId = uuid.parse(params.stageId);
      const stage = await updateStage(authorization, stageId, body);
      return Response.json(stage, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const DELETE = withPermission<{ stageId: string }>(
  { permission: 'pipeline_stages.manage' },
  async (_request, authorization, params) => {
    try {
      const stageId = uuid.parse(params.stageId);
      await deleteStage(authorization, stageId);
      return Response.json({ ok: true }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
