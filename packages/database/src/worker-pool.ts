import { Pool, type PoolClient } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import { env } from '@/env';
import { isRetryableConnectError } from './pool';
import type { Tx } from './authorized';
import type { AuthContext } from './context';

/**
 * THE WORKER PLANE'S PATH TO POSTGRES — role app_worker (migration 0070).
 *
 * The background worker's database operations — claiming, starting, completing and failing
 * jobs, retry sweeps, reaping, reminders, scheduler ticks, maintenance, protected email
 * content, webhook signing secrets — are executable by app_worker ONLY. The database
 * recognises the worker by the role this connection authenticated as (session_user), not
 * by any setting a caller can write, so an app_user connection cannot pass itself off as
 * the worker however it sets app.person_id / app.org_id.
 *
 * app_worker holds no table privilege and no RLS policy: every operation here is a
 * SECURITY DEFINER call. Work that must run as a real person (workflow actions) does NOT
 * come here: it runs through withAuthorizedDb() on the app_user pool under the principal
 * the worker-plane definer resolved.
 *
 * The pool is created on first use, not at import: web routes import modules that also
 * hold worker-plane functions (src/lib/jobs/queue.ts), and the web app never has — and must
 * never have — DATABASE_URL_WORKER (src/env.ts refuses it on Vercel). Calling a
 * worker-plane function without it fails closed with a clear error.
 *
 * Same scale-to-zero rules as src/lib/db/pool.ts: idle connections are released early, and
 * only connection establishment is retried — never the work.
 */
let workerPool: Pool | null = null;

function getWorkerPool(): Pool {
  if (!env.DATABASE_URL_WORKER) {
    throw new Error(
      'DATABASE_URL_WORKER is not configured: worker-plane database access exists only on ' +
        'the worker host (role app_worker).',
    );
  }
  if (!workerPool) {
    workerPool = new Pool({
      connectionString: env.DATABASE_URL_WORKER,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      max: 3,
    });
    // Same guard runner.ts puts on the app_user pool: a scale-to-zero suspend drops idle
    // sockets, and an 'error' with no listener would kill the worker process. Log and go
    // on — the pool discards the broken client; per-query errors still surface.
    workerPool.on('error', (err: unknown) => {
      console.error('[worker] worker pool error (worker continues):', err);
    });
  }
  return workerPool;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Clients that already carry the no-op 'error' listener — once per client, not per checkout. */
const guardedClients = new WeakSet<object>();

/** Connect as app_worker, retrying connection establishment only (see pool.ts). */
export async function connectWorkerWithWake(attempt = 0): Promise<PoolClient> {
  try {
    const client = await getWorkerPool().connect();
    if (!guardedClients.has(client)) {
      guardedClients.add(client);
      client.on('error', () => undefined);
    }
    return client;
  } catch (e) {
    if (attempt >= 3 || !isRetryableConnectError(e)) throw e;
    await sleep(250 * 2 ** attempt); // 250ms, 500ms, 1s
    return connectWorkerWithWake(attempt + 1);
  }
}

/** One app_worker transaction with no identity — the worker plane's own operations. */
export async function withWorkerTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await connectWorkerWithWake();
  try {
    return await drizzle(client).transaction(fn);
  } finally {
    client.release();
  }
}

/**
 * The work item a worker-plane call acts for. The database derives the organization (and, for
 * a reminder, the recipient) from this item's row — authz.worker_bound_scope(), migration 0070 —
 * so it must name what the worker actually holds: the job it is running under its own claim,
 * or the reminder it claimed.
 */
export type WorkItem =
  { kind: 'job'; id: string; workerId: string } | { kind: 'reminder'; id: string };

/**
 * One app_worker transaction for a call bound to a held work item — the shared definers whose
 * person-less branch serves the worker (notifications, webhook signing secrets). That branch
 * requires the app_worker role and takes its organization from the item's row, never from
 * app.org_id; asking about any other organization (or, for a reminder, any other person) is
 * refused with 42501. The system actor and org are still set for the rest of the transaction.
 * Transaction-local, exactly like withAuthorizedDb().
 */
export async function withWorkerContext<T>(
  ctx: AuthContext,
  item: WorkItem,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withWorkerTx(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.person_id',  ${ctx.personId}, true),
        set_config('app.org_id',     ${ctx.orgId},    true),
        set_config('app.aal',        ${ctx.aal},      true),
        set_config('app.work_kind',  ${item.kind},    true),
        set_config('app.work_id',    ${item.id},      true),
        set_config('app.worker_id',  ${item.kind === 'job' ? item.workerId : ''}, true)
    `);
    return fn(tx);
  });
}

/** The role this process's worker connection authenticates as (startup self-check). */
export async function workerSessionRole(): Promise<string> {
  return withWorkerTx(async (tx) => {
    const r = await tx.execute<{ role: string }>(sql`select session_user::text as role`);
    return r.rows[0]?.role ?? '';
  });
}
