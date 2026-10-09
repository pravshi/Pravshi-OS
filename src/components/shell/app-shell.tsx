import type { ReactNode } from 'react';
import { Sidebar } from './sidebar';
import { MobileTabBar } from './mobile-tab-bar-server';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';
import { GlobalSearch } from '@/components/search/GlobalSearch';
import { NotificationBell } from '@/components/notifications/NotificationBell';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar />
      <div className="flex min-w-0 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-rule px-6">
          <span className="shrink-0 text-sm text-ink-muted">PRAVSHI OS</span>
          {/* Workstream D (Search, 2026-10-07): global typeahead, header center.
              Re-applied after a parallel overwrite reverted it — D owns this
              center slot; E owns the right-cluster slot below. */}
          <div className="flex min-w-0 flex-1 justify-center">
            <GlobalSearch />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* [WORKSTREAM-E] Notification bell, before ThemeToggle (§16.9).
                D owns the search slot above; E owns this right cluster
                slot — do not remove or reorder the other workstream's element. */}
            <NotificationBell />
            <ThemeToggle />
            {/* AUD-03: the account menu — identity and sign-out — closes the
                right cluster. */}
            <UserMenu />
          </div>
        </header>
        {/* pb-20 on mobile clears the fixed bottom tab bar; removed at md+ */}
        <main className="min-w-0 flex-1 p-6 pb-24 md:pb-6">{children}</main>
      </div>
      <MobileTabBar />
    </div>
  );
}
