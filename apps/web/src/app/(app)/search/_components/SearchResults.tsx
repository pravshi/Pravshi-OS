import { headers } from 'next/headers';
import { sql } from 'drizzle-orm';
import { withAuthorizedDb } from '@/lib/db/authorized';
import { requireAuthenticated } from '@/lib/authz/page';
import {
  SEARCH_ENTITY_TYPES,
  type SearchEntityType,
  type SearchResponse,
  type SearchResult,
} from '@/lib/search/types';
import { EmptyState } from '@/components/state/empty-state';
import { ErrorState } from '@/components/state/error-state';
import { ResultGroup } from './ResultGroup';

/**
 * SearchResults — async Server Component that performs the search (Phase 8, Workstream D).
 *
 * API INTEGRATION (contract §16.7): the page talks to GET /api/search over
 * HTTP — the same route and the same permission/filtering path as every
 * other API consumer — rather than calling search internals directly. The
 * request's own host and session cookie are forwarded, so the API
 * authorizes exactly as the viewing user (no Origin header is sent, which
 * satisfies the route's CSRF check for non-browser requests).
 *
 * Error mapping: 400 → invalid-query state, 401/403 → auth state (no
 * leakage), anything else → generic failure state.
 */

const PAGE_LIMIT = 20;

type FetchOutcome =
  | { ok: true; data: SearchResponse }
  | { ok: false; kind: 'invalid'; message: string }
  | { ok: false; kind: 'auth' }
  | { ok: false; kind: 'server' };

async function fetchSearchResults(query: string, types: SearchEntityType[]): Promise<FetchOutcome> {
  const h = await headers();
  const host = h.get('host');
  if (!host) return { ok: false, kind: 'server' };

  const forwardedProto = h.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const url = new URL('/api/search', `${forwardedProto || 'http'}://${host}`);
  url.searchParams.set('q', query);
  for (const t of types) url.searchParams.append('type', t);
  url.searchParams.set('limit', String(PAGE_LIMIT));

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { cookie: h.get('cookie') ?? '' },
      cache: 'no-store',
    });
  } catch {
    return { ok: false, kind: 'server' };
  }

  if (response.ok) {
    return { ok: true, data: (await response.json()) as SearchResponse };
  }
  if (response.status === 400) {
    let message = 'The search query was not valid.';
    try {
      const body = (await response.json()) as { message?: string };
      if (typeof body?.message === 'string' && body.message !== '') message = body.message;
    } catch {
      // keep the generic message
    }
    return { ok: false, kind: 'invalid', message };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, kind: 'auth' };
  }
  return { ok: false, kind: 'server' };
}

/**
 * Non-throwing `users.view` check for person-result link treatment.
 * Uses authz.has() directly (like nav.ts) so a missing grant renders a
 * non-link card instead of redirecting to /access-denied.
 */
async function canViewUsers(): Promise<boolean> {
  const ctx = await requireAuthenticated();
  return withAuthorizedDb(ctx, async (tx) => {
    const res = await tx.execute<{ held: boolean }>(sql`select authz.has('users.view') as held`);
    return res.rows[0]?.held ?? false;
  });
}

export async function SearchResults({
  query,
  types,
}: {
  query: string;
  types: SearchEntityType[];
}) {
  const [outcome, usersView] = await Promise.all([
    fetchSearchResults(query, types),
    canViewUsers(),
  ]);

  if (!outcome.ok) {
    if (outcome.kind === 'invalid') {
      return <ErrorState title="Invalid search" detail={outcome.message} />;
    }
    if (outcome.kind === 'auth') {
      return (
        <ErrorState
          title="Search unavailable"
          detail="Your session could not be verified for search. Try signing in again."
        />
      );
    }
    return (
      <ErrorState
        title="Search failed"
        detail="Something went wrong while searching. Please try again."
      />
    );
  }

  const { results, total } = outcome.data;

  if (results.length === 0) {
    return (
      <EmptyState
        title={`No results for \u201c${query}\u201d`}
        description="Try a different spelling, fewer words, or clear the type filters to search everything."
      />
    );
  }

  // Group by entity, preserving the API's relevance order within each group;
  // groups render in the canonical 8-type order.
  const groups = new Map<SearchEntityType, SearchResult[]>();
  for (const result of results) {
    const group = groups.get(result.entityType) ?? [];
    group.push(result);
    groups.set(result.entityType, group);
  }

  return (
    <div className="space-y-8">
      <p className="text-sm text-ink-muted" aria-live="polite">
        {total} result{total === 1 ? '' : 's'} for &ldquo;{query}&rdquo;
        {total > results.length ? ` (showing first ${results.length})` : ''}
      </p>
      {SEARCH_ENTITY_TYPES.filter((t) => groups.has(t)).map((t) => (
        <ResultGroup
          key={t}
          entityType={t}
          results={groups.get(t) ?? []}
          canViewUsers={usersView}
        />
      ))}
    </div>
  );
}
