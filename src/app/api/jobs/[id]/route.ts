import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { invalidRequestResponse, noStoreHeaders } from '../http';
import { getJob } from '../store';

/**
 * /api/jobs/[id] — single job (Phase 6).
 * GET  jobs.view  → the job, or 404 when invisible (missing or another org's)
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const GET = withPermission<{ id: string }>(
  { permission: 'jobs.view' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const job = await getJob(authorization, id);
      return Response.json(job, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
