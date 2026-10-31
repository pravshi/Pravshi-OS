import Link from 'next/link';
import { Lock } from 'lucide-react';
import type { SearchResult } from '@/lib/search/types';
import { ENTITY_META } from '@/components/search/entity-meta';
import { personResultUrl, sanitizeResultUrl } from '@/components/search/sanitize';
import { cn } from '@/lib/utils';

/**
 * ResultCard — one search hit (Phase 8, Workstream D). Server component.
 *
 * SAFE NAVIGATION (contract note from Workstream B + XSS risk):
 * - Every `url` from the API passes through sanitizeResultUrl: only
 *   same-origin app paths become links. Anything else renders as a static
 *   card, so a malformed/compromised URL can never drive navigation.
 * - `person` hits have no detail page: viewers WITH `users.view` link to the
 *   users list; viewers WITHOUT it get a static card (a link would only
 *   bounce them to /access-denied).
 *
 * XSS: title, subtitle and metadata render as React text — never
 * dangerouslySetInnerHTML — so attacker-influenced strings are escaped.
 */

/** Metadata entries safe to show: scalar values only, capped at 3. */
function metadataChips(metadata: SearchResult['metadata']): Array<{ key: string; value: string }> {
  if (!metadata || typeof metadata !== 'object') return [];
  const chips: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (chips.length >= 3) break;
    if (typeof value === 'string' && value.trim() !== '') {
      chips.push({ key: prettifyKey(key), value: value.trim() });
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      chips.push({ key: prettifyKey(key), value: String(value) });
    }
  }
  return chips;
}

function prettifyKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ResultCard({
  result,
  canViewUsers,
}: {
  result: SearchResult;
  canViewUsers: boolean;
}) {
  const meta = ENTITY_META[result.entityType];
  const Icon = meta.icon;
  const href =
    result.entityType === 'person' ? personResultUrl(canViewUsers) : sanitizeResultUrl(result.url);
  const chips = metadataChips(result.metadata);

  const body = (
    <span className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-rule bg-surface">
        <Icon className="h-4 w-4 text-ink-muted" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        {/* Text only — React escapes it. */}
        <span className="block truncate text-sm font-medium text-ink">{result.title}</span>
        {result.subtitle && (
          <span className="block truncate text-xs text-ink-muted">{result.subtitle}</span>
        )}
        {chips.length > 0 && (
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {chips.map((chip, i) => (
              <span
                key={`${chip.key}-${i}`}
                className="inline-flex max-w-full items-center gap-1 rounded border border-rule px-1.5 py-0.5 text-[11px] text-ink-muted"
              >
                <span className="shrink-0 font-medium">{chip.key}:</span>
                <span className="truncate">{chip.value}</span>
              </span>
            ))}
          </span>
        )}
      </span>
      {href ? (
        <span className="shrink-0 text-[11px] uppercase tracking-wide text-ink-muted">
          {meta.label}
        </span>
      ) : (
        <span
          className="flex shrink-0 items-center gap-1 text-[11px] text-ink-muted"
          title="You can see this result but cannot open it"
        >
          <Lock className="h-3 w-3" aria-hidden />
          {meta.label}
        </span>
      )}
    </span>
  );

  return (
    <li>
      {href ? (
        <Link
          href={href}
          className={cn(
            'block transition-colors hover:bg-ink/[0.04] focus-visible:bg-ink/[0.04] focus-visible:outline-none',
          )}
        >
          {body}
        </Link>
      ) : (
        <div className="cursor-default">{body}</div>
      )}
    </li>
  );
}
