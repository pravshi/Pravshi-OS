import { drizzle } from 'drizzle-orm/neon-serverless';
import { authPool } from './auth-pool';
import { authDbSchema } from './auth-schema';

/**
 * THE SECOND, AND ONLY OTHER, PATH TO POSTGRES — and it lives here, in the db module,
 * rather than in the auth module, for the same reason the first one does: database access
 * is centralised so it can be reasoned about in one place. tests/guards/single-db-path.test.ts
 * enforces that boundary, and this file is inside it rather than an exception to it.
 *
 * ── WHY A SECOND PATH EXISTS AT ALL ──────────────────────────────────────────────
 *
 * withAuthorizedDb() opens a transaction and SET LOCALs an identity into it, and every
 * policy in `public` is written against that identity. Authentication cannot use it: the
 * whole point of the request is to find out who is asking, so there is no identity to set.
 * A connection that reads a credential before anybody is authenticated is a genuine
 * exception, and pretending otherwise would mean either weakening the policies in `public`
 * or inventing a fake identity to satisfy them.
 *
 * ── WHAT KEEPS IT NARROW ─────────────────────────────────────────────────────────
 *
 * The exception is bounded by the database, not by good intentions:
 *
 *   * the role — this client runs on app_auth (src/lib/db/auth-pool.ts, migrations 0072/0073),
 *     a login of its own, never on app_user. No BYPASSRLS, no ownership, no membership;
 *   * the grants — app_auth's rights are the auth schema's tables (enumerated in 0072) and the
 *     pre-login functions, and nothing in `public`: it cannot read a single business row;
 *   * the other direction — app_user, the business role, holds nothing in `auth` at all
 *     (0073), so business code cannot reach a password hash, session or second factor.
 *
 * So the worst this client can do is read and write the credential store. Every question
 * about business data still goes through withAuthorizedDb() and still meets RLS.
 */
export const authDb = drizzle(authPool, { schema: authDbSchema });
