import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '../../jobs/http';
import { deleteSchedule, getSchedule, updateSchedule } from '../../jobs/store';

/**
 * /api/schedules/[id] — single schedule (Phase 6).
 * GET    jobs.view   → the schedule, or 404 when invisible
 * PATCH  jobs.create → { name?, cron?, timezone?, isActive? }
 *                      → 200 + the updated schedule (next_run_at recomputed
 *                        when cron/timezone change)
 * DELETE jobs.delete → deactivates (is_active = false), 200 { ok: true }.
 *                      Hard delete has no RLS policy by design (0045), so
 *                      DELETE follows the Phase 5 soft-delete convention.
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const GET = withPermission<{ id: string }>(
  { permission: 'jobs.view' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const schedule = await getSchedule(authorization, id);
      return Response.json(schedule, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const PATCH = withPermission<{ id: string }>(
  { permission: 'jobs.create' },
  async (request, authorization, params) => {
    const body: unknown = await request.json().catch(() => undefined);
    try {
      const id = uuid.parse(params.id);
      const schedule = await updateSchedule(authorization, id, body);
      return Response.json(schedule, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const DELETE = withPermission<{ id: string }>(
  { permission: 'jobs.delete' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      await deleteSchedule(authorization, id);
      return Response.json({ ok: true }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
