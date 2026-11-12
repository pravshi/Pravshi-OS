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

  /**
   * The relations among audit_logs / organizations / people a backend holds any lock on, read in a
   * query of its own. Used only by `twoQueryObservation` below, which reproduces the observer this
   * file used before: a wait state and a lock list from two separate round trips.
   */
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
   * ── OBSERVING THE MAINTENANCE BACKEND ─────────────────────────────────────────────
   *
   * The question is "does maintenance hold a contended lock WHILE it backs off (or waits)?". The
   * wait state (pg_stat_activity) and the held locks (pg_locks) are two separate views; read in two
   * round trips, a backend that wakes between them is caught holding the lock its NEXT attempt took
   * — 0075 locks organizations, then fails NOWAIT on people and releases it, between back-offs — and
   * that observation is wrongly reported as "held during back-off" (CI run 42746800790, attempt 1:
   * ["organizations:ShareRowExclusiveLock"]).
   *
   * So one call, on one dedicated session, reads the wait state, then the locks, then the wait state
   * again (each a separate statement, in order; the wait event is read live from the backend, and
   * the statistics snapshot is cleared before each read so the backend list is current too). A lock
   * list counts as "held during back-off" only when the backend was sleeping on BOTH sides of the
   * lock read, and as "held while waiting" only when it was in a lock wait on both sides; an
   * observation whose wait state changed during the call is a transition and proves nothing.
   *
   * That narrows the race; it does not close it: a backend can wake from one back-off, be caught by
   * the lock read mid-attempt, and be asleep in the NEXT back-off by the second read. So a lock seen
   * in a back-off (or wait) is recorded only when a second observation, taken at once, sees the same
   * verdict and the same lock (observeConfirmed). The straddle is not expected to repeat: the second
   * call lands inside the new back-off (≥ 50 ms in 0075), where nothing is held. If the second call
   * sees a different verdict (the sleep or wait ended in between), the pair proves nothing and the
   * second observation is returned, so callers sample again rather than accept an unconfirmed
   * "clean" back-off. A lock really held across a back-off or a lock wait is seen by both calls
   * whenever both land inside it, and is seen on a later sample otherwise: nothing is weakened.
   * The residual — the observer
   * descheduled for longer than a whole back-off AND caught mid-attempt twice in a row — is not
   * zero, only far smaller. The function lives in pg_temp — private to the observer session,
   * invisible to every guard.
   */
  type WaitState = { type: string | null; event: string | null };
  type Observation = { before: WaitState; held: string[]; after: WaitState };
  type Verdict = 'backing-off' | 'waiting-on-lock' | 'transition' | 'other';

  /** The rule, separate from the database so it can be tested directly. */
  const classify = (o: Observation): Verdict => {
    if (o.before.event === 'PgSleep' && o.after.event === 'PgSleep') return 'backing-off';
    if (o.before.type === 'Lock' && o.after.type === 'Lock') return 'waiting-on-lock';
    if (o.before.type !== o.after.type || o.before.event !== o.after.event) return 'transition';
    return 'other';
  };

  /**
   * Two consecutive observations combined: with the same verdict, the first with only the locks
   * both saw; with different verdicts, nothing is proven and the newer observation stands.
   */
  const confirm = (first: Observation, second: Observation): Observation =>
    classify(first) === classify(second)
      ? { ...first, held: first.held.filter((l) => second.held.includes(l)) }
      : second;

  let observer: PoolClient | undefined;
  /** One consistent observation of backend `pid` (see above). */
  const observe = async (pid: number): Promise<Observation> => {
    const r = (
      await observer!.query<{
        before_type: string | null;
        before_event: string | null;
        held: string[];
        after_type: string | null;
        after_event: string | null;
      }>(`select * from pg_temp.lock_observation($1)`, [pid])
    ).rows[0]!;
    return {
      before: { type: r.before_type, event: r.before_event },
      held: r.held,
      after: { type: r.after_type, event: r.after_event },
    };
  };

  /**
   * An observation whose held locks, in a back-off or a lock wait, are confirmed by a second
   * observation taken at once (see above). Any other observation is returned as it is.
   */
  const observeConfirmed = async (pid: number): Promise<Observation> => {
    const o = await observe(pid);
    const verdict = classify(o);
    if (o.held.length === 0 || (verdict !== 'backing-off' && verdict !== 'waiting-on-lock'))
      return o;
    return confirm(o, await observe(pid));
  };

  /** The previous observer, kept only to reproduce its false positive in the regression test. */
  const twoQueryObservation = async (pid: number, between: () => Promise<unknown>) => {
    const a = (
      await owner.query<{ wait_event: string | null }>(
        `select wait_event from pg_stat_activity where pid = $1`,
        [pid],
      )
    ).rows[0];
    await between();
    return { event: a?.wait_event ?? null, held: await heldBy(pid) };
  };

  /**
   * Wait until the maintenance backend is in its retry back-off — it met a lock conflict and let
   * go — and assert it holds nothing an application transaction could need. Fails, naming what it
   * holds, if it is ever seen WAITING on a lock instead (the pre-0075 behaviour).
   */
  async function untilBackingOff(pid: number) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const o = await observeConfirmed(pid);
      const verdict = classify(o);
      if (verdict === 'backing-off') {
        expect(o.held, 'maintenance holds no lock while backing off').toEqual([]);
        return;
      }
      if (verdict === 'waiting-on-lock') {
        throw new Error(
          `maintenance is WAITING on a lock while holding: ${o.held.join(', ') || 'nothing listed'}`,
        );
      }
      if (Date.now() > deadline) throw new Error('maintenance never reached its back-off');
      await sleep(10);
    }
  }

  /**
   * Observe the maintenance backend until its call settles. Every observation in back-off
   * (PgSleep) records the contended locks it holds; every observation WAITING on a lock records
   * what it holds while waiting. Both lists must stay empty for a correct implementation.
   */
  async function watchUntilSettled(pid: number, done: Promise<unknown>) {
    let settled = false;
    void done.finally(() => {
      settled = true;
    });
    const out = {
      backoffs: 0,
      heldDuringBackoff: [] as string[],
      waitsWhileHolding: [] as string[],
    };
    while (!settled) {
      const o = await observeConfirmed(pid);
      const verdict = classify(o);
      if (verdict === 'backing-off') {
        out.backoffs += 1;
        out.heldDuringBackoff.push(...o.held);
      } else if (verdict === 'waiting-on-lock') {
        out.waitsWhileHolding.push(
          o.held.length ? o.held.join(', ') : '(waiting, holding none listed)',
        );
        // One record per distinct wait is enough to fail; keep the list small.
        if (out.waitsWhileHolding.length >= 3) break;
      }
      await sleep(10);
    }
    return out;
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
    observer = await owner.connect();
    await observer.query(`
      create function pg_temp.lock_observation(p_pid int)
      returns table (before_type text, before_event text, held text[], after_type text, after_event text)
      language plpgsql volatile as $f$
      begin
        perform pg_stat_clear_snapshot();
        select a.wait_event_type, a.wait_event into before_type, before_event
          from pg_stat_activity a where a.pid = p_pid;
        select coalesce(array_agg(distinct c.relname || ':' || l.mode
                                  order by c.relname || ':' || l.mode), '{}')
          into held
          from pg_locks l join pg_class c on c.oid = l.relation
         where l.pid = p_pid and l.granted and c.relname in ('audit_logs', 'organizations', 'people');
        perform pg_stat_clear_snapshot();
        select a.wait_event_type, a.wait_event into after_type, after_event
          from pg_stat_activity a where a.pid = p_pid;
        return next;
      end
      $f$`);
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
    observer?.release();
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
      // Watched for its whole run, not just once: at every observed back-off it must hold none of
      // the contended locks, and it must never be seen WAITING on a lock. The pre-0075 function
      // also ends in 55P03 here — after waiting on people while holding audit_logs — so it is this
      // watch, not the error code, that tells the two apart.
      const watched = await watchUntilSettled(first.pid, first.done);
      expect(watched.waitsWhileHolding, 'maintenance waited on a lock while holding').toEqual([]);
      expect(watched.heldDuringBackoff, 'locks held during back-off').toEqual([]);
      expect(watched.backoffs, 'back-offs observed').toBeGreaterThanOrEqual(1);
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

  describe('the observer itself (regression: CI run 42746800790, attempt 1)', () => {
    const until = async (probe: () => Promise<Observation>, want: Verdict, label: string) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const o = await probe();
        if (classify(o) === want) return o;
        if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
        await sleep(10);
      }
    };
    const SRE = 'organizations:ShareRowExclusiveLock';

    it('concludes only from a wait state seen on both sides of the lock read', () => {
      const sleeping = { type: 'Timeout', event: 'PgSleep' };
      const waiting = { type: 'Lock', event: 'relation' };
      const idle = { type: 'Client', event: 'ClientRead' };
      const running = { type: null, event: null };
      expect(classify({ before: sleeping, held: [SRE], after: sleeping })).toBe('backing-off');
      expect(classify({ before: waiting, held: [SRE], after: waiting })).toBe('waiting-on-lock');
      // Woke between the reads and took its next attempt's lock: no conclusion either way.
      expect(classify({ before: sleeping, held: [SRE], after: running })).toBe('transition');
      expect(classify({ before: sleeping, held: [SRE], after: idle })).toBe('transition');
      expect(classify({ before: running, held: [SRE], after: sleeping })).toBe('transition');
      // The lock wait ended between the reads (granted, or the statement moved on): no conclusion.
      expect(classify({ before: waiting, held: [SRE], after: running })).toBe('transition');
      expect(classify({ before: running, held: [SRE], after: waiting })).toBe('transition');
      expect(classify({ before: idle, held: [], after: idle })).toBe('other');
    });

    it('records a lock only when a second observation confirms it (the residual straddle)', () => {
      const sleeping = { type: 'Timeout', event: 'PgSleep' };
      const waiting = { type: 'Lock', event: 'relation' };
      const running = { type: null, event: null };
      const asleep = (held: string[]) => ({ before: sleeping, held, after: sleeping });
      // Woke, caught mid-attempt, asleep again by the second read; the next call sees nothing held.
      expect(confirm(asleep([SRE]), asleep([])).held).toEqual([]);
      // The second call caught a different moment (the sleep ended): nothing is proven — the newer
      // observation stands, so the caller samples again instead of accepting a "clean" back-off.
      const woke = { before: sleeping, held: [SRE], after: running };
      expect(confirm(asleep([SRE]), woke)).toEqual(woke);
      expect(classify(confirm(asleep([SRE]), woke))).toBe('transition');
      // Really held across the back-off, or across a lock wait: confirmed.
      expect(confirm(asleep([SRE]), asleep([SRE])).held).toEqual([SRE]);
      const blocked = { before: waiting, held: [SRE], after: waiting };
      expect(confirm(blocked, blocked)).toEqual(blocked);
    });

    it('reproduces the two-query false positive; the lock-holding state after it is not a back-off', async () => {
      const x = await session(); // a scripted stand-in for one maintenance back-off and next attempt
      try {
        await x.c.query('begin');
        const napping = x.c.query('select pg_sleep(2)');
        napping.catch(() => undefined); // awaited below; only silences a failing run's noise
        const during = await until(() => observe(x.pid), 'backing-off', 'the scripted back-off');
        expect(during.held, 'nothing is held during the scripted back-off').toEqual([]);
        // The previous observer, with the backend's next step landing between its two queries —
        // what a slow CI runner did: wake, then lock organizations (0075's first lock).
        const twoQuery = await twoQueryObservation(x.pid, async () => {
          await napping;
          await x.c.query('lock table public.organizations in share row exclusive mode');
        });
        expect(twoQuery, 'two queries report a lock "held during back-off"').toEqual({
          event: 'PgSleep',
          held: [SRE],
        });
        // The same backend in one call: it holds the lock, and it is not backing off.
        const now = await observe(x.pid);
        expect(now.held).toEqual([SRE]);
        expect(classify(now)).not.toBe('backing-off');
      } finally {
        await x.c.query('rollback').catch(() => undefined);
        x.c.release();
      }
    });

    it('still reports a lock really held while sleeping, and one held while waiting', async () => {
      const x = await session();
      const y = await session();
      try {
        await x.c.query('begin');
        await x.c.query('lock table public.organizations in share row exclusive mode');
        const napping = x.c.query('select pg_sleep(2)');
        napping.catch(() => undefined); // awaited below; only silences a failing run's noise
        const asleep = await until(
          () => observeConfirmed(x.pid),
          'backing-off',
          'sleeping while holding',
        );
        expect(asleep.held, 'held during back-off is still seen').toEqual([SRE]);
        await napping;
        await y.c.query('begin');
        await y.c.query('select pg_advisory_xact_lock(750089)');
        const blocked = x.c.query('select pg_advisory_xact_lock(750089)');
        blocked.catch(() => undefined); // awaited below; only silences a failing run's noise
        const stuck = await until(
          () => observeConfirmed(x.pid),
          'waiting-on-lock',
          'waiting while holding',
        );
        expect(stuck.held, 'held while waiting is still seen').toEqual([SRE]);
        await y.c.query('rollback');
        await blocked;
      } finally {
        await y.c.query('rollback').catch(() => undefined);
        await x.c.query('rollback').catch(() => undefined);
        y.c.release();
        x.c.release();
      }
    });
  });
});
