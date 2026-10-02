import { withPermission } from '@/lib/authz/http';
import { listPipelines, createPipeline } from '@/lib/crm/pipelines';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/crm/http';

/**
 * /api/crm/pipelines — collection (Phase 3).
 * GET  ?search=&limit=&offset=   pipelines.view    → { rows, total, limit, offset }
 *      (search matches name prefix; each row carries stageCount)
 * POST { name, description?, isDefault? }
 *                                pipelines.create  → 201 + the pipeline with its stages
 */

export const dynamic = 'force-dynamic';

export const GET = withPermission(
  { permission: 'pipelines.view' },
  async (request, authorization) => {
    try {
      const url = new URL(request.url);
      const page = await listPipelines(authorization, {
        search: url.searchParams.get('search') ?? undefined,
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
  { permission: 'pipelines.create' },
  async (request, authorization) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const pipeline = await createPipeline(authorization, body);
      return Response.json(pipeline, { status: 201, headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
