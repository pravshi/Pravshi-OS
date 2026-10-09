import { isSearchEntityType, type SearchEntityType } from '@/lib/search/types';

/**
 * Parses the `type` URL param for the search results page.
 *
 * Accepts a single `?type=deal`, repeated `?type=deal&type=task`, or
 * comma-separated `?type=deal,task` (mirroring the API). Unknown values are
 * dropped against the strict 8-type allowlist (contract §16.2) — never
 * passed through to the API.
 */
export function parseTypeParams(raw: string | string[] | undefined): SearchEntityType[] {
  const chunks = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const out: SearchEntityType[] = [];
  for (const chunk of chunks) {
    for (const part of chunk.split(',')) {
      const candidate = part.trim();
      if (isSearchEntityType(candidate) && !out.includes(candidate)) {
        out.push(candidate);
      }
    }
  }
  return out;
}
