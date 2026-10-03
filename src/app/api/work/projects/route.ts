import { withPermission } from '@/lib/authz/http';
import { listProjects, createProject } from '@/lib/work/projects';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/work/http';

/**
 * /api/work/projects — collection (Phase 4).
 * GET  ?search=&limit=&offset=&includeArchived=&sort=&order=
 *                                projects.view  → { rows, total, limit, offset }
 *      (search matches name prefix; sort ∈ name|createdAt|updatedAt)
 * POST { name, description? }    projects.create → 201 + the project
 */

export const dynamic = 'force-dynamic';

export const GET = withPermission(
  { permission: 'projects.view' },
  async (request, authorization) => {
    try {
      const url = new URL(request.url);
      const page = await listProjects(authorization, {
        search: url.searchParams.get('search') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
        offset: url.searchParams.get('offset') ?? undefined,
        includeArchived: url.searchParams.get('includeArchived') ?? undefined,
        sort: url.searchParams.get('sort') ?? undefined,
        order: url.searchParams.get('order') ?? undefined,
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
  { permission: 'projects.create' },
  async (request, authorization) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const project = await createProject(authorization, body);
      return Response.json(project, { status: 201, headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
