/**
 * Global search execution — Phase 8 Search & Notifications (Workstream B).
 *
 * Contract §§16.2, 16.6, 16.7, 16.8:
 * - Filters validated server-side with zod (query 1-200 chars, entity allowlist,
 *   limit default 20 / max 50 server-enforced, ownerId UUID).
 * - Permission gate: only entities the caller may view (per
 *   src/lib/search/permissions.ts) are queried at all — no results, counts,
 *   or snippets leak for forbidden entities.
 * - Tenant: every query is pinned to `auth.ctx.orgId`; the client orgId is
 *   never trusted (there is no client orgId input at all).
 * - Record-level visibility is enforced by each table's scope-aware SELECT RLS
 *   policy inside withAuthorizedDb(); the app never filters rows post-hoc.
 * - SQL injection: all user input travels as bound parameters. Table/column
 *   names come only from the trusted entity registry (entities.ts) and pass
 *   through ident(), which rejects anything but [a-z_][a-z0-9_]*.
 * - pg_trgm: relevance uses the trigram `similarity()`/``%`` operator when the
 *   extension is present (migration 0053 indexes accelerate it); otherwise the
 *   ILIKE fallback still answers correctly, just without trigram ranking.
 */
import { sql, type SQL } from 'drizzle-orm';
import { withAuthorizedDb, type Tx } from '@/lib/db/authorized';
import type { AuthContext } from '@/lib/db/context';
import type { Authorization } from '@/lib/authz/require-permission';
import {
  SCORE_EXACT,
  SCORE_PREFIX,
  SCORE_SUBSTRING,
  SCORE_TRIGRAM_SCALE,
  TRIGRAM_SIMILARITY_THRESHOLD,
  escapeLikePattern,
} from './ranking';
import { viewableEntityTypes } from './permissions';
import { allowedStatusValues, entityConfig, type SearchEntityConfig } from './entities';
import { SearchFiltersSchema, type ParsedSearchFilters } from './filters';
import {
  isSearchEntityType,
  SEARCH_ENTITY_TYPES,
  type SearchEntityType,
  type SearchFilters,
  type SearchResponse,
  type SearchResult,
} from './types';

/** Re-exported so callers import the schema from the execution module. */
export { SearchFiltersSchema };
export type { ParsedSearchFilters };

/** Trusted SQL identifier: registry constants only, defense-in-depth. */
function ident(name: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`INVALID_REQUEST: invalid identifier '${name}'`);
  }
  return sql.raw(`"${name}"`);
}

interface EntityHit extends Record<string, unknown> {
  entityId: string;
  title: string;
  subtitle: string | null;
  metadata: Record<string, unknown> | null;
  relevance: number;
  total: number;
}

function buildEntityQuery(
  cfg: SearchEntityConfig,
  filters: ParsedSearchFilters,
  orgId: string,
  hasTrgm: boolean,
  fetchLimit: number,
): SQL {
  const q = filters.query;
  const likeQ = escapeLikePattern(q);
  const cols = cfg.searchColumns.map(ident);

  const exact = sql.join(
    cols.map((c) => sql`lower(e.${c}) = lower(${q})`),
    sql` or `,
  );
  const prefix = sql.join(
    cols.map((c) => sql`e.${c} ilike ${likeQ} || '%' escape '\'`),
    sql` or `,
  );
  const substring = sql.join(
    cols.map((c) => sql`e.${c} ilike '%' || ${likeQ} || '%' escape '\'`),
    sql` or `,
  );

  const trigramSim: SQL = hasTrgm
    ? sql`greatest(${sql.join(
        cols.map((c) => sql`similarity(e.${c}, ${q})`),
        sql`, `,
      )})`
    : sql`0`;
  const trigramWhere: SQL = hasTrgm
    ? sql` or ${sql.join(
        cols.map((c) => sql`e.${c} % ${q}`),
        sql` or `,
      )}`
    : sql``;

  // Deterministic tiers, mirroring ranking.ts:
  // exact (1.0) > prefix (0.8) > trigram (similarity * 0.7, max 0.7) > substring (0.5).
  const relevance = sql`(
    case
      when ${exact} then ${SCORE_EXACT}::float8
      when ${prefix} then ${SCORE_PREFIX}::float8
      else greatest(
        case
          when ${trigramSim} >= ${TRIGRAM_SIMILARITY_THRESHOLD}::float8
          then (${trigramSim} * ${SCORE_TRIGRAM_SCALE}::float8)
          else 0::float8
        end,
        case when ${substring} then ${SCORE_SUBSTRING}::float8 else 0::float8 end
      )
    end
  )`;

  const statusWhere =
    filters.status && cfg.statusColumn
      ? sql` and e.${ident(cfg.statusColumn)} = ${filters.status}`
      : sql``;
  const ownerWhere =
    filters.ownerId && cfg.ownerColumn
      ? sql` and e.${ident(cfg.ownerColumn)} = ${filters.ownerId}::uuid`
      : sql``;

  return sql`
    select
      e.id::text as "entityId",
      (${sql.raw(cfg.titleExpr)}) as title,
      (${sql.raw(cfg.subtitleExpr)}) as subtitle,
      (${sql.raw(cfg.metadataExpr)}) as metadata,
      ${relevance} as relevance,
      count(*) over ()::int as total
    from ${sql.raw(cfg.table)} e
    where e.org_id = ${orgId}::uuid
      and e.deleted_at is null
      ${statusWhere}
      ${ownerWhere}
      and (${substring}${trigramWhere})
    order by relevance desc, title asc, e.id asc
    limit ${fetchLimit} offset ${filters.offset}
  `;
}

async function probeTrigram(tx: Tx): Promise<boolean> {
  const res = await tx.execute<{ has_trgm: boolean }>(sql`
    select exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'similarity'
        and n.nspname in ('public', 'pg_catalog')
    ) as has_trgm
  `);
  return res.rows[0]?.has_trgm === true;
}

/**
 * Tenant-check for the ownerId filter: the UUID must identify a live person in
 * the caller's org. A cross-tenant or unknown UUID is a 400, not silent
 * acceptance (which would either leak or over-return). UUIDs are unguessable,
 * so the refusal is not an enumeration oracle.
 */
async function assertOwnerInOrg(tx: Tx, orgId: string, ownerId: string): Promise<void> {
  const res = await tx.execute<{ ok: boolean }>(sql`
    select exists (
      select 1 from public.people
      where id = ${ownerId}::uuid
        and org_id = ${orgId}::uuid
        and deleted_at is null
    ) as ok
  `);
  if (res.rows[0]?.ok !== true) {
    throw new Error('INVALID_REQUEST: ownerId does not identify a person in your organization');
  }
}

/**
 * Run a global search for the authorized caller.
 *
 * The `Authorization` must already be issued (the route uses withPermission).
 * Everything permission- and tenant-related is enforced inside the database:
 * entity gating via authz.scope_for, row visibility via RLS.
 */
export async function searchGlobal(auth: Authorization, input: unknown): Promise<SearchResponse> {
  const filters: ParsedSearchFilters = SearchFiltersSchema.parse(input);
  const viewable = await viewableEntityTypes(auth.ctx);
  const entities = viewable.filter((e) => !filters.entityTypes || filters.entityTypes.includes(e));

  if (filters.status && !allowedStatusValues(entities).has(filters.status)) {
    throw new Error(`INVALID_REQUEST: status '${filters.status}' is not a valid filter value`);
  }

  const empty: SearchResponse = {
    results: [],
    total: 0,
    limit: filters.limit,
    offset: filters.offset,
    query: filters.query,
  };
  if (entities.length === 0) return empty;

  const ctx: AuthContext = auth.ctx;
  const perEntity = await withAuthorizedDb(ctx, async (tx) => {
    if (filters.ownerId) await assertOwnerInOrg(tx, ctx.orgId, filters.ownerId);
    const hasTrgm = await probeTrigram(tx);
    const fetchLimit = filters.limit + filters.offset;
    return Promise.all(
      entities.map(async (entityType) => {
        const cfg = entityConfig(entityType);
        const res = await tx.execute<EntityHit>(
          buildEntityQuery(cfg, filters, ctx.orgId, hasTrgm, fetchLimit),
        );
        return { entityType, cfg, rows: res.rows };
      }),
    );
  });

  const merged: SearchResult[] = [];
  let total = 0;
  for (const { entityType, cfg, rows } of perEntity) {
    total += rows[0]?.total ?? 0;
    for (const row of rows) {
      merged.push({
        entityType,
        entityId: row.entityId,
        title: row.title,
        ...(row.subtitle ? { subtitle: row.subtitle } : {}),
        ...(row.metadata ? { metadata: row.metadata } : {}),
        relevance: Math.min(1, Math.max(0, Math.round(row.relevance * 10_000) / 10_000)),
        url: `${cfg.urlPrefix}/${row.entityId}`,
      });
    }
  }

  // Deterministic global order: relevance desc, then entity, then id.
  merged.sort(
    (a, b) =>
      b.relevance - a.relevance ||
      a.entityType.localeCompare(b.entityType) ||
      a.entityId.localeCompare(b.entityId),
  );

  return {
    results: merged.slice(filters.offset, filters.offset + filters.limit),
    total,
    limit: filters.limit,
    offset: filters.offset,
    query: filters.query,
  };
}

/** Re-exported for the route and tests. */
export { isSearchEntityType, SEARCH_ENTITY_TYPES };
export type { SearchEntityType, SearchFilters, SearchResponse, SearchResult };
