import { withPermission } from '@/lib/authz/http';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { AuthContext } from '@/lib/analytics/tenant';
import type { DashboardFilter } from '@/lib/analytics/types';
import {
  getActivityVolume,
  getCompanyGrowth,
  getContactGrowth,
  getLeadConversionRate,
  getLeadCounts,
} from '@/lib/analytics/crm';
import {
  assertRequestTenant,
  filterFromQuery,
  invalidRequestResponse,
  noStoreHeaders,
  parseFilterBody,
  rangeEcho,
  resolveAnalyticsRequest,
  serializeDashboard,
} from '../http';

/**
 * /api/analytics/crm — CRM dashboard (Phase 7).
 * GET  ?preset=&timezone=&customStart=&customEnd=&grain=      reports.view → CRM metrics
 * POST { preset, timezone, customStart, customEnd, filters }  reports.view → CRM metrics
 *
 * Plain JSON, no envelope, no-store.
 *
 * Phase 12 (F-12-01): the five metrics compose over ONE shared
 * withAuthorizedDb transaction (each metric's trailing `tx`). Per-route
 * transaction budget: ≤ 2 (shared metrics tx + the authz tx).
 */

export const dynamic = 'force-dynamic';

async function buildCrmDashboard(ctx: AuthContext, orgId: string, filter: DashboardFilter) {
  const grain = filter.grain ?? 'day';
  return withAuthorizedDb(ctx, async (tx) => {
    const [leadCounts, leadConversionRate, contactGrowth, companyGrowth, activityVolume] =
      await Promise.all([
        getLeadCounts(orgId, ctx, filter, tx),
        getLeadConversionRate(orgId, ctx, filter.dateRange, tx),
        getContactGrowth(orgId, ctx, filter.dateRange, grain, tx),
        getCompanyGrowth(orgId, ctx, filter.dateRange, grain, tx),
        getActivityVolume(orgId, ctx, filter.dateRange, grain, tx),
      ]);
    return { leadCounts, leadConversionRate, contactGrowth, companyGrowth, activityVolume };
  });
}

async function handleCrm(request: Request, raw: unknown, authorizationOrgId: string) {
  const { ctx, orgId, filter } = await resolveAnalyticsRequest(request, raw);
  assertRequestTenant(authorizationOrgId, orgId);
  const payload = await buildCrmDashboard(ctx, orgId, filter);
  return Response.json(serializeDashboard({ range: rangeEcho(filter), ...payload }), {
    headers: noStoreHeaders,
  });
}

export const GET = withPermission(
  { permission: 'reports.view' },
  async (request, authorization) => {
    try {
      return await handleCrm(
        request,
        filterFromQuery(new URL(request.url)),
        authorization.ctx.orgId,
      );
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);

export const POST = withPermission(
  { permission: 'reports.view' },
  async (request, authorization) => {
    try {
      return await handleCrm(request, await parseFilterBody(request), authorization.ctx.orgId);
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
