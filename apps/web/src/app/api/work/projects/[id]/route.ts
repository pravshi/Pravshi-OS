import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { archiveProject, getProject, unarchiveProject, updateProject } from '@/lib/work/projects';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/work/http';

/**
 * /api/work/projects/[id] — single project (Phase 4).
 * GET    projects.view   → the project, or 404 when invisible
 * PATCH  projects.edit   → { name?, description?, isArchived? } → 200 + the project
 * DELETE projects.delete → 200 + the archived project (archive, not hard delete:
 *        there is no project hard-delete path)
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

/**
 * PATCH body per the Phase 4 API contract. Field constraints mirror
 * UpdateProjectSchema; isArchived is routed to the archive/unarchive path
 * because the service schema does not carry it.
 */
const patchBodySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(255).optional(),
    description: z
      .string()
      .trim()
      .max(2000)
      .transform((s) => (s.length === 0 ? null : s))
      .nullable()
      .optional(),
    isArchived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');

export const GET = withPermission<{ id: string }>(
  { permission: 'projects.view' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const project = await getProject(authorization, id);
      return Response.json(project, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const PATCH = withPermission<{ id: string }>(
  { permission: 'projects.edit' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const id = uuid.parse(params.id);
      const data = patchBodySchema.parse(body);
      const { isArchived, ...fields } = data;
      if (Object.keys(fields).length > 0) {
        await updateProject(authorization, id, fields);
      }
      if (isArchived !== undefined) {
        if (isArchived) {
          await archiveProject(authorization, id);
        } else {
          await unarchiveProject(authorization, id);
        }
      }
      const project = await getProject(authorization, id);
      return Response.json(project, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const DELETE = withPermission<{ id: string }>(
  { permission: 'projects.delete' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const project = await archiveProject(authorization, id);
      return Response.json(project, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
