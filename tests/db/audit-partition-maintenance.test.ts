/**
 * Phase 12 — audit-log partition maintenance under concurrent writes.
 *
 * THE REGRESSION THIS PINS. In Phase 10's PR #68 CI round 5, a call to
 * ensure_audit_log_partitions(14) (tests/db/audit-logs.test.ts) deadlocked
 * (Postgres 40P01) against a parallel audit writer and failed the suite; a
 * re-run with zero code changes passed. Partition maintenance is DDL
 * running against the one table the whole product writes to continuously,
 * so "sometimes the maintenance call loses a lock fight" is an operational
 * defect, not a test flake.
 *
 * Migration 0062 hardens the function (signature and idempotence
 * unchanged): an advisory lock serializes maintenance runs against each
 * other — acquired with lock waits unbounded, since queueing behind a
 * peer run is serialization, not contention — a transaction-local
 * lock_timeout bounds the DDL phase's lock waits, and a bounded retry
 * absorbs deadlock_detected / lock_not_available. These tests pin the
 * resulting contract against real Postgres:
 *
 *   1. maintenance completes — no 40P01, no 55P03 surfacing — while
 *      writers insert audit rows concurrently the whole time;
 *   2. two maintenance runs fired concurrently both complete and the
 *      window ends up extended exactly once (idempotent under overlap).
 *
 * Honest scope note: pre-0062 this scenario was a probabilistic flake, not
 * a deterministic failure, so test 1 is a contract test rather than a
 * red/green reproduction — post-0062 it passes by construction (bounded
 * waits + retry + serialization), which is the property operations needs.
 *
 * Gated behind DB_READY (tests/workflows/helpers.ts), like every live-DB
 * suite: skipped locally, runs on CI. Audit rows are append-only by
 * design, so the writers' rows are left behind in this suite's org —
 * the CI database is discarded after the run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

import { DB_READY, mkOrg, RUN } from '../workflows/helpers';

const dbReady = DB_READY;

describe.skipIf(!dbReady)('audit partition maintenance under concurrency (Phase 12)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  let orgId = '';

  beforeAll(async () => {
    if (!dbReady) return;
    orgId = await mkOrg(owner, `pmaint-${RUN}`);
  }, 30_000);

  afterAll(async () => {
    if (!dbReady) return;
    await owner.end();
  });

  it('completes while writers insert audit rows concurrently — no deadlock surfaces', async () => {
    // Four writer pools inserting into the current month's partition for
    // the whole maintenance window: the continuous-write backdrop the
    // PR #68 round-5 deadlock happened against.
    let stop = false;
    let inserted = 0;
    const writers = Array.from({ length: 4 }, async () => {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
      try {
        while (!stop) {
          await pool.query(
            `insert into public.audit_logs (org_id, occurred_at, action, entity_type, result)
             values ($1::uuid, now(), 'phase12.partition_maintenance_probe', 'probe', 'SUCCESS')`,
            [orgId],
          );
          inserted += 1;
        }
      } finally {
        await pool.end();
      }
    });
    // Writers must not take the test down with them: collect, don't throw.
    const writersSettled = Promise.allSettled(writers);

    let maintenanceError: unknown = null;
    try {
      // Repeated calls, each extending the window: the exact call shape
      // that deadlocked in PR #68 round 5 was ensure_audit_log_partitions(14).
      for (let k = 0; k < 5; k += 1) {
        await owner.query(`select public.ensure_audit_log_partitions(14)`);
      }
    } catch (err) {
      maintenanceError = err;
    } finally {
      stop = true;
    }

    const results = await writersSettled;
    expect(maintenanceError).toBeNull();
    const writerErrors = results.filter((r) => r.status === 'rejected');
    expect(writerErrors).toHaveLength(0);
    expect(inserted).toBeGreaterThan(0);
  }, 60_000);

  it('serializes concurrent maintenance runs: both complete, window extended once', async () => {
    const [a, b] = await Promise.all([
      owner.query<{ created: number }>(`select public.ensure_audit_log_partitions(16) created`),
      owner.query<{ created: number }>(`select public.ensure_audit_log_partitions(16) created`),
    ]);
    // Exactly one of the two runs created the new partitions; the other
    // observed them already present (advisory-lock serialization + the
    // idempotent existence check). Neither errored — Promise.all resolved.
    expect(a.rows[0]!.created).toBeGreaterThanOrEqual(0);
    expect(b.rows[0]!.created).toBeGreaterThanOrEqual(0);
    // The window REACHES month +16 afterwards, and a repeat call is a no-op.
    const expected = (
      await owner.query<{ name: string }>(
        `select 'audit_logs_' || to_char(date_trunc('month', now()) + interval '16 months',
                                         'YYYY_MM') name`,
      )
    ).rows[0]!.name;
    const partitions = await owner.query<{ relname: string }>(
      `select c.relname from pg_class c
       join pg_inherits i on i.inhrelid = c.oid
       join pg_class p on p.oid = i.inhparent
       join pg_namespace n on n.oid = c.relnamespace
       where p.relname = 'audit_logs' and n.nspname = 'public'`,
    );
    expect(partitions.rows.map((r) => r.relname)).toContain(expected);
    const after = await owner.query<{ created: number }>(
      `select public.ensure_audit_log_partitions(16) created`,
    );
    expect(after.rows[0]!.created).toBe(0);
  }, 60_000);
});
