import type { ReactNode } from 'react';
import { Sidebar } from './sidebar';
import { ThemeToggle } from './theme-toggle';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)]">
      <Sidebar />
      <div className="flex min-w-0 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-rule px-6">
          <span className="text-sm text-ink-muted">PRAVSHI OS</span>
          <ThemeToggle />
        </header>
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
