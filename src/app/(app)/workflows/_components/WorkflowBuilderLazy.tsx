'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Client wrapper that code-splits the workflow builder canvas (Phase 12,
 * F-12-09). `ssr: false` is the load-bearing half: with server rendering on,
 * next/dynamic still preloads the chunk into the page's First Load. The
 * builder is a purely interactive surface behind auth, so first paint shows
 * the skeleton and the canvas chunk arrives right after.
 */
const WorkflowBuilder = dynamic(() => import('./WorkflowBuilder').then((m) => m.WorkflowBuilder), {
  ssr: false,
  loading: () => <WorkflowBuilderSkeleton />,
});

function WorkflowBuilderSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <span className="sr-only">Loading workflow builder…</span>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function WorkflowBuilderLazy(props: React.ComponentProps<typeof WorkflowBuilder>) {
  return <WorkflowBuilder {...props} />;
}
