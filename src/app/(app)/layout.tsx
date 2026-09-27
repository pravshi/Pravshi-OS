import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { requireAuthenticated } from '@/lib/authz/page';

/**
 * (app) — the authenticated application. The layout resolves the PRAVSHI OS identity
 * first: no session (or a session that resolves to nobody, e.g. an offboarded person)
 * redirects to /login before any page renders. Individual pages add their own
 * requirePagePermission() for step-4 authorization.
 *
 * Route groups don't affect URLs: src/app/(app)/page.tsx still serves /.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireAuthenticated();
  return <AppShell>{children}</AppShell>;
}
