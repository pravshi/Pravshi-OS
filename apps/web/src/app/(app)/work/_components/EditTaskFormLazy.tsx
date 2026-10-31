'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Client wrapper that code-splits the task editor (Phase 12, F-12-09).
 * `ssr: false` is the load-bearing half: with server rendering on,
 * next/dynamic still preloads the chunk into the page's First Load. The
 * editor only renders after the user opens "Edit task", so nothing is lost
 * by fetching its chunk on demand.
 */
const EditTaskForm = dynamic(() => import('./EditTaskForm').then((m) => m.EditTaskForm), {
  ssr: false,
  loading: () => <EditTaskFormSkeleton />,
});

function EditTaskFormSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <span className="sr-only">Loading task editor…</span>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

export function EditTaskFormLazy(props: React.ComponentProps<typeof EditTaskForm>) {
  return <EditTaskForm {...props} />;
}
