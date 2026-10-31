'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Search, SearchX } from 'lucide-react';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { cn } from '@/lib/utils';
import type { SearchResult } from '@/lib/search/types';
import { ENTITY_META } from './entity-meta';
import { sanitizeResultUrl } from './sanitize';
import { SearchApiError, searchApi } from './search-client';

/**
 * GlobalSearch — header typeahead (Phase 8, Workstream D).
 *
 * Client-component leaf mounted in the header center (app-shell.tsx).
 * Contract (§16.9): 300ms debounce, arrow/Enter/Escape keyboard navigation,
 * permission-safe (renders only what GET /api/search returns — the API
 * filters per-entity by the caller's view permissions, §16.6).
 *
 * Privacy: results live in component state only; nothing is written to
 * storage, so results can never leak across users of the same browser.
 */

const TYPEAHEAD_LIMIT = 8;
const MIN_CHARS = 2;

interface NavigableResult {
  result: SearchResult;
  /** Null when there is no safe destination — choosing it falls back to the results page. */
  href: string | null;
}

export function GlobalSearch() {
  const router = useRouter();
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NavigableResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [failed, setFailed] = useState(false);

  const debouncedQuery = useDebouncedValue(query.trim(), 300);

  // Typeahead fetch on the debounced query; stale requests are aborted so a
  // slow response can never overwrite newer results.
  useEffect(() => {
    abortRef.current?.abort();
    if (debouncedQuery.length < MIN_CHARS) {
      setResults([]);
      setLoading(false);
      setFailed(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setFailed(false);
    searchApi(debouncedQuery, { limit: TYPEAHEAD_LIMIT, signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        const navigable: NavigableResult[] = [];
        for (const result of response.results) {
          // Person results have no detail page (the API emits
          // `/admin/users/<id>`, which resolves to nothing), and the
          // typeahead runs client-side with no permission context to decide
          // the graceful `users.view` fallback. Keep the row visible (it is a
          // legitimate, permission-filtered hit) but non-navigable here:
          // choosing it falls back to the results page, where the server
          // renders the correct link-or-no-link treatment.
          const href = result.entityType === 'person' ? null : sanitizeResultUrl(result.url);
          navigable.push({ result, href });
        }
        setResults(navigable);
        setActiveIndex(-1);
        setOpen(true);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        // 401/403: session or permission problem — close quietly, never show
        // another user's data or an auth-shaped error in the header.
        if (
          error instanceof SearchApiError &&
          (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN')
        ) {
          setResults([]);
          setOpen(false);
        } else {
          setFailed(true);
          setOpen(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [debouncedQuery]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const goToResultsPage = useCallback(
    (q: string) => {
      const trimmed = q.trim();
      if (trimmed === '') return;
      setOpen(false);
      inputRef.current?.blur();
      router.push(`/search?q=${encodeURIComponent(trimmed)}`);
    },
    [router],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const active = open && activeIndex >= 0 ? results[activeIndex] : undefined;
      if (active?.href) {
        setOpen(false);
        inputRef.current?.blur();
        router.push(active.href);
      } else {
        // No active suggestion, or the active row has no safe destination
        // (e.g. a person hit) — the results page handles it gracefully.
        goToResultsPage(query);
      }
    } else if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        setOpen(false);
        setActiveIndex(-1);
      } else {
        setQuery('');
      }
    }
  };

  const showDropdown = open && query.trim().length >= MIN_CHARS;
  const activeId = activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;

  return (
    <div ref={rootRef} className="relative w-full max-w-md">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          goToResultsPage(query);
        }}
      >
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
          aria-hidden
        />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={listboxId}
          aria-activedescendant={activeId}
          aria-label="Search Pravshi OS"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search contacts, deals, tasks…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (results.length > 0 || failed) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className="h-9 w-full rounded-md border border-rule bg-surface pl-9 pr-9 text-sm text-ink placeholder:text-ink-muted focus:border-ink-muted focus:outline-none"
        />
        {loading && (
          <Loader2
            className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-ink-muted"
            aria-hidden
          />
        )}
      </form>

      {showDropdown && (
        <div className="absolute inset-x-0 top-11 z-50 overflow-hidden rounded-md border border-rule bg-surface shadow-lg">
          {failed ? (
            <div className="flex items-center gap-2 px-4 py-3 text-sm text-ink-muted">
              <SearchX className="h-4 w-4" aria-hidden />
              Search is unavailable right now. Press Enter to try the results page.
            </div>
          ) : results.length === 0 && !loading ? (
            <div className="px-4 py-3 text-sm text-ink-muted">
              No matches. Press Enter to search anyway.
            </div>
          ) : (
            <ul
              role="listbox"
              id={listboxId}
              aria-label="Search suggestions"
              className="max-h-80 overflow-y-auto py-1"
            >
              {results.map(({ result, href }, index) => {
                const meta = ENTITY_META[result.entityType];
                const Icon = meta.icon;
                const active = index === activeIndex;
                return (
                  <li
                    key={`${result.entityType}:${result.entityId}`}
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={active}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        if (href) {
                          setOpen(false);
                          router.push(href);
                        } else {
                          goToResultsPage(query);
                        }
                      }}
                      onMouseEnter={() => setActiveIndex(index)}
                      className={cn(
                        'flex w-full items-center gap-3 px-4 py-2 text-left',
                        active && 'bg-ink/5',
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden />
                      <span className="min-w-0 flex-1">
                        {/* Titles render as text — React escapes them (no dangerouslySetInnerHTML). */}
                        <span className="block truncate text-sm text-ink">{result.title}</span>
                        {result.subtitle && (
                          <span className="block truncate text-xs text-ink-muted">
                            {result.subtitle}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-[11px] uppercase tracking-wide text-ink-muted">
                        {meta.label}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => goToResultsPage(query)}
            className="flex w-full items-center gap-2 border-t border-rule px-4 py-2 text-sm text-ink-muted hover:bg-ink/5 hover:text-ink"
          >
            <Search className="h-3.5 w-3.5" aria-hidden />
            View all results for &ldquo;{query.trim()}&rdquo;
          </button>
        </div>
      )}
    </div>
  );
}
