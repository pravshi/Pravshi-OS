'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Client wrapper that code-splits the workflow editor canvas (Phase 12,
 * F-12-09). `ssr: false` is the load-bearing half: with server rendering on,
 * next/dynamic still preloads the chunk into the page's First Load. The
 * editor is a purely interactive surface behind auth, so first paint shows
 * the skeleton and the canvas chunk arrives right after.
 */
const EditWorkflowClient = dynamic(
  () => import('./EditWorkflowClient').then((m) => m.EditWorkflowClient),
  { ssr: false, loading: () => <WorkflowEditorSkeleton /> },
);

function WorkflowEditorSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <span className="sr-only">Loading workflow editor…</span>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function EditWorkflowClientLazy(props: React.ComponentProps<typeof EditWorkflowClient>) {
  return <EditWorkflowClient {...props} />;
}
