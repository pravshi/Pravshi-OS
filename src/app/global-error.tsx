'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

/**
 * Root error boundary. React replaces the entire document when this renders, which is
 * why it declares its own <html> and <body> — the root layout is exactly what failed.
 *
 * What the visitor sees is deliberately generic. An unhandled server error can carry a
 * connection string, a role name, a host or a stack trace in its message, and this
 * component renders in the browser. The detail goes to Sentry; the page says nothing.
 * `digest` is safe to show: Next.js replaces the real message with an opaque hash in
 * production precisely so it can be correlated without being disclosed.
 */
export default function GlobalError({
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
    <html lang="en">
      <body className="bg-ground text-ink antialiased">
        <main className="mx-auto flex min-h-dvh max-w-prose flex-col items-center justify-center gap-4 p-6 text-center">
          <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
          <p className="text-sm text-ink-muted">
            The error has been reported. Try again, and if it keeps happening, tell the team.
          </p>
          {error.digest ? (
            <p className="font-mono text-xs text-ink-muted">Reference: {error.digest}</p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            className="rounded border border-rule px-4 py-2 text-sm hover:bg-accent"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
