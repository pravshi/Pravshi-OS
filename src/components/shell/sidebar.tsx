import Link from 'next/link';
import { heldNavPermissions } from '@/lib/authz/nav';
import { getVisibleNavItems } from './nav-items';

/**
 * Permission-filtered desktop navigation. A section renders only when the viewer holds a
 * permission inside it — checked via heldNavPermissions(), which reads authz.has()
 * without auditing (nav rendering is not an authorization decision). Every target
 * page still enforces its own requirePagePermission().
 *
 * Section and entry definitions are shared with mobile drawer navigation via `./nav-items`:
 * - href: '/admin/permissions'
 * - href: '/admin/teams'
 */
export async function Sidebar() {
  const held = await heldNavPermissions();
  const items = getVisibleNavItems(held);

  return (
    <nav className="hidden border-r border-rule bg-surface p-4 md:block" aria-label="Main">
      <div className="mb-6 text-xs font-semibold uppercase tracking-widest text-brand">PRAVSHI</div>
      <ul className="flex flex-col gap-1">
        {items.map((item, idx) =>
          item.kind === 'header' ? (
            <li
              key={`section-${item.section}-${idx}`}
              aria-hidden="true"
              className="mt-4 px-3 text-[11px] font-semibold uppercase tracking-widest text-ink-muted first:mt-0"
            >
              {item.section}
            </li>
          ) : (
            <li key={item.href}>
              <Link
                href={item.href}
                className="block rounded px-3 py-2 text-sm hover:bg-brand-soft"
              >
                {item.label}
              </Link>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}
