import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import {
  invalidRequestResponse,
  serviceInvalidRequestResponse,
  noStoreHeaders,
} from '@/lib/work/http';
import {
  listNotifications,
  NOTIFICATIONS_LIST_LIMIT_DEFAULT,
  NOTIFICATIONS_LIST_LIMIT_MAX,
} from '@/lib/notifications/service';

/**
 * GET /api/notifications — the caller's own notifications, newest first.
 * Permission: notifications.view (SELF).
 * Query: ?limit= (default 20, max 50, server-enforced) &offset= &unreadOnly=
 * 200: { notifications, total, limit, offset } — never another user's rows.
 */

export const dynamic = 'force-dynamic';

const QuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(NOTIFICATIONS_LIST_LIMIT_MAX)
    .default(NOTIFICATIONS_LIST_LIMIT_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const GET = withPermission(
  { permission: 'notifications.view' },
  async (request, authorization) => {
    try {
      const query = QuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
      const result = await listNotifications(authorization, query);
      return Response.json(result, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
