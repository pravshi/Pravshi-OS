/**
 * Search relevance tiers — Phase 8 Search & Notifications (Workstream B).
 *
 * Contract §16.2: "Relevance: deterministic — exact match > prefix > trigram
 * similarity. Score 0-1." The tiers below are the single source of truth for
 * both the pure classification helpers (unit-tested here) and the SQL score
 * expression built in query.ts, so the two cannot drift apart.
 */

/** Match classes in descending rank order. */
export type MatchClass = 'exact' | 'prefix' | 'trigram' | 'substring' | 'none';

/** Fixed tier scores. Trigram is the only tier that varies (similarity * 0.7). */
export const SCORE_EXACT = 1.0;
export const SCORE_PREFIX = 0.8;
export const SCORE_TRIGRAM_SCALE = 0.7;
export const SCORE_SUBSTRING = 0.5;
export const SCORE_NONE = 0.0;

/** Upper bound of the trigram tier: it must never outrank a prefix match. */
export const SCORE_TRIGRAM_MAX = SCORE_TRIGRAM_SCALE; // 0.7 < 0.8 = SCORE_PREFIX

/**
 * Trigram acceptance threshold — deliberately stricter than pg_trgm's 0.3
 * default. Measured on the live database (Phase 8 DB verification,
 * 2026-10-09): at 0.3, per-column similarity produces false positives on
 * short strings — a one-character-different lookup code scores 0.571, a
 * title sharing one word with the query scores 0.591, and a query padded
 * with a repeated character scores 0.733 against the embedded token. At 0.6
 * those are all rejected while genuine typos still match (word_similarity
 * 'Alica' -> 'Alicia' = 0.667). Precision wins over recall here: a CRM
 * search that returns the wrong records destroys trust in the results.
 */
export const TRIGRAM_SIMILARITY_THRESHOLD = 0.6;

const norm = (s: string): string => s.toLocaleLowerCase();

/**
 * Pure, deterministic classification of one searchable field against the query.
 * Case-insensitive; the query must already be trimmed and non-empty.
 */
export function classifyField(field: string, query: string): MatchClass {
  const f = norm(field);
  const q = norm(query);
  if (f === q) return 'exact';
  if (f.startsWith(q)) return 'prefix';
  if (f.includes(q)) return 'substring';
  return 'none';
}

/**
 * Pure score for a classified match. `similarity` is the pg_trgm similarity
 * (0..1) for the 'trigram' class only; anything else ignores it.
 * Returns a value in [0, 1], rounded to 4 decimals for stability.
 */
export function scoreForClass(match: MatchClass, similarity?: number): number {
  switch (match) {
    case 'exact':
      return SCORE_EXACT;
    case 'prefix':
      return SCORE_PREFIX;
    case 'trigram': {
      const sim =
        typeof similarity === 'number' && Number.isFinite(similarity)
          ? Math.min(1, Math.max(0, similarity))
          : 0;
      if (sim < TRIGRAM_SIMILARITY_THRESHOLD) return SCORE_NONE;
      return round4(sim * SCORE_TRIGRAM_SCALE);
    }
    case 'substring':
      return SCORE_SUBSTRING;
    case 'none':
      return SCORE_NONE;
  }
}

/**
 * Rank of a match class: higher is better. Used to take the best class across
 * an entity's searchable fields before scoring (exact beats prefix regardless
 * of which field matched).
 */
export function classRank(match: MatchClass): number {
  switch (match) {
    case 'exact':
      return 4;
    case 'prefix':
      return 3;
    case 'trigram':
      return 2;
    case 'substring':
      return 1;
    case 'none':
      return 0;
  }
}

/**
 * Escape the LIKE wildcards (`%`, `_`) and the escape character itself so the
 * query is matched literally. The value still travels as a bound parameter —
 * this is about wildcard semantics, not injection (parameterization handles
 * quotes). The SQL must declare `escape '\'` on every ILIKE that uses it.
 */
export function escapeLikePattern(query: string): string {
  return query.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
