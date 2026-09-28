import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { auth } from './server';
import { authDb } from '@/lib/db/auth-client';

/**
 * Completion of the first-run bootstrap: the single moment a login is created for the person
 * scripts/bootstrap/run.mjs made SUPER_ADMIN, by whoever holds the setup token it printed.
 *
 * ── WHY THIS LIVES IN THE AUTH LAYER ─────────────────────────────────────────────
 *
 * It is an authentication act — somebody establishing their first credential — and nobody is
 * authenticated while it happens, so there is no identity for withAuthorizedDb() to carry.
 * Like resolveAuthContext(), it uses the auth client and exactly one narrow SECURITY DEFINER
 * function, and the database decides everything that matters.
 *
 * ── WHAT IS DECIDED HERE, AND WHAT IS NOT ────────────────────────────────────────
 *
 * Here: the token's shape, the password policy, and the password hash — the three things
 * that need Better Auth's own configuration and hasher. The policy is read from the live
 * `auth` instance rather than restated, so a change to it there applies here too.
 *
 * In complete_bootstrap_setup() (drizzle/0015): whether the token is live, whose login this
 * becomes, that the person has none yet, that no login already uses the email, and that the
 * token is consumed if and only if the login is created and linked. None of those can be
 * influenced from here: the caller supplies a digest and a hash, never an email or a person.
 *
 * ── SECRETS ──────────────────────────────────────────────────────────────────────
 *
 * The token never reaches Postgres — only its SHA-256 digest does. The password never leaves
 * this process — only the library's scrypt hash does. Nothing here logs either, and a driver
 * error is never passed on as a cause, because drizzle embeds the query parameters in its
 * message and those parameters are the digest and the password hash.
 *
 * WHEN THE BREACH-LIST CHECK LANDS (blueprint section 25, not yet implemented anywhere) it
 * must cover this path as well as the PASSWORD_SETTING_PATHS listed in server.ts.
 */

/** 32 bytes from a CSPRNG, base64url and unpadded: exactly what the bootstrap script issues. */
export const SETUP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Hex SHA-256 of the token string. scripts/bootstrap/run.mjs computes the same digest. */
export const hashSetupToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export type BootstrapSetupResult =
  | { ok: true; personId: string; orgId: string; authUserId: string }
  | { ok: false; reason: 'INVALID_REQUEST' | 'SETUP_TOKEN_INVALID' | 'SETUP_CANNOT_COMPLETE' }
  | {
      ok: false;
      reason: 'PASSWORD_TOO_SHORT' | 'PASSWORD_TOO_LONG';
      minPasswordLength: number;
      maxPasswordLength: number;
    };

/** Anything unexpected. It carries the SQLSTATE and nothing else, by design. */
export class BootstrapSetupError extends Error {
  constructor(readonly sqlstate: string | null) {
    super('bootstrap setup could not be completed');
    this.name = 'BootstrapSetupError';
  }
}

/**
 * Whether the one-time bootstrap setup is still pending — the /setup page's server guard.
 *
 * True only while a live, unconsumed setup token exists (migration 0026). False both when
 * the database was never bootstrapped (no token can be valid) and when setup completed or
 * the token expired. The page redirects to /login on false; the narrow SECURITY DEFINER
 * function answers a single bit and names nothing.
 */
export async function isBootstrapSetupPending(): Promise<boolean> {
  const r = await authDb.execute<{ pending: boolean }>(sql`
    select public.bootstrap_setup_pending() as pending
  `);
  return r.rows[0]?.pending === true;
}

/** drizzle wraps the driver error, so the SQLSTATE may be on the error or on its cause. */
function sqlstateOf(e: unknown): string | null {
  for (const candidate of [e, (e as { cause?: unknown } | null)?.cause]) {
    const code = (candidate as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/**
 * Consume the setup token and create the bootstrap person's login.
 *
 * Every refusal that costs nothing is made before the database is asked anything, and the
 * scrypt hash — the expensive step — is computed only for a token the database says is live,
 * so an unauthenticated caller cannot use this as a CPU sink.
 *
 * It does not sign anybody in. The owner signs in afterwards through Better Auth like anyone
 * else, receives an aal1 session, and enrols TOTP to reach aal2: nothing about Task 1.13's
 * assurance model is short-circuited by having been bootstrapped.
 */
export async function completeBootstrapSetup(input: {
  token: unknown;
  password: unknown;
}): Promise<BootstrapSetupResult> {
  const { token, password } = input;
  if (typeof token !== 'string' || typeof password !== 'string') {
    return { ok: false, reason: 'INVALID_REQUEST' };
  }
  if (!SETUP_TOKEN_PATTERN.test(token)) return { ok: false, reason: 'SETUP_TOKEN_INVALID' };

  const context = await auth.$context;
  const { minPasswordLength, maxPasswordLength } = context.password.config;
  // The same comparisons Better Auth's own sign-up and reset endpoints make.
  if (password.length < minPasswordLength) {
    return { ok: false, reason: 'PASSWORD_TOO_SHORT', minPasswordLength, maxPasswordLength };
  }
  if (password.length > maxPasswordLength) {
    return { ok: false, reason: 'PASSWORD_TOO_LONG', minPasswordLength, maxPasswordLength };
  }

  const digest = hashSetupToken(token);
  try {
    const live = await authDb.execute<{ valid: boolean }>(sql`
      select public.bootstrap_setup_token_is_valid(decode(${digest}, 'hex')) as valid
    `);
    if (live.rows[0]?.valid !== true) return { ok: false, reason: 'SETUP_TOKEN_INVALID' };

    const passwordHash = await context.password.hash(password);

    const linked = await authDb.execute<{
      linked_person_id: string;
      linked_org_id: string;
      linked_auth_user_id: string;
    }>(sql`
      select linked_person_id, linked_org_id, linked_auth_user_id
      from public.complete_bootstrap_setup(decode(${digest}, 'hex'), ${passwordHash})
    `);
    const row = linked.rows[0];
    if (!row) throw new BootstrapSetupError(null);

    return {
      ok: true,
      personId: row.linked_person_id,
      orgId: row.linked_org_id,
      authUserId: row.linked_auth_user_id,
    };
  } catch (e) {
    if (e instanceof BootstrapSetupError) throw e;
    const sqlstate = sqlstateOf(e);
    // 28000: the token is unknown, expired or already used — deliberately indistinguishable.
    if (sqlstate === '28000') return { ok: false, reason: 'SETUP_TOKEN_INVALID' };
    // 55000: the bootstrap person cannot receive a login. 23505: a concurrent insert of the
    // same email won the race. Either way the token was not consumed.
    if (sqlstate === '55000' || sqlstate === '23505') {
      return { ok: false, reason: 'SETUP_CANNOT_COMPLETE' };
    }
    throw new BootstrapSetupError(sqlstate);
  }
}
