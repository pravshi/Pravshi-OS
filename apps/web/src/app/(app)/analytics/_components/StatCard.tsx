import { Card, CardContent } from '@/components/ui/card';

/**
 * KPI card for analytics dashboards. A null value renders "No data yet" —
 * never NaN/Infinity, never a misleading zero.
 */
export function StatCard({
  label,
  value,
  sub,
  href,
}: {
  label: string;
  /** Display string, or null when there is no data. */
  value: string | number | null;
  /** Optional supporting line (e.g. currency mix, comparison note). */
  sub?: string;
  href?: string;
}) {
  const inner = (
    <Card className={href ? 'transition-opacity hover:opacity-80' : undefined}>
      <CardContent className="px-4 py-3">
        {value === null ? (
          <p className="text-sm text-ink-muted">No data yet</p>
        ) : (
          <p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
        )}
        <p className="mt-0.5 text-xs text-ink-muted">{label}</p>
        {sub ? <p className="mt-0.5 text-[11px] text-ink-muted">{sub}</p> : null}
      </CardContent>
    </Card>
  );
  return href ? <a href={href}>{inner}</a> : inner;
}

/** Skeleton block for streaming dashboard sections. */
export function SectionSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading dashboard section">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-8 animate-pulse rounded-md bg-muted" />
      ))}
    </div>
  );
}
