import { withPermission } from '@/lib/authz/http';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/work/http';
import { getAiUsageSummary } from '@/lib/ai/usage';

/**
 * GET /api/ai/usage — the caller's organization AI usage for one month
 * (Phase 9, Workstream G; contract §8.3). Permission: ai.usage.view.
 *
 * Query: ?month=YYYY-MM (optional; defaults to the current UTC month).
 * 200: { period, requests, succeeded, failed, limited, totalTokens,
 *        byCapability, byProvider } for the caller's org only — the service
 * pins every aggregate to auth.ctx.orgId and the table's SELECT policy
 * gates the rows on ai.usage.view again.
 */

export const dynamic = 'force-dynamic';

export const GET = withPermission(
  { permission: 'ai.usage.view' },
  async (request, authorization) => {
    try {
      const month = new URL(request.url).searchParams.get('month') ?? undefined;
      const summary = await getAiUsageSummary(authorization, month);
      return Response.json(summary, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
