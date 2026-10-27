import { auth } from '@/lib/auth/server';
import { SetupForm } from '../setup-form';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Set up your organization — Pravshi OS',
  description: 'Create the first administrator login of a new organization.',
};

/**
 * /setup/organization#token=… — the first administrator of an organization the platform
 * provisioned. The token stays in the fragment; the form posts it to
 * /api/setup/organization/complete, where platform.complete_org_admin_setup decides (only
 * while the organization is ACTIVE; never adopting an existing login).
 */
export default async function OrganizationSetupPage() {
  const context = await auth.$context;
  const { minPasswordLength, maxPasswordLength } = context.password.config;
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <p className="mb-8 text-center text-sm font-semibold tracking-widest text-ink-muted">
          PRAVSHI OS
        </p>
        <SetupForm
          variant="org-admin"
          minPasswordLength={minPasswordLength}
          maxPasswordLength={maxPasswordLength}
        />
      </div>
    </main>
  );
}
