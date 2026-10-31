import { auth } from '@/lib/auth/server';
import { SetupForm } from '@/app/setup/setup-form';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Platform administrator setup — Pravshi OS',
  description: 'Set the password of a Pravshi platform administrator.',
};

/**
 * /platform/setup#token=… — a platform administrator's one-time setup link (bootstrap,
 * invitation, re-issue or recovery). The token stays in the fragment; the form posts it to
 * /api/platform/setup/complete, where platform.complete_setup decides. There is no server
 * guard to run here: whether a token is live is known only from the token, which the server
 * never sees until the form is submitted.
 */
export default async function PlatformSetupPage() {
  const context = await auth.$context;
  const { minPasswordLength, maxPasswordLength } = context.password.config;
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <p className="mb-8 text-center text-sm font-semibold tracking-widest text-ink-muted">
          PRAVSHI PLATFORM
        </p>
        <SetupForm
          variant="platform-admin"
          minPasswordLength={minPasswordLength}
          maxPasswordLength={maxPasswordLength}
        />
      </div>
    </main>
  );
}
