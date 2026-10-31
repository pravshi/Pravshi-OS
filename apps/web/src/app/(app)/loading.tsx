import { Skeleton } from '@/components/ui/skeleton';

/**
 * (app) route-segment loading state (Phase 12, F-12-05).
 *
 * Renders inside the app shell (the layout owns the sidebar and header), so this
 * is the page-content shape: a heading block, a row of summary cards and a main
 * content panel. Before this existed, every non-analytics navigation waited for
 * its slowest query and painted nothing.
 */
export default function AppLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="space-y-2">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
