import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { invalidRequestResponse, noStoreHeaders } from '../http';
import { listJobs } from '../store';

/**
 * /api/jobs/dead-letter — dead letter queue (Phase 6).
 * GET  ?page=&limit=  jobs.view  → { jobs, total } with status = dead_letter
 *      (static segment wins over [id], so /dead-letter never collides with
 *       a job id)
 */

export const dynamic = 'force-dynamic';

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const GET = withPermission(
  { permission: 'jobs.view' },
  async (request, authorization) => {
    try {
      const url = new URL(request.url);
      const query = listQuery.parse({
        page: url.searchParams.get('page') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
      });
      const page = await listJobs(authorization, {
        ...query,
        status: 'dead_letter',
      });
      return Response.json(page, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
