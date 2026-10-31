import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { listExecutions } from '@/lib/workflows/service';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/workflows/http';

/**
 * GET /api/workflows/[id]/executions — run history for one workflow (Phase 5).
 * workflows.view → ?limit=&offset= → { rows, total, limit, offset },
 * newest runs first. An invisible workflow is concealed as 404.
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const GET = withPermission<{ id: string }>(
  {
    permission: 'workflows.view',
    target: (params) => ({ entity: 'workflow', id: params.id }) as const,
  },
  async (request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const url = new URL(request.url);
      const page = await listExecutions(authorization, id, {
        limit: url.searchParams.get('limit') ?? undefined,
        offset: url.searchParams.get('offset') ?? undefined,
      });
      return Response.json(page, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
