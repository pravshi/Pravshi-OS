import { ZodError } from 'zod';

/**
 * REST plumbing for the workflows routes (Phase 5). Input validation failures
 * are a 400 INVALID_REQUEST with the first problem described; everything else
 * propagates to withPermission(), which answers with the standard
 * authorization envelope.
 *
 * Same shape as src/lib/crm/http.ts and src/lib/work/http.ts, kept in the
 * workflows module so the workflows surface stays self-contained: the
 * surfaces share the pattern (identical zod validation, permission keys from
 * the 0044 seed, audit writes), never duplicated behavior.
 */

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** A 400 response for ZodError, or null when the error is not a validation failure. */
export function invalidRequestResponse(error: unknown): Response | null {
  if (!(error instanceof ZodError)) return null;
  const first = error.issues[0];
  const where = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return Response.json(
    {
      error: 'INVALID_REQUEST',
      message: `${where}${first?.message ?? 'invalid input'}`,
    },
    { status: 400, headers: NO_STORE },
  );
}

/**
 * A 400 response for service-level validation failures. Services signal these
 * by throwing Error('INVALID_REQUEST: <message>') — domain rules that have no
 * zod shape (illegal status transitions, activating a deferred trigger type,
 * executing a non-ACTIVE workflow) or that the database reports as constraint
 * violations (the per-org unique workflow name). Anything else propagates to
 * withPermission()'s error envelope.
 */
export function serviceInvalidRequestResponse(error: unknown): Response | null {
  if (error instanceof Error) {
    const match = /^INVALID_REQUEST:\s*(.+)$/.exec(error.message);
    if (match) {
      return Response.json(
        { error: 'INVALID_REQUEST', message: match[1] },
        { status: 400, headers: NO_STORE },
      );
    }
  }
  return null;
}

export const noStoreHeaders = NO_STORE;
