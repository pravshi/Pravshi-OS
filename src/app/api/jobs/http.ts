import { ZodError } from 'zod';

/**
 * REST plumbing for the jobs/schedules API surface (Phase 6).
 * Same shape as src/lib/workflows/http.ts: input validation failures are a
 * 400 INVALID_REQUEST with the first problem described; everything else
 * propagates to withPermission(), which answers with the standard
 * authorization envelope.
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
 * zod shape (illegal job state transitions, unsatisfiable cron expressions,
 * empty PATCH bodies). Anything else propagates to withPermission()'s error
 * envelope.
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
