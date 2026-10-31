import { withPermission } from '@/lib/authz/http';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { AuthContext } from '@/lib/analytics/tenant';
import type { DashboardFilter } from '@/lib/analytics/types';
import {
  getAvgDealValue,
  getDealsByOwner,
  getDealsByStage,
  getPipelineValue,
  getWinRate,
  getWonRevenue,
} from '@/lib/analytics/sales';
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
 * /api/analytics/sales — sales dashboard (Phase 7).
 * GET  ?preset=&timezone=&customStart=&customEnd=&grain=      reports.view → sales metrics
 * POST { preset, timezone, customStart, customEnd, filters }  reports.view → sales metrics
 *
 * Money is returned as numeric strings per currency (never summed across
 * currencies). Plain JSON, no envelope, no-store.
 *
 * Phase 12 (F-12-01): the six metrics compose over ONE shared
 * withAuthorizedDb transaction (each metric's trailing `tx`). Per-route
 * transaction budget: ≤ 2 (shared metrics tx + the authz tx).
 */

export const dynamic = 'force-dynamic';

async function buildSalesDashboard(ctx: AuthContext, filter: DashboardFilter) {
  return withAuthorizedDb(ctx, async (tx) => {
    const [dealsByStage, pipelineValue, wonRevenue, winRate, avgDealValue, dealsByOwner] =
      await Promise.all([
        getDealsByStage(ctx, filter, tx),
        getPipelineValue(ctx, filter, tx),
        getWonRevenue(ctx, filter, tx),
        getWinRate(ctx, filter, tx),
        getAvgDealValue(ctx, filter, tx),
        getDealsByOwner(ctx, filter, tx),
      ]);
    return { dealsByStage, pipelineValue, wonRevenue, winRate, avgDealValue, dealsByOwner };
  });
}

async function handleSales(request: Request, raw: unknown, authorizationOrgId: string) {
  const { ctx, orgId, filter } = await resolveAnalyticsRequest(request, raw);
  assertRequestTenant(authorizationOrgId, orgId);
  const payload = await buildSalesDashboard(ctx, filter);
  return Response.json(serializeDashboard({ range: rangeEcho(filter), ...payload }), {
    headers: noStoreHeaders,
  });
}

export const GET = withPermission(
  { permission: 'reports.view' },
  async (request, authorization) => {
    try {
      return await handleSales(
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
      return await handleSales(request, await parseFilterBody(request), authorization.ctx.orgId);
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
