import {
  getAnalyticsContext,
  validateDashboardFilter,
  type AuthContext,
} from '@/lib/analytics/tenant';
import type { DashboardFilter, TimeSeriesGrain } from '@/lib/analytics/types';
import type { TaskPriority, TaskStatus } from '@/lib/work/schema';

/**
 * REST plumbing shared by the Phase 7 analytics API routes.
 * Mirrors src/app/api/jobs/http.ts: request-validation failures are a 400
 * INVALID_REQUEST with the problem described; everything else propagates to
 * withPermission(), which answers with the standard authorization envelope.
 */

export const noStoreHeaders = { 'Cache-Control': 'no-store' } as const;

export interface ResolvedAnalyticsRequest {
  /** Session auth context — orgId came from the session, never the request. */
  ctx: AuthContext;
  orgId: string;
  filter: DashboardFilter;
}

/**
 * A 400 response for request-validation failures, or null when the error is
 * not one. Analytics modules signal these as `INVALID_REQUEST: <message>`
 * (work.ts filter guards, malformed JSON) or `analytics: <message>`
 * (tenant.ts / date-ranges.ts validation). Anything else propagates to
 * withPermission()'s error envelope.
 */
export function invalidRequestResponse(error: unknown): Response | null {
  if (error instanceof Error) {
    const withStatus = error as Error & { status?: unknown };
    if (withStatus.status === 401) {
      return Response.json(
        { error: 'UNAUTHORIZED', message: 'authentication required' },
        { status: 401, headers: noStoreHeaders },
      );
    }
    const match = /^(?:INVALID_REQUEST|analytics):\s*([\s\S]+)$/.exec(error.message);
    if (match) {
      return Response.json(
        { error: 'INVALID_REQUEST', message: (match[1] ?? '').trim() },
        { status: 400, headers: noStoreHeaders },
      );
    }
  }
  return null;
}

/**
 * Resolve the caller's analytics identity and validate the dashboard filter.
 * orgId is taken from the session via getAnalyticsContext() — a body/query
 * field named orgId is only reconciled against the session, never trusted
 * (see tenant.ts).
 */
export async function resolveAnalyticsRequest(
  request: Request,
  raw: unknown,
): Promise<ResolvedAnalyticsRequest> {
  const ctx = await getAnalyticsContext(request.headers);
  const { filter, orgId } = validateDashboardFilter(raw, ctx.orgId);
  return { ctx, orgId, filter };
}

/**
 * Defense-in-depth: the permission grant (from withPermission) and the
 * analytics session must name the same tenant before any metric runs.
 */
export function assertRequestTenant(authorizationOrgId: string, sessionOrgId: string): void {
  if (authorizationOrgId !== sessionOrgId) {
    throw new Error('analytics tenant mismatch between authorization and session');
  }
}

/**
 * Raw filter bag for GET: preset / timezone / customStart / customEnd /
 * grain (plus comparePreset / compareStart / compareEnd) as query params.
 */
export function filterFromQuery(url: URL): Record<string, string | undefined> {
  const get = (name: string): string | undefined => url.searchParams.get(name) ?? undefined;
  return {
    preset: get('preset'),
    timezone: get('timezone'),
    customStart: get('customStart'),
    customEnd: get('customEnd'),
    grain: get('grain'),
    comparePreset: get('comparePreset'),
    compareStart: get('compareStart'),
    compareEnd: get('compareEnd'),
  };
}

/**
 * Parse a POST body as a JSON object. An empty body means "defaults";
 * malformed JSON or a non-object body is a 400 INVALID_REQUEST.
 */
export async function parseFilterBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('INVALID_REQUEST: request body must be valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('INVALID_REQUEST: request body must be a JSON object');
  }
  return parsed;
}

/** Serialize a dashboard payload to plain JSON: Dates become ISO strings. */
export function serializeDashboard<T>(payload: T): T {
  return JSON.parse(JSON.stringify(payload)) as T;
}

/** The resolved range, echoed in every dashboard response. */
export function rangeEcho(filter: DashboardFilter): {
  preset: string;
  timezone: string;
  startInclusive: string;
  endExclusive: string;
} {
  return {
    preset: filter.dateRange.preset,
    timezone: filter.dateRange.timezone,
    startInclusive: filter.dateRange.startInclusive.toISOString(),
    endExclusive: filter.dateRange.endExclusive.toISOString(),
  };
}

/** YYYY-MM-DD of a UTC instant as seen in the given IANA timezone. */
export function ymdInTimezone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Map a dashboard date range onto the work module's YYYY-MM-DD creation
 * window. Bounds are local midnights in the range's timezone, so the window
 * is [startInclusive's local day, last included local day].
 */
export function workDateWindow(filter: DashboardFilter): {
  createdFrom: string;
  createdTo: string;
} {
  const timeZone = filter.dateRange.timezone;
  return {
    createdFrom: ymdInTimezone(filter.dateRange.startInclusive, timeZone),
    createdTo: ymdInTimezone(new Date(filter.dateRange.endExclusive.getTime() - 1), timeZone),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Domain-specific filters the work dashboard accepts inside the `filters` bag. */
export interface WorkRouteFilters {
  projectId?: string;
  assigneePersonId?: string;
  priority?: TaskPriority;
  status?: TaskStatus;
  dueBefore?: string;
  dueAfter?: string;
  /** Overdue-tasks page size (module default when absent). */
  limit?: number;
}

/**
 * Pick known work filter fields from the request's `filters` bag. Values are
 * validated by the work module itself (INVALID_REQUEST → 400); UUID-shaped
 * ids are checked here so a malformed id is a 400, not a Postgres cast error.
 */
export function workFiltersFrom(raw: unknown): WorkRouteFilters {
  const bag = (raw as { filters?: unknown } | null)?.filters;
  const src = (bag !== null && typeof bag === 'object' ? bag : {}) as Record<string, unknown>;
  const out: WorkRouteFilters = {};
  const str = (key: string): string | undefined =>
    typeof src[key] === 'string' ? (src[key] as string) : undefined;
  const projectId = str('projectId');
  if (projectId !== undefined) {
    if (!UUID_RE.test(projectId)) throw new Error('INVALID_REQUEST: projectId must be a UUID');
    out.projectId = projectId;
  }
  const assigneePersonId = str('assigneePersonId');
  if (assigneePersonId !== undefined) {
    if (!UUID_RE.test(assigneePersonId)) {
      throw new Error('INVALID_REQUEST: assigneePersonId must be a UUID');
    }
    out.assigneePersonId = assigneePersonId;
  }
  const priority = str('priority');
  if (priority !== undefined) out.priority = priority as TaskPriority;
  const status = str('status');
  if (status !== undefined) out.status = status as TaskStatus;
  const dueBefore = str('dueBefore');
  if (dueBefore !== undefined) out.dueBefore = dueBefore;
  const dueAfter = str('dueAfter');
  if (dueAfter !== undefined) out.dueAfter = dueAfter;
  if (typeof src.limit === 'number' && Number.isFinite(src.limit)) {
    out.limit = Math.min(Math.max(Math.floor(src.limit), 1), 500);
  }
  return out;
}

/** Map a dashboard grain onto the work trend's day/week granularity. */
export function trendGranularity(grain: TimeSeriesGrain | undefined): 'day' | 'week' {
  if (grain === 'day' || grain === undefined) return 'day';
  return 'week';
}
