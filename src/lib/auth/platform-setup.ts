import { sql } from 'drizzle-orm';
import { auth } from './server';
import { authDb } from '@/lib/db/auth-client';
import {
  BootstrapSetupError,
  hashSetupToken,
  setupPasswordRefusal,
  sqlstateOf,
  type SetupPasswordRefusal,
} from './bootstrap-setup';
import { SETUP_TOKEN_PATTERN } from './setup-token';

/**
 * The two platform setup links (ADR-008), completed exactly as the bootstrap's is
 * (bootstrap-setup.ts): the token's shape and the full password policy are checked here, the
 * database is asked whether the token is live before the expensive hash, and the SECURITY
 * DEFINER function on app_auth decides whose credential it becomes and consumes the token in
 * the same transaction. The caller supplies a digest and a library hash, never an email or an
 * identity. Nobody is signed in by completing setup.
 *
 *   'platform-admin' platform.complete_setup (0083): an invited, bootstrapped or recovered
 *                    platform administrator. A recovered one keeps their login and gets a new
 *                    password; the old one stops working at once.
 *   'org-admin'      platform.complete_org_admin_setup (0084): the first administrator of an
 *                    organization the platform provisioned. Only while that organization is
 *                    ACTIVE.
 *
 * Every invalid, expired, consumed or other-kind token gets the same answer
 * (SETUP_TOKEN_INVALID): a platform token is not valid on the organization path and vice
 * versa, because each function looks only at its own table.
 */
export type PlatformSetupKind = 'platform-admin' | 'org-admin';

export type PlatformSetupResult =
  | { ok: true }
  | { ok: false; reason: 'INVALID_REQUEST' | 'SETUP_TOKEN_INVALID' | 'SETUP_CANNOT_COMPLETE' }
  | SetupPasswordRefusal;

export async function completePlatformSetup(
  kind: PlatformSetupKind,
  input: { token: unknown; password: unknown },
): Promise<PlatformSetupResult> {
  const { token, password } = input;
  if (typeof token !== 'string' || typeof password !== 'string') {
    return { ok: false, reason: 'INVALID_REQUEST' };
  }
  if (!SETUP_TOKEN_PATTERN.test(token)) return { ok: false, reason: 'SETUP_TOKEN_INVALID' };

  const refused = await setupPasswordRefusal(password);
  if (refused) return refused;

  const digest = hashSetupToken(token);
  try {
    const live = await authDb.execute<{ valid: boolean }>(
      kind === 'platform-admin'
        ? sql`select platform.setup_token_is_valid(decode(${digest}, 'hex')) as valid`
        : sql`select platform.org_admin_setup_token_is_valid(decode(${digest}, 'hex')) as valid`,
    );
    if (live.rows[0]?.valid !== true) return { ok: false, reason: 'SETUP_TOKEN_INVALID' };

    const context = await auth.$context;
    const passwordHash = await context.password.hash(password);
    const done = await authDb.execute(
      kind === 'platform-admin'
        ? sql`select 1 from platform.complete_setup(decode(${digest}, 'hex'), ${passwordHash})`
        : sql`select 1 from platform.complete_org_admin_setup(decode(${digest}, 'hex'), ${passwordHash})`,
    );
    if (done.rows.length !== 1) throw new BootstrapSetupError(null);
    return { ok: true };
  } catch (e) {
    if (e instanceof BootstrapSetupError) throw e;
    const sqlstate = sqlstateOf(e);
    // 28000: unknown, expired or used — deliberately indistinguishable.
    if (sqlstate === '28000') return { ok: false, reason: 'SETUP_TOKEN_INVALID' };
    // 55000: the email already has a login (never adopted), or the organization is not active.
    // 23505: a concurrent insert of the same email won. Either way the token was not consumed.
    if (sqlstate === '55000' || sqlstate === '23505') {
      return { ok: false, reason: 'SETUP_CANNOT_COMPLETE' };
    }
    // Never the driver error itself: its message carries the digest and the hash.
    throw new BootstrapSetupError(sqlstate);
  }
}
