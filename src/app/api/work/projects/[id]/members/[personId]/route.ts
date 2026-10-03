import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { removeProjectMember } from '@/lib/work/projects';
import { invalidRequestResponse, noStoreHeaders } from '@/lib/work/http';

/**
 * /api/work/projects/[id]/members/[personId] — remove a project member (Phase 4).
 * DELETE projects.manage_members → 200 { ok: true } (manager only)
 *        404 when the project is invisible or the person is not a member.
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const DELETE = withPermission<{ id: string; personId: string }>(
  { permission: 'projects.manage_members' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const personId = uuid.parse(params.personId);
      await removeProjectMember(authorization, id, personId);
      return Response.json({ ok: true }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
