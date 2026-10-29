'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import type { RenderNavItem } from './nav-items';

export function MobileNavClient({ items }: { items: RenderNavItem[] }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close the mobile navigation sheet whenever the route changes
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  function isActive(href: string): boolean {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open navigation menu"
            className="md:hidden -ml-2 text-ink-muted hover:text-foreground"
          >
            <Menu className="h-5 w-5" aria-hidden />
          </Button>
        }
      />
      <SheetContent side="left" className="w-72 p-0 flex flex-col">
        <SheetHeader className="p-4 border-b border-rule">
          <SheetTitle className="text-xs font-semibold uppercase tracking-widest text-brand">
            PRAVSHI
          </SheetTitle>
        </SheetHeader>
        <nav className="flex-1 overflow-y-auto p-4" aria-label="Mobile Directory">
          <ul className="flex flex-col gap-1 pb-16">
            {items.map((item, idx) =>
              item.kind === 'header' ? (
                <li
                  key={`mobile-section-${item.section}-${idx}`}
                  aria-hidden="true"
                  className="mt-4 px-3 text-[11px] font-semibold uppercase tracking-widest text-ink-muted first:mt-0"
                >
                  {item.section}
                </li>
              ) : (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={isActive(item.href) ? 'page' : undefined}
                    className={cn(
                      'block rounded px-3 py-2 text-sm transition-colors',
                      isActive(item.href)
                        ? 'bg-brand-soft font-medium text-brand'
                        : 'text-foreground hover:bg-brand-soft',
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              ),
            )}
          </ul>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
