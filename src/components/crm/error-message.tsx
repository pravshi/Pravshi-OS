import type { ErrorEnvelope } from '@/lib/authz/errors';

/** Server-action failure rendered as data: show the envelope's message, nothing more. */
export function ErrorMessage({ error, title }: { error: ErrorEnvelope; title?: string }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm text-danger"
    >
      <p className="font-medium">{title ?? 'Something went wrong'}</p>
      <p className="mt-1">{error.error.message}</p>
      {error.error.requestId && (
        <p className="mt-1 text-xs opacity-70">Reference: {error.error.requestId}</p>
      )}
    </div>
  );
}
