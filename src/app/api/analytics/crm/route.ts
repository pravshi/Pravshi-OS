import { withPermission } from '@/lib/authz/http';
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
 */

export const dynamic = 'force-dynamic';

async function buildCrmDashboard(ctx: AuthContext, orgId: string, filter: DashboardFilter) {
  const grain = filter.grain ?? 'day';
  const [leadCounts, leadConversionRate, contactGrowth, companyGrowth, activityVolume] =
    await Promise.all([
      getLeadCounts(orgId, ctx, filter),
      getLeadConversionRate(orgId, ctx, filter.dateRange),
      getContactGrowth(orgId, ctx, filter.dateRange, grain),
      getCompanyGrowth(orgId, ctx, filter.dateRange, grain),
      getActivityVolume(orgId, ctx, filter.dateRange, grain),
    ]);
  return { leadCounts, leadConversionRate, contactGrowth, companyGrowth, activityVolume };
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
