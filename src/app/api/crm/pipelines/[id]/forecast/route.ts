import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { getForecast } from '@/lib/crm/pipelines';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/crm/http';

/**
 * /api/crm/pipelines/[id]/forecast — per-stage forecast for a pipeline (Phase 3).
 * GET  pipelines.view → { stages: [{ stageId, stageName, position,
 *      probability, dealCount, totalValue, weightedValue, byCurrency }],
 *      totals: {...}, totalsByCurrency: [...] }
 *      Money values are numeric strings; weighted = value × probability / 100.
 *      byCurrency / totalsByCurrency group the sums by deal currency (values
 *      in different currencies are never added together); the top-level
 *      totals stay as the mixed-currency aggregate for backward compatibility.
 *      404 when the pipeline is invisible/deleted.
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const GET = withPermission<{ id: string }>(
  { permission: 'pipelines.view' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const forecast = await getForecast(authorization, id);
      return Response.json(forecast, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
