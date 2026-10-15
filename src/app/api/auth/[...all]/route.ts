import * as Sentry from '@sentry/nextjs';
import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth/server';
import { logAuthFailure } from '@/lib/auth/safe-log';
import { errorSummary } from '@/lib/observability/redact';

/**
 * The Better Auth endpoint. Backend infrastructure, not a page — there is no login UI in
 * this task.
 *
 * This is the first public HTTP surface in the repository, so what it does NOT expose is
 * worth stating: sign-up is refused twice over (disableSignUp, plus the before-hook in
 * server.ts), and a session it issues grants nothing on its own. Every route that goes on
 * to read business data still goes through withAuthorizedDb() and still meets RLS.
 *
 * NOTHING RAW ESCAPES IT. Endpoint failures are answered and logged by the library, through
 * src/lib/auth/safe-log.ts. A failure outside an endpoint — the database-backed rate limiter runs
 * before one — is thrown out of the handler, and Next.js would print the thrown error whole: a
 * failed query's message carries its bound parameters. So the last resort is here: one safe log
 * line, a Sentry alert built from the error's class and code only, and a fixed 500.
 */
const handlers = toNextJsHandler(auth);

class AuthRouteError extends Error {
  override name = 'AuthRouteError';
}

async function guarded(handler: (request: Request) => Promise<Response>, request: Request) {
  try {
    return await handler(request);
  } catch (e) {
    logAuthFailure('auth.route.unhandled', e);
    const s = errorSummary(e);
    Sentry.captureException(
      new AuthRouteError(`auth.route.unhandled ${s.error}${s.code ? ` ${s.code}` : ''}`),
    );
    return Response.json(
      { code: 'INTERNAL_SERVER_ERROR', message: 'Authentication is temporarily unavailable.' },
      { status: 500 },
    );
  }
}

export const GET = (request: Request) => guarded(handlers.GET, request);
export const POST = (request: Request) => guarded(handlers.POST, request);
