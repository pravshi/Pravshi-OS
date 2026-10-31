import Link from 'next/link';

/**
 * (app) not-found boundary (Phase 12, F-12-05). Renders inside the app shell, so
 * a bad link or a record that no longer resolves keeps the user's navigation and
 * offers a way back instead of dropping them onto the framework default.
 */
export default function AppNotFound() {
  return (
    <div className="mx-auto flex max-w-prose flex-col items-start gap-4 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-sm text-ink-muted">
        The page you’re looking for doesn’t exist, or the record may have been moved or deleted.
      </p>
      <Link href="/" className="rounded border border-rule px-4 py-2 text-sm hover:bg-brand-soft">
        Go to home
      </Link>
    </div>
  );
}
