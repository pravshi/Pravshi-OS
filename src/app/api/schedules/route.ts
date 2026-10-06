import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '../jobs/http';
import { createSchedule, listSchedules } from '../jobs/store';

/**
 * /api/schedules — collection (Phase 6).
 * GET   ?isActive=&page=&limit=  jobs.view   → { schedules, total }
 * POST  { workflowId, name, cron, timezone?, isActive? }
 *                                   jobs.create → 201 + the schedule
 *       cron is a strict 5-field expression, timezone an IANA name —
 *       validated by zod at this boundary; next_run_at is computed from
 *       them at create time. An unknown or foreign-org workflowId → 404.
 */

export const dynamic = 'force-dynamic';

const listQuery = z.object({
  isActive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const GET = withPermission({ permission: 'jobs.view' }, async (request, authorization) => {
  try {
    const url = new URL(request.url);
    const query = listQuery.parse({
      isActive: url.searchParams.get('isActive') ?? undefined,
      page: url.searchParams.get('page') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });
    const page = await listSchedules(authorization, query);
    return Response.json(page, { headers: noStoreHeaders });
  } catch (error) {
    const invalid = invalidRequestResponse(error);
    if (invalid) return invalid;
    throw error;
  }
});

export const POST = withPermission(
  { permission: 'jobs.create' },
  async (request, authorization) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const schedule = await createSchedule(authorization, body);
      return Response.json(schedule, { status: 201, headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
