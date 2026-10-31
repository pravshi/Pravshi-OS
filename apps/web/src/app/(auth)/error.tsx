'use client';

import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/**
 * (auth) route-segment error boundary (Phase 6, UI-03).
 *
 * Renders inside AuthLayout (maintaining the centered max-w-sm card container).
 * Catches unhandled errors across unauthenticated flows (/login, /mfa, /invite,
 * /forgot-password, /reset-password) without crashing to global-error.
 * Reports to Sentry and provides a clear retry button and navigation back to sign in.
 */
export default function AuthError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Something went wrong
      </h1>
      <p className="text-sm text-ink-muted">
        An unexpected error occurred. You can retry the action, or return to the sign in page.
      </p>
      {error.digest ? (
        <p className="font-mono text-xs text-ink-muted">Reference: {error.digest}</p>
      ) : null}
      <div className="flex flex-col gap-2 pt-2">
        <Button type="button" onClick={reset} className="w-full">
          Try again
        </Button>
        <Link
          href="/login"
          className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted text-center"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
