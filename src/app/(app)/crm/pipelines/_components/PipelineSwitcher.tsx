'use client';

import { useRouter } from 'next/navigation';
import type { PipelineListRow } from '@/components/crm/types';

/** Jump between pipelines without going back to the list. */
export function PipelineSwitcher({
  pipelines,
  currentId,
}: {
  pipelines: PipelineListRow[];
  currentId: string;
}) {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-ink-muted">Pipeline</span>
      <select
        value={currentId}
        onChange={(e) => {
          if (e.target.value !== currentId) router.push(`/crm/pipelines/${e.target.value}`);
        }}
        className="max-w-64 rounded-md border border-line bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:bg-input/30"
        aria-label="Switch pipeline"
      >
        {pipelines.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.isDefault ? ' (default)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
