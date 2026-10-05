'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { WORKFLOW_STATUSES } from '@/lib/workflows/schema';
import { WORKFLOW_STATUS_LABELS, type WorkflowStatus } from '../_types';

const selectClasses =
  'rounded-md border border-line bg-white px-3 py-2 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

/** Search + status filter for the workflows list page. Navigates via ?q= & ?status= URL params. */
export function WorkflowSearchForm({
  initialQuery,
  initialStatus,
}: {
  initialQuery: string;
  initialStatus: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(initialQuery);
  const [status, setStatus] = useState(initialStatus);

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams(searchParams.toString());
    const q = query.trim();
    if (q) params.set('q', q);
    else params.delete('q');
    if (status) params.set('status', status);
    else params.delete('status');
    router.push(`/workflows?${params.toString()}`);
  }

  return (
    <form onSubmit={onSearch} className="flex flex-1 flex-wrap items-center gap-2">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search workflows by name…"
        aria-label="Search workflows"
        className="flex-1 sm:max-w-xs"
      />
      <select
        aria-label="Filter by status"
        className={selectClasses}
        value={status}
        onChange={(e) => setStatus(e.target.value)}
      >
        <option value="">All statuses</option>
        {WORKFLOW_STATUSES.map((s: WorkflowStatus) => (
          <option key={s} value={s}>
            {WORKFLOW_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <Button type="submit" variant="outline">
        Search
      </Button>
    </form>
  );
}
