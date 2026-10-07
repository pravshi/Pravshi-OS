'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { DATE_RANGE_PRESETS } from '@/lib/analytics/date-ranges';
import type { DateRangePreset } from '@/lib/analytics/types';

/** Human labels for the canonical presets. */
const PRESET_LABELS: Record<DateRangePreset, string> = {
  TODAY: 'Today',
  LAST_7_DAYS: 'Last 7 days',
  LAST_30_DAYS: 'Last 30 days',
  THIS_MONTH: 'This month',
  LAST_MONTH: 'Last month',
  THIS_QUARTER: 'This quarter',
  THIS_YEAR: 'This year',
  CUSTOM: 'Custom range',
};

/**
 * Date-range preset selector. Writes ?range=PRESET[&from=YYYY-MM-DD&to=YYYY-MM-DD]
 * to the URL; the server pages resolve the actual instants.
 */
export function DateRangePicker() {
  const router = useRouter();
  const params = useSearchParams();
  const preset = (params.get('range') as DateRangePreset | null) ?? 'LAST_30_DAYS';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';

  const apply = (next: { range: string; from?: string; to?: string }) => {
    const q = new URLSearchParams(params.toString());
    q.set('range', next.range);
    if (next.from) q.set('from', next.from);
    else q.delete('from');
    if (next.to) q.set('to', next.to);
    else q.delete('to');
    router.push(`?${q.toString()}`);
  };

  const validPreset = (DATE_RANGE_PRESETS as readonly string[]).includes(preset)
    ? preset
    : 'LAST_30_DAYS';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="analytics-range" className="sr-only">
        Date range
      </label>
      <select
        id="analytics-range"
        className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand)]"
        value={validPreset}
        onChange={(e) => apply({ range: e.target.value })}
      >
        {DATE_RANGE_PRESETS.map((p) => (
          <option key={p} value={p}>
            {PRESET_LABELS[p]}
          </option>
        ))}
      </select>
      {validPreset === 'CUSTOM' && (
        <>
          <label htmlFor="analytics-from" className="sr-only">
            From date
          </label>
          <input
            id="analytics-from"
            type="date"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand)]"
            value={from}
            max={to || undefined}
            onChange={(e) => apply({ range: 'CUSTOM', from: e.target.value, to })}
          />
          <label htmlFor="analytics-to" className="sr-only">
            To date
          </label>
          <input
            id="analytics-to"
            type="date"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand)]"
            value={to}
            min={from || undefined}
            onChange={(e) => apply({ range: 'CUSTOM', from, to: e.target.value })}
          />
        </>
      )}
    </div>
  );
}
