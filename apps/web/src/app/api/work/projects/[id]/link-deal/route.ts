import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { getProjectDeal, linkProjectToDeal, unlinkProjectFromDeal } from '@/lib/work/projects';
import {
  invalidRequestResponse,
  serviceInvalidRequestResponse,
  noStoreHeaders,
} from '@/lib/work/http';

/**
 * /api/work/projects/[id]/link-deal — the Deal → Project seam.
 * GET    projects.view → 200 + { deal } (the linked deal summary, or null)
 * POST   projects.edit → { dealId } → 200 + { deal } (the linked deal summary)
 *        400 when: the body is malformed, the deal is unknown / in another
 *        org / soft-deleted, or the deal is already linked to another project
 *        (the one-deal-one-project rule). The invisible project itself is 404.
 * DELETE projects.edit → 200 { ok: true } (idempotent: already-unlinked is
 *        still 200; the invisible project is 404)
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const GET = withPermission<{ id: string }>(
  { permission: 'projects.view' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const deal = await getProjectDeal(authorization, id);
      return Response.json({ deal }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const POST = withPermission<{ id: string }>(
  { permission: 'projects.edit' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const id = uuid.parse(params.id);
      const deal = await linkProjectToDeal(authorization, id, body);
      return Response.json({ deal }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const DELETE = withPermission<{ id: string }>(
  { permission: 'projects.edit' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      await unlinkProjectFromDeal(authorization, id);
      return Response.json({ ok: true }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
