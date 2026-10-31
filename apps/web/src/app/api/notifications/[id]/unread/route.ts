import { withPermission } from '@/lib/authz/http';
import {
  invalidRequestResponse,
  serviceInvalidRequestResponse,
  noStoreHeaders,
} from '@/lib/work/http';
import { markNotificationUnread } from '@/lib/notifications/service';

/**
 * PATCH /api/notifications/[id]/unread — mark one OWN notification as unread.
 * Permission: notifications.view (SELF). Another user's id → 404 (no leak).
 * 200: { notification }
 */

export const dynamic = 'force-dynamic';

export const PATCH = withPermission<{ id: string }>(
  { permission: 'notifications.view' },
  async (_request, authorization, params) => {
    try {
      const notification = await markNotificationUnread(authorization, params.id);
      return Response.json({ notification }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
