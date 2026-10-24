import { Pool, type PoolClient } from '@neondatabase/serverless';
import { env } from '@/env';

/** The login every business-plane connection must be: RLS is written against it. */
export const APP_ROLE = 'app_user';

let roleProven = false;

type VerifyClient = {
  query: (
    text: string,
    cb: (err: Error | null, res?: { rows: { role?: string }[] }) => void,
  ) => void;
};

/**
 * pg-pool `verify`: the first connection must have authenticated as app_user, as the auth
 * (app_auth) and worker (app_worker) pools already prove their own logins. A DATABASE_URL that
 * named the owner or another login would otherwise run every request outside the role the
 * policies are written for — owner policies (`*_owner_all`) see every organization's rows.
 * Proven once per process: one connection string cannot change role. The error names the
 * role only — never the URL.
 */
export function verifyAppUserLogin(client: VerifyClient, done: (err?: Error) => void): void {
  if (roleProven) {
    done();
    return;
  }
  client.query('select session_user::text as role', (err, res) => {
    if (err) {
      done(err);
      return;
    }
    const role = res?.rows[0]?.role ?? '';
    if (role !== APP_ROLE) {
      done(
        new Error(`DATABASE_URL authenticates as '${role}', not ${APP_ROLE}. Refusing to use it.`),
      );
      return;
    }
    roleProven = true;
    done();
  });
}

/** Test seam: forget the cached proof. */
export function resetAppRoleProofForTests(): void {
  roleProven = false;
}

/**
 * Neon runs with scale-to-zero (a locked decision). Compute suspends when idle,
 * so dropped connections are NORMAL, not exceptional, and the first request
 * after a suspend pays a cold start. Nothing here may keep compute awake.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  idleTimeoutMillis: 10_000, // release early; a suspended compute kills them anyway
  connectionTimeoutMillis: 10_000, // generous: this is where the cold start is paid
  max: 5, // per serverless instance, not per application
  verify: verifyAppUserLogin,
} as ConstructorParameters<typeof Pool>[0]);

const RETRYABLE = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  '57P01', // admin_shutdown — what a suspending compute looks like
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
]);

export function isRetryableConnectError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && RETRYABLE.has(code);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retries CONNECTION ESTABLISHMENT only — never the work itself.
 * A connection lost mid-commit is ambiguous; replaying it can double-write.
 */
export async function connectWithWake(attempt = 0): Promise<PoolClient> {
  try {
    return await pool.connect();
  } catch (e) {
    if (attempt >= 3 || !isRetryableConnectError(e)) throw e;
    await sleep(250 * 2 ** attempt); // 250ms, 500ms, 1s
    return connectWithWake(attempt + 1);
  }
}
