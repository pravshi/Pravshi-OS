import Link from 'next/link';

/**
 * Root not-found boundary (Phase 12, F-12-05). Covers URLs outside the (app)
 * segment — unknown top-level paths that match no route at all. It renders
 * inside the root layout (no app shell: the visitor may not be signed in), so
 * it centres its content the way `global-error.tsx` does. In-app misses are
 * handled by `(app)/not-found.tsx` instead.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-prose flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-sm text-ink-muted">
        The page you’re looking for doesn’t exist, or the record may have been moved or deleted.
      </p>
      <Link href="/" className="rounded border border-rule px-4 py-2 text-sm hover:bg-brand-soft">
        Go to home
      </Link>
    </main>
  );
}
