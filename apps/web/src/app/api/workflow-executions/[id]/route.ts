import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { getExecution } from '@/lib/workflows/service';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/workflows/http';

/**
 * GET /api/workflow-executions/[id] — one execution with its steps (Phase 5).
 * workflows.view → the execution + steps[] in step_index order, or 404 when
 * invisible. No per-record target: the service probes visibility through the
 * executions table's own RLS (org + workflows.view) and raises NOT_FOUND.
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const GET = withPermission<{ id: string }>(
  { permission: 'workflows.view' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const execution = await getExecution(authorization, id);
      return Response.json(execution, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
