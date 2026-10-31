import { withPermission } from '@/lib/authz/http';
import { checkIpRateLimit } from '@/lib/auth/rate-limit';
import { searchGlobal } from '@/lib/search/query';
import {
  invalidRequestResponse,
  noStoreHeaders,
  serviceInvalidRequestResponse,
} from '@/lib/search/http';

/**
 * /api/search — global search (Phase 8, Workstream B).
 *
 * GET ?q=&type=&limit=&offset=&status=&ownerId=
 *   q         required, trimmed, 1-200 chars
 *   type      optional entity filter: one `type=deal`, repeated `type=` params,
 *             or comma-separated `type=deal,task`; strict allowlist of the 8
 *             approved types (contract §16.1 — no 'lead')
 *   limit     default 20, max 50, server-enforced
 *   offset    default 0
 *   status    optional entity-specific filter, allowlisted per entity
 *   ownerId   optional person UUID, tenant-checked against the caller's org
 *
 * ── PERMISSION DECISION (contract §16.7, documented per the task) ──────────────
 * withPermission() requires SOME catalogue permission for the route itself.
 * This route uses `people.view`: every employee role holds it (ADMIN, HR_ADMIN,
 * HR_MANAGER, SALES_MANAGER, SALES, PROJECT_MANAGER, DEVELOPER, VIBECODER at
 * SELF scope or broader — migration 0008 matrix), so it admits any active
 * employee and no one else, without granting anything. Per-entity filtering
 * then happens inside searchGlobal(): an entity is queried only when the
 * caller holds that entity's own view permission (e.g. `deals.view`), and each
 * table's scope-aware SELECT RLS policy restricts rows to the caller's scope.
 * A caller without `deals.view` learns nothing about deals — no rows, no
 * counts, no snippets.
 *
 * Tenant: every query is pinned to auth.ctx.orgId inside the database. There
 * is no client-supplied orgId to trust.
 *
 * Rate limited per user (Phase 11, F-11-09): the typeahead fires per
 * keystroke against trigram similarity — the most expensive routine read in
 * the app — so each person gets a fixed-window allowance on the
 * authz.check_rate_limit substrate. 120/min is far above any human typing
 * cadence (the client debounces); only a scripted caller ever meets it.
 */

export const dynamic = 'force-dynamic';

/** F-11-09 contract value: per-user allowance for the typeahead. */
const SEARCH_RATE_LIMIT_PER_MINUTE = 120;
const RATE_LIMIT_WINDOW_SECONDS = 60;

export const GET = withPermission({ permission: 'people.view' }, async (request, authorization) => {
  if (
    !(await checkIpRateLimit(
      `search:user:${authorization.ctx.personId}`,
      SEARCH_RATE_LIMIT_PER_MINUTE,
      RATE_LIMIT_WINDOW_SECONDS,
    ))
  ) {
    return Response.json(
      { error: 'RATE_LIMITED', message: 'Too many search requests. Please try again later.' },
      { status: 429, headers: noStoreHeaders },
    );
  }
  try {
    const url = new URL(request.url);
    const response = await searchGlobal(authorization, {
      query: url.searchParams.get('q') ?? undefined,
      entityTypes: url.searchParams.getAll('type'),
      limit: url.searchParams.get('limit') ?? undefined,
      offset: url.searchParams.get('offset') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      ownerId: url.searchParams.get('ownerId') ?? undefined,
    });
    return Response.json(response, { headers: noStoreHeaders });
  } catch (error) {
    const invalid = invalidRequestResponse(error);
    if (invalid) return invalid;
    const serviceInvalid = serviceInvalidRequestResponse(error);
    if (serviceInvalid) return serviceInvalid;
    throw error;
  }
});
