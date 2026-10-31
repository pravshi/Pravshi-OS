import { withPermission } from '@/lib/authz/http';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { AuthContext } from '@/lib/analytics/tenant';
import type { DashboardFilter } from '@/lib/analytics/types';
import { getPipelineValue, getWinRate, getWonRevenue } from '@/lib/analytics/sales';
import { getLeadConversionRate, getLeadCounts } from '@/lib/analytics/crm';
import { getProjectStats, getTasksByStatus } from '@/lib/analytics/work';
import { getWorkflowStats, getWorkflowSuccessRate } from '@/lib/analytics/workflows';
import {
  getAutomationSuccessRate,
  getDeadLetterCount,
  getJobStats,
} from '@/lib/analytics/automation';
import {
  assertRequestTenant,
  filterFromQuery,
  invalidRequestResponse,
  noStoreHeaders,
  parseFilterBody,
  rangeEcho,
  resolveAnalyticsRequest,
  serializeDashboard,
  workDateWindow,
} from '../http';

/**
 * /api/analytics/overview — organization overview dashboard (Phase 7).
 * GET  ?preset=&timezone=&customStart=&customEnd=&grain=      reports.view → key metrics
 * POST { preset, timezone, customStart, customEnd, filters }  reports.view → key metrics
 *
 * The headline metric of every domain. Money is returned as numeric
 * strings per currency (never summed across currencies).
 * Plain JSON, no envelope, no-store.
 *
 * Phase 12 (F-12-01): the twelve metrics compose over ONE shared
 * withAuthorizedDb transaction (passed as each metric's trailing `tx`).
 * The Promise.all fan-out remains, but the queries serialise on that single
 * connection — the win is connection count (was: one transaction per
 * metric against a pool of 5), not parallelism. Per-route transaction
 * budget: ≤ 2 (this shared metrics tx + the authz tx from withPermission).
 */

export const dynamic = 'force-dynamic';

async function buildOverview(ctx: AuthContext, orgId: string, filter: DashboardFilter) {
  return withAuthorizedDb(ctx, async (tx) => {
    const [
      pipelineValue,
      wonRevenue,
      winRate,
      leadCounts,
      leadConversionRate,
      projectStats,
      tasksByStatus,
      workflowStats,
      workflowSuccessRate,
      jobStats,
      automationSuccessRate,
      deadLetterCount,
    ] = await Promise.all([
      getPipelineValue(ctx, filter, tx),
      getWonRevenue(ctx, filter, tx),
      getWinRate(ctx, filter, tx),
      getLeadCounts(orgId, ctx, filter, tx),
      getLeadConversionRate(orgId, ctx, filter.dateRange, tx),
      getProjectStats(ctx, workDateWindow(filter), tx),
      getTasksByStatus(ctx, {}, tx),
      getWorkflowStats(ctx, filter, tx),
      getWorkflowSuccessRate(ctx, filter, tx),
      getJobStats(ctx, filter, tx),
      getAutomationSuccessRate(ctx, filter, tx),
      getDeadLetterCount(ctx, tx),
    ]);
    return {
      sales: { pipelineValue, wonRevenue, winRate },
      crm: { leadCounts, leadConversionRate },
      work: { projectStats, tasksByStatus },
      workflows: { stats: workflowStats, successRate: workflowSuccessRate },
      automation: { jobStats, successRate: automationSuccessRate, deadLetterCount },
    };
  });
}

async function handleOverview(request: Request, raw: unknown, authorizationOrgId: string) {
  const { ctx, orgId, filter } = await resolveAnalyticsRequest(request, raw);
  assertRequestTenant(authorizationOrgId, orgId);
  const payload = await buildOverview(ctx, orgId, filter);
  return Response.json(serializeDashboard({ range: rangeEcho(filter), ...payload }), {
    headers: noStoreHeaders,
  });
}

export const GET = withPermission(
  { permission: 'reports.view' },
  async (request, authorization) => {
    try {
      return await handleOverview(
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
      return await handleOverview(request, await parseFilterBody(request), authorization.ctx.orgId);
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
