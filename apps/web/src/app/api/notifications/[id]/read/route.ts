import { withPermission } from '@/lib/authz/http';
import {
  invalidRequestResponse,
  serviceInvalidRequestResponse,
  noStoreHeaders,
} from '@/lib/work/http';
import { markNotificationRead } from '@/lib/notifications/service';

/**
 * PATCH /api/notifications/[id]/read — mark one OWN notification as read.
 * Permission: notifications.view (SELF). Another user's id → 404 (no leak).
 * 200: { notification }
 */

export const dynamic = 'force-dynamic';

export const PATCH = withPermission<{ id: string }>(
  { permission: 'notifications.view' },
  async (_request, authorization, params) => {
    try {
      const notification = await markNotificationRead(authorization, params.id);
      return Response.json({ notification }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
