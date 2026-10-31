import type { SearchEntityType, SearchResponse } from '@/lib/search/types';

/**
 * searchApi — browser-side client for GET /api/search (Phase 8, Workstream D).
 *
 * Contract (§16.7): `GET /api/search?q=&type=&limit=&offset=`. The server
 * enforces validation (400 INVALID_REQUEST), authentication (401) and
 * authorization (403); per-entity results are already permission-filtered by
 * the API, so the UI must only render what this returns — never supplement
 * it from another source.
 *
 * Privacy: responses are held in memory only. Nothing is persisted
 * (no localStorage/sessionStorage cache), so one user's results can never
 * leak to another user of the same browser.
 */

export type SearchApiErrorCode =
  'INVALID_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'REQUEST_FAILED' | 'SERVER_ERROR';

export class SearchApiError extends Error {
  readonly code: SearchApiErrorCode;
  readonly status: number;

  constructor(code: SearchApiErrorCode, status: number, message: string) {
    super(message);
    this.name = 'SearchApiError';
    this.code = code;
    this.status = status;
  }
}

export interface SearchApiOptions {
  /** Entity-type allowlist; unknown types are dropped client-side (server re-validates). */
  types?: SearchEntityType[];
  /** Page size. Clamped to the server's 1-50 range; the server enforces the max. */
  limit?: number;
  /** Offset for pagination. */
  offset?: number;
  /** AbortSignal to cancel in-flight typeahead requests. */
  signal?: AbortSignal;
}

const MAX_LIMIT = 50;

/** Builds the /api/search URL. Exported for tests. */
export function buildSearchUrl(query: string, options: SearchApiOptions = {}): string {
  const params = new URLSearchParams();
  params.set('q', query);
  for (const t of options.types ?? []) params.append('type', t);
  const limit = Math.min(Math.max(options.limit ?? 20, 1), MAX_LIMIT);
  params.set('limit', String(limit));
  if (options.offset) params.set('offset', String(Math.max(0, options.offset)));
  return `/api/search?${params.toString()}`;
}

export async function searchApi(
  query: string,
  options: SearchApiOptions = {},
): Promise<SearchResponse> {
  const trimmed = query.trim();
  if (trimmed === '') {
    throw new SearchApiError('INVALID_REQUEST', 400, 'Search query must not be empty.');
  }

  let response: Response;
  try {
    response = await fetch(buildSearchUrl(trimmed, options), {
      headers: { Accept: 'application/json' },
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new SearchApiError('REQUEST_FAILED', 0, 'Could not reach the search service.');
  }

  if (response.ok) {
    return (await response.json()) as SearchResponse;
  }

  let detail = '';
  try {
    const body = (await response.json()) as { message?: string };
    if (typeof body?.message === 'string') detail = body.message;
  } catch {
    // Non-JSON error body; fall through to generic messages.
  }

  switch (response.status) {
    case 400:
      throw new SearchApiError('INVALID_REQUEST', 400, detail || 'The search request was invalid.');
    case 401:
      throw new SearchApiError(
        'UNAUTHORIZED',
        401,
        'Your session has expired. Sign in again to search.',
      );
    case 403:
      throw new SearchApiError('FORBIDDEN', 403, 'You do not have permission to search.');
    default:
      throw new SearchApiError(
        'SERVER_ERROR',
        response.status,
        detail || 'Search is temporarily unavailable. Please try again.',
      );
  }
}
