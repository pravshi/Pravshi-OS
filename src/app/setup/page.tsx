import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/server';
import { isBootstrapSetupPending } from '@/lib/auth/bootstrap-setup';
import { SetupForm } from './setup-form';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Set up Pravshi OS',
  description: 'Create the owner login for a new Pravshi OS installation.',
};

/**
 * /setup — the frontend half of the one-time bootstrap (drizzle/0015).
 *
 * The operator's script already created the organization, the Executive department, the
 * owner person with an ACTIVE engagement, and the SUPER_ADMIN origin grant, then printed
 * APP_URL/setup#token=… . This page reads that fragment — never a query string, so the
 * token stays out of request lines, access logs and Referer headers — collects the
 * owner's first password, and posts it to /api/bootstrap/complete. On success the owner
 * signs in at /login like anyone else and enrols TOTP to reach aal2.
 *
 * Server guard, not client-side: when no live setup token exists — the database was
 * never bootstrapped, or setup already completed, or the token expired — the page
 * redirects to /login before rendering anything.
 */
export default async function SetupPage() {
  if (!(await isBootstrapSetupPending())) redirect('/login');

  const context = await auth.$context;
  const { minPasswordLength, maxPasswordLength } = context.password.config;

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <p className="mb-8 text-center text-sm font-semibold tracking-widest text-ink-muted">
          PRAVSHI OS
        </p>
        <SetupForm minPasswordLength={minPasswordLength} maxPasswordLength={maxPasswordLength} />
      </div>
    </main>
  );
}
