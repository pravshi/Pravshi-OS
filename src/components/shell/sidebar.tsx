import Link from 'next/link';

/**
 * Sections render only when the viewer holds a permission inside them.
 * Phase 0 has no permissions yet, so the list is static and Home-only —
 * Phase 1 replaces this with permission filtering.
 */
const SECTIONS = [{ label: 'Home', href: '/' }] as const;

export function Sidebar() {
  return (
    <nav className="hidden border-r border-rule bg-surface p-4 md:block" aria-label="Main">
      <div className="mb-6 text-xs font-semibold uppercase tracking-widest text-brand">PRAVSHI</div>
      <ul className="flex flex-col gap-1">
        {SECTIONS.map((s) => (
          <li key={s.href}>
            <Link href={s.href} className="block rounded px-3 py-2 text-sm hover:bg-brand-soft">
              {s.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
