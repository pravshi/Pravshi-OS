import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { cancelJob } from '@/lib/jobs/queue';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '../../http';

/**
 * POST /api/jobs/[id]/cancel — cancel a live job (Phase 6).
 * jobs.cancel → pending | claimed | running → cancelled.
 * (failed | dead_letter → cancelled is also permitted by the §3.1 state
 * machine — that is how dead-letter review "discards" a job.)
 * Terminal states → 400 INVALID_REQUEST; invisible job → 404.
 * The state machine is enforced inside cancelJob(); this route only
 * delegates to it.
 */

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();

export const POST = withPermission<{ id: string }>(
  { permission: 'jobs.cancel' },
  async (_request, authorization, params) => {
    try {
      const id = uuid.parse(params.id);
      await cancelJob(authorization, id);
      return Response.json({ ok: true }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid =
        invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
