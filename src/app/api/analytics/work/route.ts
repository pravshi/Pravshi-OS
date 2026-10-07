import { withPermission } from '@/lib/authz/http';
import type { AuthContext } from '@/lib/analytics/tenant';
import type { DashboardFilter } from '@/lib/analytics/types';
import {
  getOverdueTasks,
  getProjectStats,
  getTaskCompletionTrend,
  getTasksByAssignee,
  getTasksByPriority,
  getTasksByStatus,
} from '@/lib/analytics/work';
import {
  assertRequestTenant,
  filterFromQuery,
  invalidRequestResponse,
  noStoreHeaders,
  parseFilterBody,
  rangeEcho,
  resolveAnalyticsRequest,
  serializeDashboard,
  trendGranularity,
  workDateWindow,
  workFiltersFrom,
} from '../http';

/**
 * /api/analytics/work — work/projects dashboard (Phase 7).
 * GET  ?preset=&timezone=&customStart=&customEnd=&grain=      reports.view → work metrics
 * POST { preset, timezone, customStart, customEnd, filters }  reports.view → work metrics
 *
 * The dashboard date range is mapped onto the work module's YYYY-MM-DD
 * creation window; the POST body's `filters` bag additionally accepts
 * projectId, assigneePersonId, priority, status, dueBefore, dueAfter, and
 * limit (overdue-tasks page size). Unknown status/priority values and
 * malformed dates are 400s via the work module's own guards.
 *
 * Plain JSON, no envelope, no-store.
 */

export const dynamic = 'force-dynamic';

async function buildWorkDashboard(ctx: AuthContext, filter: DashboardFilter, raw: unknown) {
  const window = workDateWindow(filter);
  const domain = workFiltersFrom(raw);
  const { status, priority, limit, assigneePersonId, ...rest } = domain;
  const scoped = { ...window, ...rest };
  const [
    projectStats,
    tasksByStatus,
    tasksByPriority,
    overdueTasks,
    tasksByAssignee,
    taskCompletionTrend,
  ] = await Promise.all([
    getProjectStats(ctx, window),
    getTasksByStatus(ctx, { ...scoped, priority, assigneePersonId }),
    getTasksByPriority(ctx, { ...scoped, status, assigneePersonId }),
    getOverdueTasks(ctx, limit === undefined ? {} : { limit }),
    getTasksByAssignee(ctx, { ...scoped, status, priority }),
    getTaskCompletionTrend(
      ctx,
      {
        from: window.createdFrom,
        to: window.createdTo,
        granularity: trendGranularity(filter.grain),
      },
      { ...rest, priority, assigneePersonId },
    ),
  ]);
  return {
    projectStats,
    tasksByStatus,
    tasksByPriority,
    overdueTasks,
    tasksByAssignee,
    taskCompletionTrend,
  };
}

async function handleWork(request: Request, raw: unknown, authorizationOrgId: string) {
  const { ctx, orgId, filter } = await resolveAnalyticsRequest(request, raw);
  assertRequestTenant(authorizationOrgId, orgId);
  const payload = await buildWorkDashboard(ctx, filter, raw);
  return Response.json(serializeDashboard({ range: rangeEcho(filter), ...payload }), {
    headers: noStoreHeaders,
  });
}

export const GET = withPermission(
  { permission: 'reports.view' },
  async (request, authorization) => {
    try {
      return await handleWork(
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
      return await handleWork(request, await parseFilterBody(request), authorization.ctx.orgId);
    } catch (error) {
      const invalid = invalidRequestResponse(error);
      if (invalid) return invalid;
      throw error;
    }
  },
);
