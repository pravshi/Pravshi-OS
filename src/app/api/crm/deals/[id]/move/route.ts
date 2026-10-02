import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { moveDealToStage } from '@/lib/crm/pipelines';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/crm/http';

/**
 * /api/crm/deals/[id]/move — move a deal to another stage of its own pipeline
 * (Phase 3).
 * POST { stageId }  deals.edit → 200 { ok, dealId, fromStageId, toStageId }
 *
 * The target stage must belong to the deal's pipeline; anything else is 400
 * INVALID_REQUEST (never a silent cross-pipeline move). Moving to the stage
 * the deal is already in is a no-op that still answers 200. An invisible deal
 * is concealed as 404. Callers without pipelines.view never see stage rows —
 * the response carries ids only.
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const POST = withPermission<{ id: string }>(
  { permission: 'deals.edit' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const id = uuid.parse(params.id);
      const result = await moveDealToStage(authorization, id, body);
      return Response.json(result, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
