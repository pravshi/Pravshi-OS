'use client';

import * as Sentry from '@sentry/nextjs';
import Link from 'next/link';
import { useEffect } from 'react';

/**
 * (app) route-segment error boundary (Phase 12, F-12-05).
 *
 * Before this existed, `global-error.tsx` was the only boundary in the app, so any
 * page-level failure replaced the entire document — shell, navigation and context
 * gone. This boundary renders INSIDE the app shell: the sidebar and header stay put
 * and only the page content is swapped for the failure state.
 *
 * Like the root boundary, the visitor sees a generic message only. An unhandled
 * server error can carry internals in its message; the detail goes to Sentry and
 * the opaque `digest` is the only thing shown, so it can be quoted in a support
 * report without disclosing anything.
 */
export default function AppError({
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
    <div className="mx-auto flex max-w-prose flex-col items-start gap-4 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="text-sm text-ink-muted">
        The error has been reported. Try again, and if it keeps happening, tell the team.
      </p>
      {error.digest ? (
        <p className="font-mono text-xs text-ink-muted">Reference: {error.digest}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded border border-rule px-4 py-2 text-sm hover:bg-brand-soft"
        >
          Try again
        </button>
        <Link href="/" className="rounded border border-rule px-4 py-2 text-sm hover:bg-brand-soft">
          Go to home
        </Link>
      </div>
    </div>
  );
}
