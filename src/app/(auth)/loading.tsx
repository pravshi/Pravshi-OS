import { Skeleton } from '@/components/ui/skeleton';

/**
 * (auth) route-segment loading state (Phase 6, UI-03).
 *
 * Renders inside AuthLayout (the centered max-w-sm card container) while
 * unauthenticated pages resolve. Matches the auth form layout with title,
 * input fields, and action button skeletons.
 */
export default function AuthLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <div className="space-y-4 pt-2">
        <div className="space-y-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-10 w-full" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-10 w-full" />
        </div>
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}
