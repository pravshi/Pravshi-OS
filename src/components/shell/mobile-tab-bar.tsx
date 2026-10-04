'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Building2, Home, KanbanSquare, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';

export type MobileTab = {
  label: string;
  href: string;
  icon: 'home' | 'work' | 'crm' | 'admin';
};

const ICONS = {
  home: Home,
  work: KanbanSquare,
  crm: Building2,
  admin: Settings,
} as const;

/**
 * iOS-style bottom tab bar for mobile navigation.
 * Rendered only on small viewports (md:hidden) — the desktop sidebar takes over at md+.
 * Apple-minimal: translucent backdrop blur, safe-area padding, subtle active indicator.
 */
export function MobileTabBarClient({ tabs }: { tabs: MobileTab[] }) {
  const pathname = usePathname();

  function isActive(href: string): boolean {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <nav
      aria-label="Mobile"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-rule bg-surface/80 backdrop-blur-xl md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul
        className="grid"
        style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
      >
        {tabs.map((tab) => {
          const Icon = ICONS[tab.icon];
          const active = isActive(tab.href);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-[56px] flex-col items-center justify-center gap-1 px-2 py-2 text-[11px] font-medium transition-colors',
                  active ? 'text-brand' : 'text-ink-muted hover:text-foreground',
                )}
              >
                <Icon className="h-5 w-5" strokeWidth={active ? 2.25 : 1.75} aria-hidden />
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
