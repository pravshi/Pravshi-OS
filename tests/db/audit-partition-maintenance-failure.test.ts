/**
 * Phase 12 Wave J (adversarial) — partition maintenance FAILURE-MODE probes.
 *
 * Wave B's suite (audit-partition-maintenance.test.ts) pins the success
 * contract of migration 0062: maintenance completes while writers insert,
 * and concurrent runs serialize idempotently. This suite probes the other
 * half of the 0062 contract — what happens when the contention does NOT
 * clear immediately:
 *
 *   - the call must not return a false success or a partial result while
 *     its advisory lock is held by someone else: it waits inside the
 *     function's lock_timeout + bounded-retry budget (probe A);
 *   - once contention clears inside that budget, the same call completes
 *     and leaves the partition window COMPLETE — every month present, a
 *     repeat call a no-op (probe B);
 *   - under neither outcome may the partition set be left partial: the
 *     relname set is compared exactly before and after.
 *
 * The contention partner is a session-level pg_advisory_lock on the very
 * key the function serializes on (hashtext('ensure-audit-log-partitions'))
 * — deterministic, and it touches no table locks, so audit writers and
 * sibling suites are never blocked by these probes.
 *
 * Deliberate scope limit, recorded honestly: the budget-EXHAUSTION branch
 * (5th failure re-raises 55P03) is not live-probed. Exhaustion takes
 * ~26 s of held lock (5 attempts × 5 s lock_timeout + backoff), and
 * vitest runs test files in parallel — a 26 s hold would starve sibling
 * suites' own maintenance calls (tests/db/audit-logs.test.ts) of THEIR
 * retry budgets and flake them. The holds here (≤ ~11 s) cost a sibling
 * call at most two attempts of its identical budget. The exhaustion
 * branch is pinned by construction: probe A proves attempts are consumed
 * (the call survives past one full 5 s attempt without resolving), the
 * retry cap and re-raise are in the 0062 body, and 0062's verification
 * DO block asserts the hardening is present at migration time.
 *
 * Gated behind DB_READY (tests/workflows/helpers.ts), like every live-DB
 * suite: skipped locally, runs on CI.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from '@neondatabase/serverless';

import { DB_READY } from '../workflows/helpers';

const dbReady = DB_READY;
const MAINTENANCE_LOCK = `select pg_advisory_lock(hashtext('ensure-audit-log-partitions'))`;
const MAINTENANCE_UNLOCK = `select pg_advisory_unlock(hashtext('ensure-audit-log-partitions'))`;

describe.skipIf(!dbReady)('audit partition maintenance — failure modes (Phase 12 Wave J)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

  afterAll(async () => {
    if (!dbReady) return;
    await owner.end();
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const partitionNames = async (): Promise<string[]> => {
    const res = await owner.query<{ relname: string }>(
      `select c.relname from pg_class c
        join pg_inherits i on i.inhrelid = c.oid
        join pg_class p on p.oid = i.inhparent
        join pg_namespace n on n.oid = c.relnamespace
       where p.relname = 'audit_logs' and n.nspname = 'public'
       order by c.relname`,
    );
    return res.rows.map((r) => r.relname);
  };

  /** Expected child names for the window [current month, +months]. */
  const windowNames = async (months: number): Promise<string[]> => {
    const res = await owner.query<{ name: string }>(
      `select 'audit_logs_' || to_char(
                date_trunc('month', now()) + make_interval(months => g), 'YYYY_MM') as name
         from generate_series(0, $1) g
        order by name`,
      [months],
    );
    return res.rows.map((r) => r.name);
  };

  const ensure = async (months: number): Promise<number> => {
    const res = await owner.query<{ created: number }>(
      `select public.ensure_audit_log_partitions($1) created`,
      [months],
    );
    return res.rows[0]!.created;
  };

  /** Hold the maintenance advisory lock on a dedicated session. */
  const holdMaintenanceLock = async (): Promise<PoolClient> => {
    const client = await owner.connect();
    await client.query(MAINTENANCE_LOCK);
    return client;
  };

  const releaseMaintenanceLock = async (client: PoolClient): Promise<void> => {
    try {
      await client.query(MAINTENANCE_UNLOCK);
    } finally {
      client.release();
    }
  };

  it('under a held maintenance lock: no early success, no partial set — completes once released', async () => {
    // Baseline: the window is complete before contention starts.
    await ensure(18);
    const before = await partitionNames();
    for (const name of await windowNames(18)) expect(before).toContain(name);

    const partner = await holdMaintenanceLock();
    let settled = false;
    let created: number | undefined;
    let failure: unknown = null;
    const call = ensure(18).then(
      (n) => {
        settled = true;
        created = n;
      },
      (err) => {
        settled = true;
        failure = err;
      },
    );
    try {
      // One full attempt cycle is 5 s of lock_timeout. At 5.5 s the call
      // must STILL be inside its retry budget: not resolved (no false or
      // partial success) and not rejected (the budget is not exhausted).
      await sleep(5_500);
      expect(settled).toBe(false);
      // The partition set is untouched while the call is contended.
      expect(await partitionNames()).toEqual(before);
    } finally {
      await releaseMaintenanceLock(partner);
    }
    await call;
    expect(failure).toBeNull();
    expect(created).toBe(0); // the window was already complete
    expect(await partitionNames()).toEqual(before);
  }, 60_000);

  it('contention clearing inside the retry budget: the call completes and the window is whole', async () => {
    // Find the smallest window that is NOT yet fully present, so this
    // call genuinely has partitions to create once it gets the lock.
    let target = -1;
    for (let m = 18; m <= 36; m += 1) {
      const existing = new Set(await partitionNames());
      const expected = await windowNames(m);
      if (!expected.every((n) => existing.has(n))) {
        target = m;
        break;
      }
    }
    expect(target).toBeGreaterThanOrEqual(18);

    const partner = await holdMaintenanceLock();
    const call = ensure(target);
    try {
      // Attempts 1–2 time out at ~5 s and ~10.1 s; attempt 3 starts at
      // ~10.3 s. Releasing at ~10.8 s lands inside attempt 3's wait, so
      // the SAME call must acquire and finish — no caller retry involved.
      await sleep(10_800);
    } finally {
      await releaseMaintenanceLock(partner);
    }
    const created = await call;
    expect(created).toBeGreaterThanOrEqual(0);

    // The window is complete afterwards — never a partial subset — and a
    // repeat call creates nothing.
    const after = new Set(await partitionNames());
    for (const name of await windowNames(target)) expect(after.has(name)).toBe(true);
    expect(await ensure(target)).toBe(0);
  }, 60_000);
});
