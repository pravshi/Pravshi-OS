import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { activateWorkflow } from '@/lib/workflows/service';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/workflows/http';

/**
 * POST /api/workflows/[id]/activate — activate a workflow (Phase 5).
 * workflows.activate → 200 + the ACTIVE workflow.
 *
 * Only DRAFT → ACTIVE and PAUSED → ACTIVE are legal; anything else is 400
 * INVALID_REQUEST. Activating a workflow whose trigger.type has no Phase-5
 * runtime (scheduled / webhook / task.overdue) is rejected with
 * INVALID_REQUEST "trigger type not yet supported".
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
      const workflow = await activateWorkflow(authorization, id);
      return Response.json(workflow, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
