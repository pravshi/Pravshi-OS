import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { JOB_STATUSES, JOB_TYPES } from '@/lib/jobs/types';
import { invalidRequestResponse, noStoreHeaders } from './http';
import { listJobs } from './store';

/**
 * /api/jobs — collection (Phase 6).
 * GET  ?status=&type=&page=&limit=  jobs.view  → { jobs, total }
 *      (status ∈ the 7 job statuses, type ∈ the 7 job types;
 *       page ≥ 1, limit 1–100)
 */

export const dynamic = 'force-dynamic';

const listQuery = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  type: z.enum(JOB_TYPES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const GET = withPermission({ permission: 'jobs.view' }, async (request, authorization) => {
  try {
    const url = new URL(request.url);
    const query = listQuery.parse({
      status: url.searchParams.get('status') ?? undefined,
      type: url.searchParams.get('type') ?? undefined,
      page: url.searchParams.get('page') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });
    const page = await listJobs(authorization, query);
    return Response.json(page, { headers: noStoreHeaders });
  } catch (error) {
    const invalid = invalidRequestResponse(error);
    if (invalid) return invalid;
    throw error;
  }
});
