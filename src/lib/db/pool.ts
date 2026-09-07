import { Pool, type PoolClient } from '@neondatabase/serverless';
import { env } from '@/env';

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
});

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
