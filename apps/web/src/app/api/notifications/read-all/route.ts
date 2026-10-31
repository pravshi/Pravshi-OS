import { withPermission } from '@/lib/authz/http';
import { noStoreHeaders } from '@/lib/work/http';
import { markAllNotificationsRead } from '@/lib/notifications/service';

/**
 * PATCH /api/notifications/read-all — mark all OWN unread notifications read.
 * Permission: notifications.view (SELF). Only the caller's rows are touched.
 * 200: { updated }
 */

export const dynamic = 'force-dynamic';

export const PATCH = withPermission(
  { permission: 'notifications.view' },
  async (_request, authorization) => {
    const result = await markAllNotificationsRead(authorization);
    return Response.json(result, { headers: noStoreHeaders });
  },
);
