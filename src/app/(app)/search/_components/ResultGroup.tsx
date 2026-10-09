import type { SearchEntityType, SearchResult } from '@/lib/search/types';
import { ENTITY_META } from '@/components/search/entity-meta';
import { ResultCard } from './ResultCard';

/**
 * ResultGroup — one entity section on the results page (Phase 8, Workstream D).
 * Server component. Order within the group is the API's relevance order.
 */
export function ResultGroup({
  entityType,
  results,
  canViewUsers,
}: {
  entityType: SearchEntityType;
  results: SearchResult[];
  canViewUsers: boolean;
}) {
  const meta = ENTITY_META[entityType];
  const Icon = meta.icon;

  return (
    <section aria-label={meta.plural}>
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-4 w-4 text-ink-muted" aria-hidden />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {meta.plural}
        </h2>
        <span className="rounded-full border border-rule px-1.5 text-[11px] text-ink-muted">
          {results.length}
        </span>
      </div>
      <ul className="divide-y divide-rule overflow-hidden rounded-lg border border-rule bg-surface">
        {results.map((result) => (
          <ResultCard
            key={`${result.entityType}:${result.entityId}`}
            result={result}
            canViewUsers={canViewUsers}
          />
        ))}
      </ul>
    </section>
  );
}
