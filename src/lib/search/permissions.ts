/**
 * Search permission gating — Phase 8 Search & Notifications (Workstream B).
 *
 * Contract §16.6: NO new permission for search. Every result must pass the
 * existing entity view permission (e.g. `deals.view`), filtered AT THE QUERY
 * LEVEL, never post-hoc. A caller without a view permission gets no results,
 * no counts, no snippets, and no autocomplete data for that entity.
 *
 * How this file enforces it:
 *
 * 1. `entityViewScopes()` asks the database for
 *    `authz.scope_for('<entity>.view')` for all eight entities in one
 *    statement. A NULL (or unexpected) scope means the caller holds no live
 *    grant for that permission: the entity is excluded before any search query
 *    runs — it is never queried, counted, or ranked.
 * 2. Record-level filtering then happens inside the database via each table's
 *    scope-aware SELECT RLS policy (the same `authz.scope_for(...)` case
 *    expression the policies use), so a SELF holder only ever sees their own
 *    rows and a DEPARTMENT holder only their department's. The app layer never
 *    fetches rows and drops them in JS.
 *
 * Nothing here re-derives what a scope means: the catalogue and RLS decide.
 * This file only asks and fails closed.
 */
import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import type { AuthContext } from '@/lib/db/context';
import type { AccessScope } from '@/lib/authz/require-permission';
import { ENTITY_VIEW_PERMISSIONS } from './entities';
import { SEARCH_ENTITY_TYPES, type SearchEntityType } from './types';

/** Re-exported from the entity registry for callers that only need the map. */
export { ENTITY_VIEW_PERMISSIONS };

const ACCESS_SCOPES: ReadonlySet<string> = new Set([
  'GLOBAL',
  'DEPARTMENT',
  'TEAM',
  'PROJECT',
  'SELF',
]);

function isAccessScope(value: unknown): value is AccessScope {
  return typeof value === 'string' && ACCESS_SCOPES.has(value);
}

/**
 * The effective view scope per entity for the identity in `ctx`, or null for
 * entities the caller may not view at all. Fail-closed: a NULL, missing, or
 * unexpected value is treated as "no view permission", never as access.
 */
export async function entityViewScopes(
  ctx: AuthContext,
): Promise<Readonly<Record<SearchEntityType, AccessScope | null>>> {
  const row = await withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<Record<SearchEntityType, string | null>>(sql`
      select
        authz.scope_for(${ENTITY_VIEW_PERMISSIONS.contact})::text   as contact,
        authz.scope_for(${ENTITY_VIEW_PERMISSIONS.company})::text   as company,
        authz.scope_for(${ENTITY_VIEW_PERMISSIONS.deal})::text       as deal,
        authz.scope_for(${ENTITY_VIEW_PERMISSIONS.activity})::text  as activity,
        authz.scope_for(${ENTITY_VIEW_PERMISSIONS.project})::text   as project,
        authz.scope_for(${ENTITY_VIEW_PERMISSIONS.task})::text       as task,
        authz.scope_for(${ENTITY_VIEW_PERMISSIONS.workflow})::text  as workflow,
        authz.scope_for(${ENTITY_VIEW_PERMISSIONS.person})::text    as person
    `);
    return res.rows[0];
  });
  const scopes = {} as Record<SearchEntityType, AccessScope | null>;
  for (const entity of SEARCH_ENTITY_TYPES) {
    const scope = row?.[entity] ?? null;
    scopes[entity] = isAccessScope(scope) ? scope : null;
  }
  return Object.freeze(scopes);
}

/**
 * Entity types the caller may search at all. This is the query-level gate:
 * entities absent from this list are never queried (no rows, no counts).
 */
export async function viewableEntityTypes(ctx: AuthContext): Promise<readonly SearchEntityType[]> {
  const scopes = await entityViewScopes(ctx);
  return Object.freeze(SEARCH_ENTITY_TYPES.filter((e) => scopes[e] !== null));
}
