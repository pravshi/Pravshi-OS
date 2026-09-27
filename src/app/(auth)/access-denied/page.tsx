import Link from 'next/link';

/**
 * /access-denied — the page authorization failures land on. Deliberately sparse:
 * an authorization refusal is an ordinary answer, not an error, and the page says
 * nothing about what exists behind the boundary. No permission names, no hints about
 * which role would grant access — that information is for the admin UI, not for the
 * person who was just refused.
 */
export default function AccessDeniedPage() {
  return (
    <div className="text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Access denied</h1>
      <p className="mt-3 text-sm text-ink-muted">
        You don&apos;t have access to this area. If you believe this is a mistake,
        contact your administrator.
      </p>
      <Link
        href="/"
        className="mt-6 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Back to home
      </Link>
    </div>
  );
}
