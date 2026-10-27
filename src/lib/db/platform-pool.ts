import { Pool, type PoolClient } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import { env } from '@/env';
import { isRetryableConnectError } from './pool';
import type { Tx } from './authorized';

/**
 * THE PLATFORM PLANE'S PATH TO POSTGRES — role app_platform (migrations 0083-0086, ADR-008).
 *
 * The platform administrator console's database operations — the platform administrator's own
 * identity, organization provisioning and lifecycle, administrator management, the platform
 * audit trail — are executable by app_platform ONLY, and app_platform holds no table privilege
 * anywhere: every operation is a SECURITY DEFINER call in schema platform that re-derives the
 * acting administrator from this transaction's settings (platform.current_admin()) and checks
 * its permission. Only src/lib/platform may import this module
 * (tests/guards/single-db-path.test.ts).
 *
 * NO FALLBACK. Without DATABASE_URL_PLATFORM the first use fails with a clear error: the
 * console is simply unavailable where the variable is not set. It never borrows another URL.
 *
 * CREATED ON FIRST USE, and THE LOGIN IS PROVEN: every new physical connection must have
 * authenticated as app_platform (session_user), as for the auth pool; any other login fails
 * closed on first use.
 */
export const PLATFORM_ROLE = 'app_platform';
const PLATFORM_POOL_MAX = 2;

let roleProven = false;
let realPool: Pool | null = null;

type VerifyClient = {
  query: (
    text: string,
    cb: (err: Error | null, res?: { rows: { role?: string }[] }) => void,
  ) => void;
};

function verifyPlatformLogin(client: VerifyClient, done: (err?: Error) => void): void {
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
    if (role !== PLATFORM_ROLE) {
      done(
        new Error(
          `DATABASE_URL_PLATFORM authenticates as '${role}', not ${PLATFORM_ROLE}. Refusing to use it.`,
        ),
      );
      return;
    }
    roleProven = true;
    done();
  });
}

function getPlatformPool(): Pool {
  if (!env.DATABASE_URL_PLATFORM) {
    throw new PlatformUnavailableError();
  }
  if (!realPool) {
    realPool = new Pool({
      connectionString: env.DATABASE_URL_PLATFORM,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      max: PLATFORM_POOL_MAX,
      verify: verifyPlatformLogin,
    } as ConstructorParameters<typeof Pool>[0]);
    // Only the error's name and code are logged — never its message, which can carry parameters.
    realPool.on('error', (err: unknown) => {
      const e = err as { name?: unknown; code?: unknown };
      console.error('[platform] platform pool error', { name: e?.name, code: e?.code });
    });
  }
  return realPool;
}

/** The console runs only where DATABASE_URL_PLATFORM is set; elsewhere every call refuses. */
export class PlatformUnavailableError extends Error {
  constructor() {
    super(
      'DATABASE_URL_PLATFORM is not configured: the platform console runs on its own login ' +
        '(app_platform). There is no fallback.',
    );
    this.name = 'PlatformUnavailableError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connect as app_platform, retrying connection establishment only (see pool.ts). */
async function connectPlatformWithWake(attempt = 0): Promise<PoolClient> {
  try {
    return await getPlatformPool().connect();
  } catch (e) {
    if (attempt >= 3 || !isRetryableConnectError(e)) throw e;
    await sleep(250 * 2 ** attempt);
    return connectPlatformWithWake(attempt + 1);
  }
}

/** Who a platform transaction acts as. null: no administrator (identity lookups only). */
export interface PlatformActorSettings {
  adminId: string;
  aal: 'aal1' | 'aal2';
  /** The administrator's own session: the database requires it to be live and aal2 (0086). */
  sessionId: string;
}

/**
 * One app_platform transaction. The acting administrator and the assurance level are set
 * transaction-locally (SET LOCAL semantics via set_config(..., true)), exactly as
 * withAuthorizedDb() sets a person: a pooled connection never carries one administrator into
 * the next request. The database re-derives and re-checks both on every call.
 */
export async function withPlatformTx<T>(
  actor: PlatformActorSettings | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await connectPlatformWithWake();
  try {
    return await drizzle(client).transaction(async (tx) => {
      await tx.execute(sql`
        select set_config('app.platform_admin_id', ${actor?.adminId ?? ''}, true),
               set_config('app.platform_aal', ${actor?.aal ?? ''}, true),
               set_config('app.platform_session_id', ${actor?.sessionId ?? ''}, true)
      `);
      return fn(tx);
    });
  } finally {
    client.release();
  }
}
