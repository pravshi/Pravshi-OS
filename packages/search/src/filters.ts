/**
 * Search filter validation — Phase 8 Search & Notifications (Workstream B).
 *
 * Contract §16.2, server-side and DB-free:
 * - `query`: trimmed, 1-200 chars, rejected when empty after trim.
 * - `entityTypes`: strict allowlist of the 8 approved types (no 'lead');
 *   accepts `?type=deal`, repeated `?type=` params, or `?type=deal,task`.
 * - `limit`: default 20, max 50, server-enforced — the client is never trusted.
 * - `offset`: default 0.
 * - `status`: optional entity-specific value, allowlisted per entity in query.ts.
 * - `ownerId`: optional UUID, tenant-checked against the caller's org in query.ts.
 */
import { z } from 'zod';

/** zod enum needs a tuple; kept in sync with SEARCH_ENTITY_TYPES (see entities test). */
const ENTITY_TYPE_TUPLE = [
  'contact',
  'company',
  'deal',
  'project',
  'task',
  'activity',
  'workflow',
  'person',
] as const;

/** Accepts `?type=deal`, `?type=deal&type=task`, or `?type=deal,task`. */
const entityTypesInput = z.preprocess(
  (value) => {
    if (value === undefined || value === null) return undefined;
    const list = Array.isArray(value) ? value : [value];
    const split = list.flatMap((v) => (typeof v === 'string' ? v.split(',') : [v]));
    const trimmed = split.map((v) => (typeof v === 'string' ? v.trim() : v));
    return trimmed.length === 0 ? undefined : trimmed;
  },
  z.array(z.enum(ENTITY_TYPE_TUPLE)).optional(),
);

export const SearchFiltersSchema = z.strictObject({
  query: z.string().trim().min(1, 'query is required').max(200, 'query is too long'),
  entityTypes: entityTypesInput,
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.string().trim().min(1).max(64).optional(),
  ownerId: z.string().uuid('ownerId must be a UUID').optional(),
});

export type ParsedSearchFilters = z.infer<typeof SearchFiltersSchema>;
