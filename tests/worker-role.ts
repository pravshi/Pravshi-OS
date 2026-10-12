import { Pool } from '@neondatabase/serverless';

/**
 * The worker's own database login (role app_worker, migration 0070) for live-DB suites.
 *
 * Worker-plane functions are executable by app_worker only, and the person-less branch of
 * the shared definers requires a connection that AUTHENTICATED as app_worker. Suites that
 * exercise the worker plane therefore connect with DATABASE_URL_WORKER — the real role, not
 * a mocked context — exactly as the worker process does.
 */
export const WORKER_DB_READY = Boolean(process.env.DATABASE_URL_WORKER);

/** The nil-UUID system actor the worker binds to a job's organization. */
export const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';

export const workerPool = () => new Pool({ connectionString: process.env.DATABASE_URL_WORKER });

/**
 * One app_worker transaction carrying the given transaction-local identity (the shape
 * src/lib/db/worker-pool.ts withWorkerContext uses), committed.
 */
export async function inWorkerContext<T extends Record<string, unknown> = Record<string, unknown>>(
  pool: Pool,
  ctx: { personId?: string | null; orgId?: string | null },
  text: string,
  params: unknown[] = [],
  /** Further transaction-local settings, e.g. the work item a worker call is bound to. */
  extra: Record<string, string> = {},
): Promise<{ rows: T[]; rowCount: number }> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`, [
      ctx.personId ?? '',
      ctx.orgId ?? '',
    ]);
    for (const [name, value] of Object.entries(extra)) {
      await c.query(`select set_config($1, $2, true)`, [name, value]);
    }
    const r = await c.query<T>(text, params);
    await c.query('commit');
    return { rows: r.rows, rowCount: r.rowCount ?? 0 };
  } catch (error) {
    await c.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}
