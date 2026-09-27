import type { ReactNode } from 'react';

/**
 * (auth) — the unauthenticated surface: login, MFA challenge, invitation acceptance,
 * access-denied. No sidebar, no header: there is no authenticated user for the shell
 * to represent, and showing navigation to someone who hasn't proven who they are is
 * information they don't need.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <p className="mb-8 text-center text-sm font-semibold tracking-widest text-ink-muted">
          PRAVSHI OS
        </p>
        {children}
      </div>
    </main>
  );
}
