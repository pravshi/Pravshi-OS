import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { getVelocity } from '@/lib/crm/pipelines';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/crm/http';

/**
 * /api/crm/pipelines/[id]/velocity — per-stage velocity for a pipeline (Phase 3).
 * GET  pipelines.view → { stages: [{ stageId, stageName, position, avgDays,
 *      sampleCount, entriesCount, exitsCount, convertedFromPrevious }] }
 *      avgDays is the mean completed stay in the stage, in days, or null
 *      where no deal has completed a stay. 404 when invisible/deleted.
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const GET = withPermission<{ id: string }>(
  { permission: 'pipelines.view' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const velocity = await getVelocity(authorization, id);
      return Response.json(velocity, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
