import { withPermission } from '@/lib/authz/http';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/work/http';
import { writeAuditEntry } from '@/lib/audit/log';
import { AiOrgLimitsInputSchema, readAiLimits, upsertAiOrgLimits } from '@/lib/ai/usage';

/**
 * /api/ai/usage/limits — the caller's organization AI limits (Phase 9,
 * Workstream G; contract §8.3).
 *
 * GET (ai.usage.view): { effective, limits } — the §8.2 defaults merged
 * over the stored row, plus the raw row when one exists.
 *
 * PUT (ai.usage.manage): full-row upsert of the §4.2 fields — every field
 * is supplied on every write (an admin settings save); null means "use the
 * §8.2 default". The body is validated with the service's exported
 * AiOrgLimitsInputSchema and the service re-validates before writing. Every successful update writes an
 * `ai.limits.update` audit entry (§8.3) with flat metadata only — the new
 * values, never any content.
 */

export const dynamic = 'force-dynamic';

export const GET = withPermission(
  { permission: 'ai.usage.view' },
  async (_request, authorization) => {
    const { effective, raw } = await readAiLimits(authorization);
    return Response.json({ effective, limits: raw }, { headers: noStoreHeaders });
  },
);

export const PUT = withPermission(
  { permission: 'ai.usage.manage' },
  async (request, authorization) => {
    try {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json(
          { error: 'INVALID_REQUEST', message: 'Request body must be valid JSON.' },
          { status: 400, headers: noStoreHeaders },
        );
      }
      const input = AiOrgLimitsInputSchema.parse(body);
      const stored = await upsertAiOrgLimits(authorization, input);
      await writeAuditEntry(
        authorization.ctx,
        {
          action: 'ai.limits.update',
          entityType: 'ai_org_limits',
          entityId: authorization.ctx.orgId,
          result: 'SUCCESS',
          severity: 'MEDIUM',
          metadata: {
            enabled: stored.enabled,
            monthly_request_limit: stored.monthlyRequestLimit,
            monthly_token_limit: stored.monthlyTokenLimit,
            max_requests_per_minute_per_user: stored.maxRequestsPerMinutePerUser,
            max_concurrent_requests: stored.maxConcurrentRequests,
          },
        },
        authorization.meta,
      );
      const { effective, raw } = await readAiLimits(authorization);
      return Response.json({ effective, limits: raw }, { headers: noStoreHeaders });
    } catch (error) {
      const invalid = invalidRequestResponse(error) ?? serviceInvalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
