import { z } from 'zod';
import { withPermission } from '@/lib/authz/http';
import { listExecutions } from '@/lib/integrations/executions';
import { integrationsFailureResponse, noStoreHeaders } from '@/lib/integrations/http';

/**
 * GET /api/integrations/executions — the execution history read model
 * (Phase 10, Wave G; contract §4.4, §4.1 [DECISION]: no executions
 * table). Permission: integrations.view.
 *
 * Query: ?kind=webhook_delivery|email|inbound_event&status=&limit=&offset=
 * → { rows, total, limit, offset }, newest first, merging the org's
 * webhook/email jobs (enriched with their delivery links) and its
 * inbound events. Rows carry jobId where one exists; retry stays on the
 * existing /api/jobs/[id]/retry surface — this route never retries.
 */

export const dynamic = 'force-dynamic';

const ListRouteQuery = z.object({
  kind: z.enum(['webhook_delivery', 'email', 'inbound_event']).optional(),
  status: z.string().min(1).max(32).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = withPermission(
  { permission: 'integrations.view' },
  async (request, authorization) => {
    try {
      const url = new URL(request.url);
      const query = ListRouteQuery.parse({
        kind: url.searchParams.get('kind') ?? undefined,
        status: url.searchParams.get('status') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
        offset: url.searchParams.get('offset') ?? undefined,
      });
      const page = await listExecutions(authorization, query);
      return Response.json(page, { headers: noStoreHeaders });
    } catch (error) {
      const response = integrationsFailureResponse(error, authorization.requestId);
      if (response) return response;
      throw error;
    }
  },
);
