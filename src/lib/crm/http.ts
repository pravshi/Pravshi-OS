import { ZodError } from 'zod';

/**
 * REST plumbing for the CRM routes. Input validation failures are a 400
 * INVALID_REQUEST with the first problem described; everything else propagates
 * to withPermission(), which answers with the section 24 envelope.
 *
 * Why a REST surface alongside the server actions (A4): the actions in
 * src/app/(app)/crm/actions.ts are React-bound — they cannot serve external
 * integrations, mobile clients, or machine-to-machine callers. These routes are
 * the stable HTTP API for those consumers. The two surfaces stay in lockstep by
 * sharing the service layer (src/lib/crm/*): identical zod validation,
 * identical permission keys, identical audit writes. Any behavior change must
 * land in the service, never in one surface alone.
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

export const noStoreHeaders = NO_STORE;
