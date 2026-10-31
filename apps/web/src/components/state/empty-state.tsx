import type { ReactNode } from 'react';

/** Every table gets one. An empty state must say what to do next, not just "no data". */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded border border-dashed border-rule p-12 text-center">
      <p className="font-medium">{title}</p>
      <p className="max-w-prose text-sm text-ink-muted">{description}</p>
      {action}
    </div>
  );
}
