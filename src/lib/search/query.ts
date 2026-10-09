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
 * - pg_trgm: when the extension is present (migration 0053), fuzzy term
 *   matching uses `word_similarity()` at the strict threshold from
 *   ranking.ts and relevance adds whole-query `similarity()`; without it the
 *   ILIKE term matching still answers correctly, just without fuzzy hits.
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

  // Matching semantics (tightened during Phase 8 DB verification, 2026-10-09):
  //
  // 1. Term-AND: the query splits into whitespace terms and EVERY term must
  //    match at least one searchable column (different terms may match
  //    different columns). A query that pads a real token with garbage terms
  //    therefore matches nothing — the whole-query trigram comparison used
  //    before scored such a query 0.733 against the bare token and returned
  //    rows the user never asked for.
  // 2. A term matches literally (escaped ILIKE substring) or, when fuzzy
  //    matching is enabled, by word_similarity() at the strict threshold in
  //    ranking.ts: at pg_trgm's loose 0.3 default a one-character-different
  //    code scored 0.571 and "found" the other tenant's token shape in the
  //    caller's own rows (§35 tests pin this to zero results).
  // 3. A query containing LIKE wildcards (`%`, `_`) or the escape character
  //    disables fuzzy matching entirely and is matched purely literally, so
  //    wildcard-shaped input can never widen a search (§35).
  const terms = q.split(/\s+/).filter((t) => t.length > 0);
  const fuzzy = hasTrgm && !/[%_\\]/.test(q);

  const termSubstring = (term: string): SQL => {
    const like = escapeLikePattern(term);
    return sql.join(
      cols.map((c) => sql`e.${c} ilike '%' || ${like} || '%' escape '\'`),
      sql` or `,
    );
  };
  const termFuzzy = (term: string): SQL =>
    sql.join(
      cols.map(
        (c) => sql`word_similarity(${term}, e.${c}) >= ${TRIGRAM_SIMILARITY_THRESHOLD}::float8`,
      ),
      sql` or `,
    );
  const termMatch = (term: string): SQL =>
    fuzzy ? sql`(${termSubstring(term)} or ${termFuzzy(term)})` : sql`(${termSubstring(term)})`;
  const allTermsMatch = sql.join(terms.map(termMatch), sql` and `);

  // Per-term score: best column for that term — substring tier when literal,
  // scaled word similarity when fuzzy — and the row's term score is the
  // WEAKEST term's score (least), so every term pulls its weight.
  const termScore = (term: string): SQL => {
    const like = escapeLikePattern(term);
    const perCol = cols.map((c) =>
      fuzzy
        ? sql`case
                when e.${c} ilike '%' || ${like} || '%' escape '\' then ${SCORE_SUBSTRING}::float8
                when word_similarity(${term}, e.${c}) >= ${TRIGRAM_SIMILARITY_THRESHOLD}::float8
                  then word_similarity(${term}, e.${c}) * ${SCORE_TRIGRAM_SCALE}::float8
                else 0::float8
              end`
        : sql`case when e.${c} ilike '%' || ${like} || '%' escape '\' then ${SCORE_SUBSTRING}::float8 else 0::float8 end`,
    );
    return sql`greatest(${sql.join(perCol, sql`, `)})`;
  };
  const termsScore = sql`least(${sql.join(terms.map(termScore), sql`, `)})`;

  const trigramSim: SQL = fuzzy
    ? sql`greatest(${sql.join(
        cols.map((c) => sql`similarity(e.${c}, ${q})`),
        sql`, `,
      )})`
    : sql`0`;

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
        case when ${substring} then ${SCORE_SUBSTRING}::float8 else 0::float8 end,
        ${termsScore}
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
      and (${allTermsMatch})
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
