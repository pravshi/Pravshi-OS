/**
 * Phase 3, MT-L3 (migration 0078) — append-only history cannot be truncated.
 *
 * Probed as the owner (app_owner, DATABASE_URL_MIGRATE): no runtime role holds TRUNCATE at
 * all, so the owner is where the guard is the barrier. Every probe runs inside a transaction
 * that is rolled back, so even a guard failure could not remove anything.
 *
 * Measured before 0078 on PostgreSQL 18.6: a statement-level TRUNCATE trigger on the
 * partitioned audit_logs parent is not cloned to partitions, and a direct TRUNCATE of a
 * partition went through. Hence the per-partition guard, and the guard on new partitions.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);
const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * TRUNCATE public.<table> inside a rolled-back transaction; returns its SQLSTATE.
 *
 * The table's ACCESS EXCLUSIVE lock is taken first with NOWAIT, retried until it is free, so the
 * probe never WAITS in the lock queue. A queued ACCESS EXCLUSIVE request on the hot audit_logs
 * parent blocks every audit writer behind it and makes the maintenance function's own NOWAIT
 * fail; on a shared database that flaked the parallel partition-maintenance suite. Held this way
 * the lock lasts milliseconds: the guard fires at once, and the rollback releases it.
 */
async function truncateStateInRollback(table: string): Promise<string> {
  const c = await owner.connect();
  try {
    for (let attempt = 1; ; attempt += 1) {
      await c.query('begin');
      try {
        await c.query(`lock table public.${table} in access exclusive mode nowait`);
        break;
      } catch (error) {
        await c.query('rollback');
        if ((error as { code?: string }).code !== '55P03' || attempt === 400) throw error;
        await sleep(25);
      }
    }
    try {
      await c.query(`truncate public.${table}`);
      return 'SUCCEEDED';
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}

const partitions = async () =>
  (
    await owner.query<{ name: string }>(
      `select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'public.audit_logs'::regclass order by 1`,
    )
  ).rows.map((r) => r.name);

describe.skipIf(!HAS_DB)('append-only history cannot be truncated (MT-L3, 0078)', () => {
  afterAll(async () => {
    await owner.end();
  });

  it.each(['audit_logs', 'login_events', 'engagement_events'])(
    'TRUNCATE public.%s is refused',
    async (table) => {
      expect(await truncateStateInRollback(table)).toBe('23514');
    },
  );

  it('a direct TRUNCATE of every existing audit_logs partition is refused', async () => {
    const names = await partitions();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect({ name, state: await truncateStateInRollback(name) }).toEqual({
        name,
        state: '23514',
      });
    }
  });

  // TRUNCATE public.organizations CASCADE reaches the history and is refused as a whole by the
  // parent's guard — proven on an isolated database when 0078 was written. It is not probed
  // here: CASCADE takes ACCESS EXCLUSIVE on ~60 tables before the guard can fire, which on a
  // shared test database deadlocks with concurrent suites (seen with 0078 organization types).

  it('a partition created after 0078 is guarded too (ensure_audit_log_partitions)', async () => {
    const c = await owner.connect();
    try {
      await c.query('begin');
      // Thirteen months ahead creates at least one partition beyond the twelve-month window.
      await c.query(`select public.ensure_audit_log_partitions(13)`);
      const { rows } = await c.query<{ unguarded: string }>(
        `select count(*) as unguarded from pg_inherits i
          where i.inhparent = 'public.audit_logs'::regclass
            and not exists (select 1 from pg_trigger g where g.tgrelid = i.inhrelid
                             and g.tgname = 'audit_history_no_truncate' and g.tgenabled = 'O')`,
      );
      expect(Number(rows[0]!.unguarded)).toBe(0);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  });

  it('maintenance puts back a guard that a partition lost (self-repair)', async () => {
    const c = await owner.connect();
    try {
      await c.query('begin');
      const { rows } = await c.query<{ name: string }>(
        `select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid
          where i.inhparent = 'public.audit_logs'::regclass order by 1 limit 1`,
      );
      const name = rows[0]!.name;
      await c.query(`drop trigger audit_history_no_truncate on public.${name}`);
      await c.query(`select public.ensure_audit_log_partitions(12)`);
      const back = await c.query<{ n: string }>(
        `select count(*) as n from pg_trigger
          where tgrelid = ('public.' || $1)::regclass and tgname = 'audit_history_no_truncate'`,
        [name],
      );
      expect(Number(back.rows[0]!.n)).toBe(1);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  });

  it('the row-level append-only guards are still in place (0006, 0011, 0018 — unchanged)', async () => {
    // Their behaviour is tested by the audit and login-event suites; here, that 0078 kept them.
    const { rows } = await owner.query<{ t: string }>(
      `select c.relname || '.' || g.tgname as t from pg_trigger g join pg_class c on c.oid = g.tgrelid
        where c.relname in ('audit_logs', 'login_events', 'engagement_events')
          and g.tgname ~ '_no_(update|delete)$' and g.tgenabled = 'O' order by 1`,
    );
    expect(rows.map((r) => r.t)).toEqual([
      'audit_logs.audit_logs_no_delete',
      'audit_logs.audit_logs_no_update',
      'engagement_events.engagement_events_no_delete',
      'engagement_events.engagement_events_no_update',
      'login_events.login_events_no_delete',
      'login_events.login_events_no_update',
    ]);
  });
});
