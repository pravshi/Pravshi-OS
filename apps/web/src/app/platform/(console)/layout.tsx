import type { ReactNode } from 'react';
import Link from 'next/link';
import { requirePlatformPage } from '@/lib/platform/page';
import { SignOutButton } from './sign-out-button';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Platform console — Pravshi OS',
  description: 'Provision and administer Pravshi organizations.',
};

/**
 * The platform administrator console (ADR-008). Separate from the tenant application: it has
 * no tenant shell, no organization, and no person — a platform administrator is never a member
 * of any organization. Every page re-runs the same gate (layouts are not re-rendered on client
 * navigation); every action goes through /api/platform.
 */
export default async function PlatformConsoleLayout({ children }: { children: ReactNode }) {
  const ctx = await requirePlatformPage();
  const can = (p: string) => ctx.me?.permissions.includes(p) ?? false;
  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <span className="text-sm font-semibold tracking-widest">PRAVSHI PLATFORM</span>
          {ctx.enrolled ? (
            <nav aria-label="Platform" className="flex flex-wrap gap-4 text-sm">
              {can('platform.organizations.view') ? (
                <Link href="/platform">Organizations</Link>
              ) : null}
              {can('platform.admins.manage') ? (
                <Link href="/platform/admins">Administrators</Link>
              ) : null}
              {can('platform.audit.view') ? <Link href="/platform/audit">Audit</Link> : null}
              <Link href="/platform/security">Security</Link>
            </nav>
          ) : null}
          <div className="ml-auto flex items-center gap-3 text-sm text-ink-muted">
            {ctx.me ? <span>{ctx.me.email}</span> : null}
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
