import Link from 'next/link';
import type { ReactNode } from 'react';

/** Field row for detail pages: label on the left, value on the right. */
export function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-2 py-2 text-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function DetailLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-primary underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}
