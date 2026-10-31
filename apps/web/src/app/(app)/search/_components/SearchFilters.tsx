'use client';

import { usePathname, useRouter } from 'next/navigation';
import { SEARCH_ENTITY_TYPES, type SearchEntityType } from '@/lib/search/types';
import { ENTITY_META } from '@/components/search/entity-meta';
import { cn } from '@/lib/utils';

/**
 * SearchFilters — entity-type filter chips for /search (Phase 8, Workstream D).
 *
 * Client component. Toggling a chip rewrites the `type` URL params (the page
 * re-renders server-side with the new allowlist); `q` is preserved. "All"
 * clears every type filter. Unknown types can never enter the URL because
 * chips are built from the closed 8-type union.
 */
export function SearchFilters({
  query,
  activeTypes,
}: {
  query: string;
  activeTypes: SearchEntityType[];
}) {
  const router = useRouter();
  const pathname = usePathname();

  const applyTypes = (types: SearchEntityType[]) => {
    const params = new URLSearchParams();
    if (query !== '') params.set('q', query);
    for (const t of types) params.append('type', t);
    const qs = params.toString();
    router.push(qs === '' ? pathname : `${pathname}?${qs}`);
  };

  const toggle = (type: SearchEntityType) => {
    if (activeTypes.includes(type)) {
      applyTypes(activeTypes.filter((t) => t !== type));
    } else {
      applyTypes([...activeTypes, type]);
    }
  };

  const chip = (pressed: boolean, onClick: () => void, label: string, key: string) => (
    <button
      key={key}
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        pressed
          ? 'border-ink bg-ink text-surface'
          : 'border-rule bg-surface text-ink-muted hover:border-ink-muted hover:text-ink',
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by type">
      {chip(activeTypes.length === 0, () => applyTypes([]), 'All', 'all')}
      {SEARCH_ENTITY_TYPES.map((type) => {
        const meta = ENTITY_META[type];
        const Icon = meta.icon;
        return (
          <button
            key={type}
            type="button"
            aria-pressed={activeTypes.includes(type)}
            onClick={() => toggle(type)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              activeTypes.includes(type)
                ? 'border-ink bg-ink text-surface'
                : 'border-rule bg-surface text-ink-muted hover:border-ink-muted hover:text-ink',
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {meta.plural}
          </button>
        );
      })}
    </div>
  );
}
