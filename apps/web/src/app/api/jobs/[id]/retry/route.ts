import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { retryJob } from '@/lib/jobs/queue';
import { invalidRequestResponse, noStoreHeaders, serviceInvalidRequestResponse } from '../../http';

/**
 * POST /api/jobs/[id]/retry — manual replay (Phase 6).
 * jobs.retry → failed | dead_letter → pending (attempts reset, due now).
 * Any other status → 400 INVALID_REQUEST; invisible job → 404.
 * The state machine is enforced inside retryJob(); this route only
 * delegates to it.
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const POST = withPermission<{ id: string }>(
  { permission: 'jobs.retry' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      const job = await retryJob(authorization, id);
      return Response.json(job, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
