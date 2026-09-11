import { drizzle } from 'drizzle-orm/neon-serverless';
import { pool } from './pool';
import { authDbSchema } from '@/lib/auth/schema';

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
 *   * the schema — every table reachable through this client lives in `auth`, which holds
 *     no business data;
 *   * the grants — app_user's rights in `auth` are enumerated table by table in
 *     0013_auth_tables.sql, and roles.sql's default privileges do not reach that schema;
 *   * the role — this is the same app_user as everywhere else. No BYPASSRLS, no ownership,
 *     and no additional privilege anywhere in `public`.
 *
 * So the worst this client can do is read and write the credential store. Every question
 * about business data still goes through withAuthorizedDb() and still meets RLS.
 */
export const authDb = drizzle(pool, { schema: authDbSchema });
