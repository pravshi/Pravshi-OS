import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { getDeal, updateDeal, deleteDeal } from '@/lib/crm/deals';
import { invalidRequestResponse, noStoreHeaders } from '@/lib/crm/http';

/**
 * /api/crm/deals/[id] — single deal.
 * GET    deals.view → the deal, or 404 when invisible/deleted
 * PATCH  deals.edit → 200 + the updated deal
 *        (a stage change also maintains closed_at: entering WON/LOST stamps it,
 *         leaving for an open stage clears it)
 * DELETE deals.edit → 200 { ok: true } (soft delete: deleted_at = now())
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const GET = withPermission<{ id: string }>(
  { permission: 'deals.view' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const deal = await getDeal(authorization, id);
      return Response.json(deal, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const PATCH = withPermission<{ id: string }>(
  { permission: 'deals.edit' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const id = uuid.parse(params.id);
      const deal = await updateDeal(authorization, id, body);
      return Response.json(deal, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const DELETE = withPermission<{ id: string }>(
  { permission: 'deals.edit' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      await deleteDeal(authorization, id);
      return Response.json({ ok: true }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
