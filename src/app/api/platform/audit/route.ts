import { json } from '@/lib/platform/guard';
import { BadRequest, platformRoute } from '@/lib/platform/http';
import { isUuid, listAudit } from '@/lib/platform/service';

export const dynamic = 'force-dynamic';

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/;

/**
 * GET /api/platform/audit?limit=50&beforeAt=…&beforeId=… — the platform audit trail, newest
 * first, paged by the (time, id) of the last entry of the previous page (platform.audit.view).
 */
export const GET = platformRoute(
  { operation: 'platform.audit.list', permission: 'platform.audit.view' },
  async (req, ctx) => {
    const q = new URL(req.url).searchParams;
    const limit = Number(q.get('limit') ?? '50');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new BadRequest('limit');
    const beforeAt = q.get('beforeAt');
    const beforeId = q.get('beforeId');
    if ((beforeAt === null) !== (beforeId === null)) throw new BadRequest('cursor');
    if (beforeId !== null && !isUuid(beforeId)) throw new BadRequest('beforeId');
    // The cursor is the database's own text form of a timestamptz (microseconds kept).
    if (beforeAt !== null && !CURSOR_AT.test(beforeAt)) {
      throw new BadRequest('beforeAt');
    }
    const cursor = beforeAt && beforeId ? { beforeAt, beforeId } : null;
    return json(200, await listAudit(ctx, cursor, limit));
  },
);
