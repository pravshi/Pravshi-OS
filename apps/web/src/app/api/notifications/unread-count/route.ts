import { withPermission } from '@/lib/authz/http';
import { noStoreHeaders } from '@/lib/work/http';
import { getUnreadCount } from '@/lib/notifications/service';

/**
 * GET /api/notifications/unread-count — unread badge count for the caller.
 * Permission: notifications.view (SELF).
 * 200: { unreadCount }
 */

export const dynamic = 'force-dynamic';

export const GET = withPermission(
  { permission: 'notifications.view' },
  async (_request, authorization) => {
    const unreadCount = await getUnreadCount(authorization);
    return Response.json({ unreadCount }, { headers: noStoreHeaders });
  },
);
