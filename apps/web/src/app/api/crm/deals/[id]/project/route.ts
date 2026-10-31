import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { getProjectLinkedToDeal } from '@/lib/work/projects';
import { invalidRequestResponse, noStoreHeaders } from '@/lib/crm/http';

/**
 * /api/crm/deals/[id]/project — the CRM side of the Deal → Project seam.
 * GET → 200 + { project } where project is the linked project summary, or
 *       null when no project is linked. A foreign/unknown deal also yields
 *       null (the join is org-scoped), so nothing is disclosed about it.
 *
 * Permission choice: 'projects.view', not 'deals.view' — the payload is a
 * project, so the project permission governs who may see it. The deal detail
 * page already requires deals.view separately; the UI section must gate on
 * BOTH (deals.view for the page, projects.view for the section).
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const GET = withPermission<{ id: string }>(
  { permission: 'projects.view' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const project = await getProjectLinkedToDeal(authorization, id);
      return Response.json({ project }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
