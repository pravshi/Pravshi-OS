import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { getActivity, updateActivity, deleteActivity } from '@/lib/crm/activities';
import { invalidRequestResponse, noStoreHeaders } from '@/lib/crm/http';

/**
 * /api/crm/activities/[id] — single activity (Phase 2 Track B).
 * GET    activities.view → the activity, or 404 when invisible/deleted
 * PATCH  activities.edit → 200 + the updated activity
 *        (the (entityType, entityId) link is immutable — not updatable)
 * DELETE activities.delete → 200 { ok: true } (soft delete: deleted_at = now())
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const GET = withPermission<{ id: string }>(
  { permission: 'activities.view' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const activity = await getActivity(authorization, id);
      return Response.json(activity, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const PATCH = withPermission<{ id: string }>(
  { permission: 'activities.edit' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const id = uuid.parse(params.id);
      const activity = await updateActivity(authorization, id, body);
      return Response.json(activity, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const DELETE = withPermission<{ id: string }>(
  { permission: 'activities.delete' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      await deleteActivity(authorization, id);
      return Response.json({ ok: true }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
