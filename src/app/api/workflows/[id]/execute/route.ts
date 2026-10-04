import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { executeWorkflow } from '@/lib/workflows/service';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/workflows/http';

/**
 * POST /api/workflows/[id]/execute — manual execution (Phase 5).
 * workflows.execute → 202 { executionId, status }.
 *
 * Body { input? } is optional and opaque — it becomes the manual event's
 * payload. The executing user is the trigger actor (D2): only ACTIVE
 * workflows execute (DRAFT/PAUSED/ARCHIVED → 400 INVALID_REQUEST), and the run
 * can do no more than that user could do directly.
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const POST = withPermission<{ id: string }>(
  {
    permission: 'workflows.execute',
    target: (params) => ({ entity: 'workflow', id: params.id }) as const,
  },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const id = uuid.parse(params.id);
      const result = await executeWorkflow(authorization, id, body);
      return Response.json(result, { status: 202, headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
