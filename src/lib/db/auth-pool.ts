import { Pool, type PoolClient } from '@neondatabase/serverless';
import { env } from '@/env';
import { isRetryableConnectError } from './pool';

/**
 * THE AUTHENTICATION PLANE'S PATH TO POSTGRES — role app_auth (migrations 0072/0073).
 *
 * Better Auth's adapter and every pre-authentication flow (sign-in, sessions, two-factor,
 * password reset and change, lockouts, login events, invitation acceptance, bootstrap
 * completion, administrator session actions) reach the database through this pool and
 * nothing else — src/lib/db/auth-client.ts wraps it, and tests/guards/single-db-path.test.ts
 * keeps both inside the auth module. app_auth holds the credential store (the auth schema)
 * and the pre-login functions, and no privilege in the business schema; app_user, the
 * business role, holds none of the credential store. So a flaw that lets someone run SQL as
 * the business role reaches no password hash, session token or second-factor secret.
 *
 * NO FALLBACK. Without DATABASE_URL_AUTH the first use fails with a clear error. It never
 * borrows DATABASE_URL: that login is app_user, which can no longer authenticate anyone, and
 * using it would only hide a missing secret behind failing sign-ins. (On Vercel src/env.ts
 * refuses a deployment without it before anything runs.)
 *
 * CREATED ON FIRST USE, NOT AT IMPORT. The worker host must not hold DATABASE_URL_AUTH
 * (src/worker/runner.ts refuses it), yet its module graph reaches this file through shared
 * code (workflow engine → integrations fan-out → authorization helpers → session → auth client)
 * without ever authenticating anyone. So importing it must neither require the variable nor
 * open anything; only a call does. `authPool` is a Pool whose connect/query go to the real pool,
 * created on the first call — drizzle sees an ordinary Pool.
 *
 * THE LOGIN IS PROVEN, NOT ASSUMED. Every new physical connection is checked before it is
 * handed out (the pool's `verify` hook): session_user must be app_auth. A DATABASE_URL_AUTH that
 * names any other login — the business role above all — fails closed on first use. Once one
 * connection has passed, the process skips the check: a pool's URL does not change.
 *
 * Same scale-to-zero rules as src/lib/db/pool.ts: idle connections are released early, and only
 * connection establishment is retried — never the work.
 */
export const AUTH_ROLE = 'app_auth';

/**
 * Per serverless instance, next to the business pool's 5. PROVISIONAL: confirmed or lowered by
 * the Neon development-pooler probe (design §6.2, scripts/ops/auth-pool-probe.mjs).
 */
export const AUTH_POOL_MAX = 3;

let roleProven = false;

type VerifyClient = {
  query: (
    text: string,
    cb: (err: Error | null, res?: { rows: { role?: string }[] }) => void,
  ) => void;
};

/** pg-pool `verify`: a new connection must have authenticated as app_auth. */
function verifyAuthLogin(client: VerifyClient, done: (err?: Error) => void): void {
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
    if (role !== AUTH_ROLE) {
      done(
        new Error(
          `DATABASE_URL_AUTH authenticates as '${role}', not ${AUTH_ROLE}. Refusing to use it.`,
        ),
      );
      return;
    }
    roleProven = true;
    done();
  });
}

let realPool: Pool | null = null;

/** The real pool, created on first use. Throws — no fallback — when DATABASE_URL_AUTH is unset. */
function getAuthPool(): Pool {
  if (!env.DATABASE_URL_AUTH) {
    throw new Error(
      'DATABASE_URL_AUTH is not configured: authentication runs on its own login (app_auth). ' +
        'Set it to the pooled connection string of app_auth. There is no fallback.',
    );
  }
  if (!realPool) {
    realPool = new Pool({
      connectionString: env.DATABASE_URL_AUTH,
      idleTimeoutMillis: 10_000, // release early; a suspended compute kills them anyway
      connectionTimeoutMillis: 10_000, // generous: this is where the cold start is paid
      max: AUTH_POOL_MAX,
      verify: verifyAuthLogin,
    } as ConstructorParameters<typeof Pool>[0]);
    // A scale-to-zero suspend drops idle sockets; an 'error' with no listener would take the
    // process down. The pool discards the broken client; per-query errors still surface. Only
    // the error's name and code are logged — never its message, which can carry parameters.
    realPool.on('error', (err: unknown) => {
      const e = err as { name?: unknown; code?: unknown };
      console.error('[auth] auth pool error', { name: e?.name, code: e?.code });
    });
  }
  return realPool;
}

/**
 * The pool drizzle and Better Auth are given: an ordinary Pool (drizzle checks `instanceof Pool`
 * to run transactions on one checked-out client) whose connect/query are the real pool's,
 * created on the first call. Constructing it opens nothing and needs no configuration.
 */
class LazyAuthPool extends Pool {
  constructor() {
    super({ max: AUTH_POOL_MAX });
  }
  // Both call shapes (promise and callback) are forwarded unchanged.
  override connect(...args: unknown[]): never {
    const pool = getAuthPool();
    return (pool.connect as (...a: unknown[]) => never).apply(pool, args);
  }
  override query(...args: unknown[]): never {
    const pool = getAuthPool();
    return (pool.query as (...a: unknown[]) => never).apply(pool, args);
  }
  override end(...args: unknown[]): never {
    if (!realPool) return Promise.resolve() as never;
    return (realPool.end as (...a: unknown[]) => never).apply(realPool, args);
  }
}

export const authPool: Pool = new LazyAuthPool();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connect as app_auth, retrying connection establishment only (see pool.ts). */
export async function connectAuthWithWake(attempt = 0): Promise<PoolClient> {
  try {
    return await getAuthPool().connect();
  } catch (e) {
    if (attempt >= 3 || !isRetryableConnectError(e)) throw e;
    await sleep(250 * 2 ** attempt); // 250ms, 500ms, 1s
    return connectAuthWithWake(attempt + 1);
  }
}

/** The login this process's authentication connection uses (health check, tests). */
export async function authSessionRole(): Promise<string> {
  const client = await connectAuthWithWake();
  try {
    const r = await client.query<{ role: string }>('select session_user::text as role');
    return r.rows[0]?.role ?? '';
  } finally {
    client.release();
  }
}
