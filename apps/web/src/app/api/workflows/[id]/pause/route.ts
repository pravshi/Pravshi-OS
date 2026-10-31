import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { pauseWorkflow } from '@/lib/workflows/service';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/workflows/http';

/**
 * POST /api/workflows/[id]/pause — pause a workflow (Phase 5).
 * workflows.activate → 200 + the PAUSED workflow.
 *
 * Only ACTIVE → PAUSED is legal; pausing a DRAFT/PAUSED/ARCHIVED workflow is
 * 400 INVALID_REQUEST.
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const POST = withPermission<{ id: string }>(
  {
    permission: 'workflows.activate',
    target: (params) => ({ entity: 'workflow', id: params.id }) as const,
  },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const workflow = await pauseWorkflow(authorization, id);
      return Response.json(workflow, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
