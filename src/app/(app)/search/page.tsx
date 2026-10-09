import { Suspense } from 'react';
import { requirePagePermission } from '@/lib/authz/page';
import { EmptyState } from '@/components/state/empty-state';
import { LoadingState } from '@/components/state/loading-state';
import { parseTypeParams } from '@/components/search/search-params';
import { SearchFilters } from './_components/SearchFilters';
import { SearchResults } from './_components/SearchResults';

/**
 * /search — full search results page (Phase 8, Workstream D).
 *
 * Async Server Component. `requirePagePermission('people.view')` mirrors the
 * base permission of GET /api/search (contract §16.7): it admits any active
 * employee and no one else; per-entity filtering happens inside the API.
 * Results stream in behind Suspense while the filters render immediately.
 * URL params: `?q=` (query) and `?type=` (entity allowlist, §16.2).
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string | string[] }>;
}) {
  await requirePagePermission('people.view');

  const params = await searchParams;
  const q = (params.q ?? '').trim();
  const types = parseTypeParams(params.type);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Search across contacts, companies, deals, projects, tasks, activities, workflows, and
          people. You only see results you have permission to view.
        </p>
      </div>

      <SearchFilters query={q} activeTypes={types} />

      {q === '' ? (
        <EmptyState
          title="Search Pravshi OS"
          description="Type in the search box in the header, or add ?q= to the URL. Results respect your permissions — you only ever see what you are allowed to view."
        />
      ) : (
        <Suspense key={`${q}|${types.join(',')}`} fallback={<LoadingState rows={6} />}>
          <SearchResults query={q} types={types} />
        </Suspense>
      )}
    </div>
  );
}
