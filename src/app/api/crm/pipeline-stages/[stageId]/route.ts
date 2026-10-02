import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { updateStage } from '@/lib/crm/pipelines';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/crm/http';

/**
 * /api/crm/pipeline-stages/[stageId] — single pipeline stage (Phase 3).
 * PATCH  pipeline_stages.manage → 200 + the updated stage
 *        (rename / recolor / re-probability / reorder / terminal flags)
 *
 * No DELETE: stages are append-only by design (migration 0037 installs no
 * DELETE policy). The route is intentionally absent — not a 400, not a 405.
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
