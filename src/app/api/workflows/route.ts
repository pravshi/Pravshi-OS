import { withPermission } from '@/lib/authz/http';
import { createWorkflow, listWorkflows } from '@/lib/workflows/service';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/workflows/http';

/**
 * /api/workflows — collection (Phase 5).
 * GET  ?search=&status=&limit=&offset=  workflows.view   → { rows, total, limit, offset }
 *      (status ∈ DRAFT|ACTIVE|PAUSED|ARCHIVED; search matches name prefix)
 * POST { name, description?, trigger, conditions?, actions }  workflows.create → 201 + the workflow
 */

export const dynamic = 'force-dynamic';

export const GET = withPermission(
  { permission: 'workflows.view' },
  async (request, authorization) => {
    try {
      const url = new URL(request.url);
      const page = await listWorkflows(authorization, {
        search: url.searchParams.get('search') ?? undefined,
        status: url.searchParams.get('status') ?? undefined,
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

export const POST = withPermission(
  { permission: 'workflows.create' },
  async (request, authorization) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const workflow = await createWorkflow(authorization, body);
      return Response.json(workflow, { status: 201, headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
