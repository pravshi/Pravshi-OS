'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { JOB_STATUSES, JOB_STATUS_LABELS, JOB_TYPES, JOB_TYPE_LABELS } from '../_jobs';

const selectClasses =
  'rounded-md border border-line bg-white px-3 py-2 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

/** Status + type filter for the jobs dashboard. Navigates via ?status= & ?type= URL params. */
export function JobFilterForm({
  initialStatus,
  initialType,
}: {
  initialStatus: string;
  initialType: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState(initialStatus);
  const [type, setType] = useState(initialType);

  function onFilter(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams(searchParams.toString());
    if (status) params.set('status', status);
    else params.delete('status');
    if (type) params.set('type', type);
    else params.delete('type');
    const qs = params.toString();
    router.push(`/jobs${qs ? `?${qs}` : ''}`);
  }

  function onClear() {
    setStatus('');
    setType('');
    router.push('/jobs');
  }

  return (
    <form onSubmit={onFilter} className="flex flex-1 flex-wrap items-center gap-2">
      <select
        aria-label="Filter by status"
        className={selectClasses}
        value={status}
        onChange={(e) => setStatus(e.target.value)}
      >
        <option value="">All statuses</option>
        {JOB_STATUSES.map((s) => (
          <option key={s} value={s}>
            {JOB_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <select
        aria-label="Filter by type"
        className={selectClasses}
        value={type}
        onChange={(e) => setType(e.target.value)}
      >
        <option value="">All types</option>
        {JOB_TYPES.map((t) => (
          <option key={t} value={t}>
            {JOB_TYPE_LABELS[t]}
          </option>
        ))}
      </select>
      <Button type="submit" variant="outline" size="sm">
        Filter
      </Button>
      {(initialStatus || initialType) && (
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          Clear
        </Button>
      )}
    </form>
  );
}
