import { auth } from './server';

/**
 * Server-side session resolution that never carries a driver error.
 *
 * Better Auth's getSession, on a failed session lookup, throws an APIError; from 1.7.7 on it
 * attaches the underlying error as its `cause` (session.mjs: `{ cause: error }`). That underlying
 * error is drizzle's DrizzleQueryError, whose message embeds the query's parameters — the
 * session token among them — so any log line or error report that walks the cause chain would
 * carry a live bearer token (tests/integration/auth-token-logging.test.ts). Every server-side
 * caller goes through here: a failure becomes a fixed error with no cause, and still fails.
 */
export class SessionUnavailableError extends Error {
  constructor() {
    super('the session could not be resolved');
    this.name = 'SessionUnavailableError';
  }
}

export async function getSessionSafely(headers: Headers) {
  try {
    return await auth.api.getSession({ headers });
  } catch {
    throw new SessionUnavailableError();
  }
}
