import { withPermission } from '@/lib/authz/http';
import type { AuthContext } from '@/lib/analytics/tenant';
import type { DashboardFilter } from '@/lib/analytics/types';
import {
  getAutomationSuccessRate,
  getDeadLetterCount,
  getJobStats,
  getJobsOverTime,
} from '@/lib/analytics/automation';
import {
  getExecutionsOverTime,
  getTopWorkflows,
  getWorkflowStats,
  getWorkflowSuccessRate,
} from '@/lib/analytics/workflows';
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
 * /api/analytics/automation — workflow + automation dashboard (Phase 7).
 * GET  ?preset=&timezone=&customStart=&customEnd=&grain=      reports.view → automation metrics
 * POST { preset, timezone, customStart, customEnd, filters }  reports.view → automation metrics
 *
 * Plain JSON, no envelope, no-store.
 */

export const dynamic = 'force-dynamic';

async function buildAutomationDashboard(ctx: AuthContext, filter: DashboardFilter) {
  const [
    workflowStats,
    workflowSuccessRate,
    executionsOverTime,
    topWorkflows,
    jobStats,
    automationSuccessRate,
    deadLetterCount,
    jobsOverTime,
  ] = await Promise.all([
    getWorkflowStats(ctx, filter),
    getWorkflowSuccessRate(ctx, filter),
    getExecutionsOverTime(ctx, filter),
    getTopWorkflows(ctx, filter),
    getJobStats(ctx, filter),
    getAutomationSuccessRate(ctx, filter),
    getDeadLetterCount(ctx),
    getJobsOverTime(ctx, filter),
  ]);
  return {
    workflows: {
      stats: workflowStats,
      successRate: workflowSuccessRate,
      executionsOverTime,
      topWorkflows,
    },
    automation: {
      jobStats,
      successRate: automationSuccessRate,
      deadLetterCount,
      jobsOverTime,
    },
  };
}

async function handleAutomation(request: Request, raw: unknown, authorizationOrgId: string) {
  const { ctx, orgId, filter } = await resolveAnalyticsRequest(request, raw);
  assertRequestTenant(authorizationOrgId, orgId);
  const payload = await buildAutomationDashboard(ctx, filter);
  return Response.json(serializeDashboard({ range: rangeEcho(filter), ...payload }), {
    headers: noStoreHeaders,
  });
}

export const GET = withPermission(
  { permission: 'reports.view' },
  async (request, authorization) => {
    try {
      return await handleAutomation(
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
      return await handleAutomation(
        request,
        await parseFilterBody(request),
        authorization.ctx.orgId,
      );
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
