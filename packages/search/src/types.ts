/**
 * Search types — Phase 8 Search & Notifications (Workstream B).
 *
 * Implements the Lead Architect contract review §16.1 (Search Result, REVISED)
 * and §16.2 (Search Filter, APPROVED). The review SUPERSEDES the draft audit:
 * there is NO 'lead' entity type — leads are represented via
 * contacts/companies/deals with status fields (audit §2.2), and a 'lead'
 * union member would invite a fake implementation.
 */

/** Approved entity types, §16.1. Closed union — 'lead' is deliberately absent. */
export type SearchEntityType =
  'contact' | 'company' | 'deal' | 'project' | 'task' | 'activity' | 'workflow' | 'person';

/** The eight approved types in a stable order (used for deterministic iteration). */
export const SEARCH_ENTITY_TYPES: readonly SearchEntityType[] = Object.freeze([
  'contact',
  'company',
  'deal',
  'project',
  'task',
  'activity',
  'workflow',
  'person',
]);

export function isSearchEntityType(value: unknown): value is SearchEntityType {
  return typeof value === 'string' && (SEARCH_ENTITY_TYPES as readonly string[]).includes(value);
}

/** One ranked hit. Relevance is deterministic: exact > prefix > trigram similarity (§16.2). */
export interface SearchResult {
  entityType: SearchEntityType;
  entityId: string;
  title: string;
  subtitle?: string;
  metadata?: Record<string, unknown>;
  /** 0..1, computed by src/lib/search/ranking.ts tiers. */
  relevance: number;
  /** Frontend deep link, e.g. `/crm/contacts/<id>`. */
  url: string;
}

/**
 * Validated global-search filters, §16.2.
 * `query`: trimmed, 1-200 chars, rejected when empty after trim.
 * `entityTypes`: strict allowlist of the 8 approved types; unknown values rejected.
 * `limit`: default 20, max 50, server-enforced — the client is never trusted.
 * `ownerId`: a person UUID, tenant-checked against the caller's org before use.
 */
export interface SearchFilters {
  query: string;
  entityTypes?: SearchEntityType[];
  limit: number;
  offset: number;
  status?: string;
  ownerId?: string;
}

/**
 * Envelope returned by GET /api/search.
 *
 * `total` is the sum of per-entity totals across entities the caller may view.
 * Per-entity counts are never exposed: a caller without e.g. `deals.view`
 * learns nothing about deals — not results, not counts, not snippets (§16.6).
 */
export interface SearchResponse {
  results: SearchResult[];
  total: number;
  limit: number;
  offset: number;
  query: string;
}
