import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { listProjectMembers, addProjectMember } from '@/lib/work/projects';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/work/http';

/**
 * /api/work/projects/[id]/members — project membership (Phase 4).
 * GET  projects.view           → the member list (an invisible project 404s)
 * POST { personId, roleInProject? }
 *      projects.manage_members → 201 + the member list (manager only)
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const GET = withPermission<{ id: string }>(
  { permission: 'projects.view' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const members = await listProjectMembers(authorization, id);
      return Response.json(members, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const POST = withPermission<{ id: string }>(
  { permission: 'projects.manage_members' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const id = uuid.parse(params.id);
      const members = await addProjectMember(authorization, id, body);
      return Response.json(members, { status: 201, headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
