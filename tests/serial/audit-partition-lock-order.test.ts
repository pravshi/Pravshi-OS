/**
 * Audit-partition maintenance never waits while holding a lock an application transaction needs
 * (migration 0075). LIVE DB, real concurrent sessions, deterministic synchronisation.
 *
 * Creating an audit_logs partition locks audit_logs (ACCESS EXCLUSIVE) and the two tables its
 * foreign keys reference, organizations and people (SHARE ROW EXCLUSIVE). Application
 * transactions write organizations or people first and audit after. Before 0075 maintenance took
 * audit_logs first and then WAITED for the referenced tables while holding it: a deadlock with
 * the application (Postgres killed the application side), and every audit insert in the system
 * queued behind it meanwhile.
 *
 * Each case below holds an application transaction open after its organizations/people write,
 * starts maintenance on another session, and waits — deterministically, by polling the
 * maintenance backend — until maintenance is in its retry back-off (pg_sleep): proof its NOWAIT
 * acquisition met the conflict. At that moment the maintenance backend must hold NO lock on
 * audit_logs, organizations or people; if it is ever seen waiting on a lock instead, the case
 * fails and names what it holds. Then the application performs its audit write (which must not
 * block), commits with exactly one audit entry, and maintenance completes, creating the partition.
 *
 * Runs in the 'serial' vitest project, first and alone: it creates and drops partitions (other
 * suites assert exact windows) and rehearses the once-per-database bootstrap (other suites need
 * an unbootstrapped database). It records the partition set first and drops every partition it
 * created at the end, all of them empty and in the future.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from '@neondatabase/serverless';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { DB_READY, mkOrg, mkPerson, RUN } from '../workflows/helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!DB_READY)('audit-partition maintenance lock order (0075, live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE, max: 8 });
  let baseline = new Set<string>();
  let org = '';
  let actor = '';

  const partitions = async () =>
    new Set(
      (
        await owner.query<{ relname: string }>(
          `select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
            where i.inhparent = 'public.audit_logs'::regclass`,
        )
      ).rows.map((r) => r.relname),
    );
  const monthName = async (m: number) =>
    (
      await owner.query<{ n: string }>(
        `select 'audit_logs_' || to_char(date_trunc('month', now()) + make_interval(months => $1::int), 'YYYY_MM') n`,
        [m],
      )
    ).rows[0]!.n;
  /** The smallest month offset with no partition: ensure(m) then creates exactly that one. */
  const nextMissing = async () => {
    const have = await partitions();
    for (let m = 0; m <= 120; m += 1) if (!have.has(await monthName(m))) return m;
    throw new Error('no missing partition within 120 months');
  };

  /** A session, its backend pid, and a transaction on it. */
  const session = async () => {
    const c = await owner.connect();
    const pid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid;
    return { c, pid };
  };
  const asActor = (c: PoolClient, person: string, orgId: string) =>
    c.query(`select set_config('app.person_id', $1, true), set_config('app.org_id', $2, true)`, [
      person,
      orgId,
    ]);
  const audit = (c: PoolClient, action: string, entityType: string, entityId: string) =>
    c.query(
      `select public.write_audit_log(p_action := $1, p_entity_type := $2,
              p_result := 'SUCCESS'::public.audit_result, p_entity_id := $3::uuid, p_severity := 'HIGH')`,
      [action, entityType, entityId],
    );
  const auditRows = async (action: string, entityId: string) =>
    Number(
      (
        await owner.query<{ n: string }>(
          `select count(*)::text n from public.audit_logs where action = $1 and entity_id = $2`,
          [action, entityId],
        )
      ).rows[0]!.n,
    );

  /** The relations among audit_logs / organizations / people a backend holds any lock on. */
  const heldBy = async (pid: number) =>
    (
      await owner.query<{ rel: string }>(
        `select distinct c.relname || ':' || l.mode rel
           from pg_locks l join pg_class c on c.oid = l.relation
          where l.pid = $1 and l.granted and c.relname in ('audit_logs', 'organizations', 'people')
          order by 1`,
        [pid],
      )
    ).rows.map((r) => r.rel);

  /**
   * Wait until the maintenance backend is in its retry back-off — it met a lock conflict and let
   * go — and assert it holds nothing an application transaction could need. Fails, naming what it
   * holds, if it is ever seen WAITING on a lock instead (the pre-0075 behaviour).
   */
  async function untilBackingOff(pid: number) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const a = (
        await owner.query<{ wait_event_type: string | null; wait_event: string | null }>(
          `select wait_event_type, wait_event from pg_stat_activity where pid = $1`,
          [pid],
        )
      ).rows[0];
      if (a?.wait_event === 'PgSleep') {
        expect(await heldBy(pid), 'maintenance holds no lock while backing off').toEqual([]);
        return;
      }
      if (a?.wait_event_type === 'Lock') {
        throw new Error(
          `maintenance is WAITING on a lock while holding: ${(await heldBy(pid)).join(', ') || 'nothing listed'}`,
        );
      }
      if (Date.now() > deadline) throw new Error('maintenance never reached its back-off');
      await sleep(10);
    }
  }

  /** Start maintenance creating month `m` on its own session. */
  const startMaintenance = async (m: number) => {
    const s = await session();
    const done = s.c
      .query<{ created: number }>(`select public.ensure_audit_log_partitions($1) created`, [m])
      .then(
        (r) => ({ created: r.rows[0]!.created, error: null as null | { code?: string } }),
        (e: { code?: string }) => ({ created: -1, error: e }),
      )
      .finally(() => s.c.release());
    return { pid: s.pid, done };
  };

  /** Time a statement; it must not queue behind maintenance. */
  const timed = async <T>(p: Promise<T>) => {
    const t0 = Date.now();
    const v = await p;
    return { v, ms: Date.now() - t0 };
  };

  beforeAll(async () => {
    baseline = await partitions();
    org = await mkOrg(owner, `lock-order-${RUN}`);
    actor = await mkPerson(owner, org, `Lock Order Actor ${RUN}`);
  }, 60_000);

  afterAll(async () => {
    // Leave the window exactly as found: drop what this file created (future, empty).
    for (const name of await partitions()) {
      if (!baseline.has(name)) await owner.query(`drop table public.${name}`);
    }
    expect(await partitions()).toEqual(baseline);
    await owner.end();
  }, 60_000);

  /**
   * The shared shape: `writeFirst` takes the application's organizations/people lock; maintenance
   * starts and backs off; `auditAfter` is the audit write, which must not block; then commit.
   */
  async function contend(
    label: string,
    writeFirst: (c: PoolClient) => Promise<unknown>,
    auditAfter: (c: PoolClient) => Promise<unknown>,
    finish: 'commit' | 'rollback' = 'commit',
  ) {
    const m = await nextMissing();
    const target = await monthName(m);
    const app = await session();
    try {
      await app.c.query('begin');
      await writeFirst(app.c);
      const maintenance = await startMaintenance(m);
      await untilBackingOff(maintenance.pid);
      const { ms } = await timed(auditAfter(app.c));
      expect(ms, `${label}: the audit write did not queue behind maintenance`).toBeLessThan(500);
      await app.c.query(finish);
      const outcome = await maintenance.done;
      expect(outcome.error, `${label}: maintenance failed`).toBeNull();
      expect(outcome.created, `${label}: maintenance created the partition`).toBe(1);
      expect((await partitions()).has(target)).toBe(true);
    } catch (e) {
      await app.c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      app.c.release();
    }
  }

  it('an organization insert followed by its audit entry: commits with one entry; the partition is created', async () => {
    const slug = `lock-org-${RUN}-${randomBytes(3).toString('hex')}`;
    let newOrg = '';
    await contend(
      'organization insert',
      async (c) => {
        newOrg = (
          await c.query<{ id: string }>(
            `insert into public.organizations (name, slug) values ($1, $2) returning id`,
            [`Lock Org ${slug}`, slug],
          )
        ).rows[0]!.id;
      },
      async (c) => {
        await asActor(c, actor, org);
        await audit(c, 'organization.created', 'organization', newOrg);
      },
    );
    expect(await auditRows('organization.created', newOrg)).toBe(1);
    expect(
      (await owner.query(`select 1 from public.organizations where id = $1`, [newOrg])).rowCount,
    ).toBe(1);
  });

  it('a people update followed by write_audit_log (session revoke-all): commits with one entry', async () => {
    const target = await mkPerson(owner, org, `Lock Order Revoked ${RUN}`);
    const login = (
      await owner.query<{ id: string }>(
        `insert into auth.auth_users (name, email) values ('Lock Order', $1) returning id`,
        [`lock.order.${randomBytes(4).toString('hex')}@example.test`],
      )
    ).rows[0]!.id;
    await owner.query(`update public.people set auth_user_id = $1 where id = $2`, [login, target]);
    await contend(
      'session revoke-all',
      // As authz.admin_session_action does it: the stamp, actor-less, then the audit entry.
      (c) => c.query(`select authz.stamp_sessions_revoked($1)`, [login]),
      async (c) => {
        await asActor(c, actor, org);
        await audit(c, 'session.revoked_all', 'person', target);
      },
    );
    expect(await auditRows('session.revoked_all', target)).toBe(1);
    const stamped = await owner.query<{ s: boolean }>(
      `select sessions_revoked_at is not null s from public.people where id = $1`,
      [target],
    );
    expect(stamped.rows[0]!.s).toBe(true);
  });

  it('a people update that fires the row-audit trigger: commits with one trigger entry', async () => {
    const target = await mkPerson(owner, org, `Lock Order Trigger ${RUN}`);
    const before = Number(
      (
        await owner.query<{ n: string }>(
          `select count(*)::text n from public.audit_logs where entity_id = $1`,
          [target],
        )
      ).rows[0]!.n,
    );
    await contend(
      'people audit trigger',
      // The people lock first, unaudited (no actor: the trigger records nothing) …
      (c) => c.query(`update public.people set updated_at = updated_at where id = $1`, [target]),
      // … then an audited change: the trigger writes the entry into audit_logs.
      async (c) => {
        await asActor(c, actor, org);
        await c.query(`update public.people set sessions_revoked_at = now() where id = $1`, [
          target,
        ]);
      },
    );
    const after = Number(
      (
        await owner.query<{ n: string }>(
          `select count(*)::text n from public.audit_logs where entity_id = $1`,
          [target],
        )
      ).rows[0]!.n,
    );
    expect(after - before).toBe(1);
  });

  it('organization bootstrap: the whole transaction runs through without blocking (rolled back: once per database)', async () => {
    // Bootstrap is once per database and other suites need it undone, so this transaction is
    // rolled back at the end — after every statement, the audit write included, has completed
    // without queueing behind maintenance, and the entry is visible inside it.
    const token = randomBytes(32).toString('base64url');
    let boot = { organization_id: '', owner_person_id: '' };
    let seenInside = 0;
    await contend(
      'bootstrap',
      async (c) => {
        boot = (
          await c.query<{ organization_id: string; owner_person_id: string }>(
            `select organization_id, owner_person_id
               from public.bootstrap_organization($1, $2, $3, $4, decode($5, 'hex'))`,
            [
              `Lock Order Boot ${RUN}`,
              `lock-boot-${RUN}`,
              'Lock Owner',
              `lock.owner.${RUN}@example.test`,
              createHash('sha256').update(token, 'utf8').digest('hex'),
            ],
          )
        ).rows[0]!;
      },
      async (c) => {
        await asActor(c, boot.owner_person_id, boot.organization_id);
        await audit(c, 'organization.bootstrap_probe', 'organization', boot.organization_id);
        seenInside = Number(
          (
            await c.query<{ n: string }>(
              `select count(*)::text n from public.audit_logs
                where action = 'organization.bootstrap_probe' and entity_id = $1`,
              [boot.organization_id],
            )
          ).rows[0]!.n,
        );
      },
      'rollback',
    );
    expect(seenInside).toBe(1);
    expect(
      Number(
        (await owner.query<{ n: string }>(`select count(*)::text n from public.bootstrap_state`))
          .rows[0]!.n,
      ),
    ).toBe(0);
  });

  it('an unrelated audit insert while maintenance contends: it does not queue behind maintenance', async () => {
    const m = await nextMissing();
    const target = await monthName(m);
    const holder = await session();
    const other = await session();
    try {
      await holder.c.query('begin');
      // An open organizations write elsewhere: what makes maintenance contend.
      await holder.c.query(`update public.organizations set name = name where id = $1`, [org]);
      const maintenance = await startMaintenance(m);
      await untilBackingOff(maintenance.pid);
      const entity = randomUUID();
      const { ms } = await timed(
        (async () => {
          await other.c.query('begin');
          await asActor(other.c, actor, org);
          await audit(other.c, 'probe.unrelated', 'organization', entity);
          await other.c.query('commit');
        })(),
      );
      expect(ms, 'an unrelated audit insert completes promptly').toBeLessThan(500);
      expect(await auditRows('probe.unrelated', entity)).toBe(1);
      await holder.c.query('commit');
      const outcome = await maintenance.done;
      expect(outcome.error).toBeNull();
      expect(outcome.created).toBe(1);
      expect((await partitions()).has(target)).toBe(true);
    } finally {
      await holder.c.query('rollback').catch(() => undefined);
      await other.c.query('rollback').catch(() => undefined);
      holder.c.release();
      other.c.release();
    }
  });

  it('retry exhaustion under a lock held throughout: 55P03, nothing partial; recovery once it is released', async () => {
    const m = await nextMissing();
    const target = await monthName(m);
    const victim = await mkPerson(owner, org, `Lock Order Exhaust ${RUN}`);
    const holder = await session();
    try {
      await holder.c.query('begin');
      await holder.c.query(`update public.people set updated_at = updated_at where id = $1`, [
        victim,
      ]);
      // Held for longer than every attempt and back-off together (≈2.3 s).
      const first = await startMaintenance(m);
      const outcome = await first.done;
      expect(outcome.error?.code).toBe('55P03'); // lock_not_available, re-raised after 10 attempts
      expect((await partitions()).has(target), 'no partition was half-created').toBe(false);
      // The application transaction was never disturbed: it audits and commits normally.
      await asActor(holder.c, actor, org);
      await audit(holder.c, 'probe.exhaustion', 'person', victim);
      await holder.c.query('commit');
      expect(await auditRows('probe.exhaustion', victim)).toBe(1);
      // Recovery: the next run, with the lock gone, creates the partition.
      const second = await startMaintenance(m);
      const recovered = await second.done;
      expect(recovered.error).toBeNull();
      expect(recovered.created).toBe(1);
      expect((await partitions()).has(target)).toBe(true);
    } finally {
      await holder.c.query('rollback').catch(() => undefined);
      holder.c.release();
    }
  }, 30_000);

  it('a run with nothing to create takes no table lock at all', async () => {
    const holder = await session();
    try {
      await holder.c.query('begin');
      await holder.c.query(`update public.people set updated_at = updated_at where id = $1`, [
        actor,
      ]);
      // Every month up to the current window end already exists: an immediate no-op, not a
      // contention (it would otherwise back off against the open people write above).
      const have = await partitions();
      let window = 0;
      while (have.has(await monthName(window + 1))) window += 1;
      const { v, ms } = await timed(
        owner.query<{ created: number }>(`select public.ensure_audit_log_partitions($1) created`, [
          window,
        ]),
      );
      expect(v.rows[0]!.created).toBe(0);
      expect(ms).toBeLessThan(500);
    } finally {
      await holder.c.query('rollback').catch(() => undefined);
      holder.c.release();
    }
  });
});
