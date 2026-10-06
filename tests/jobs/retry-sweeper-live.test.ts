/**
 * Phase 6 — Retry sweeper LIVE DB tests.
 *
 * Mock-free companion to tests/jobs/retry-sweeper.test.ts. That file carries a
 * file-scoped vi.mock('@/lib/db/pool'), which means any DB-gated block inside
 * it would silently run against the in-memory mock store instead of real
 * Postgres. This file deliberately mocks nothing: it inserts a real 'failed'
 * row into the jobs table and runs the REAL sweepRetryableJobs against a real
 * database connection.
 *
 * Gated behind DB_READY (tests/workflows/helpers.ts): skipped when the
 * DATABASE_URL_MIGRATE / DATABASE_URL_TEST branch env vars are absent
 * (local dev); runs on CI against an ephemeral Neon branch.
 *
 * sweepRetryableJobs is imported dynamically inside beforeAll (which only runs
 * when DB_READY) so that merely loading this file never evaluates the
 * app's env-gated pool module — without DB the suite skips cleanly instead
 * of failing at import time.
 *
 * Properties only real Postgres can prove:
 *   1. The exact id-subquery plan against the real schema (one statement,
 *      count returned, failed→pending flip with attempts/error preserved).
 *   2. The not-due and attempts>=max rows are untouched (defense-in-depth).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

import { DB_READY, mkOrg, RUN } from '../workflows/helpers';

const dbReady = DB_READY;

describe.skipIf(!dbReady)('retry sweeper (live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  let orgId = '';

  // Bound lazily in beforeAll so the real module (and the env-gated pool it
  // imports) is only evaluated when a database is actually available.
  let sweepRetryableJobs: (limit?: number) => Promise<number>;

  beforeAll(async () => {
    if (!dbReady) return;
    ({ sweepRetryableJobs } = await import('@/lib/jobs/retry-sweeper'));
    orgId = await mkOrg(owner, `sweep-${RUN}`);
  }, 30_000);

  afterEach(async () => {
    if (!dbReady) return;
    await owner.query(`delete from public.jobs where org_id = $1::uuid`, [orgId]);
  });

  afterAll(async () => {
    if (!dbReady) return;
    // NOTE: org/role cleanup is intentionally omitted. Inserting an
    // organization auto-seeds undeletable system roles
    // (organizations_seed_system_roles + database.md rule enforced by
    // roles_enforce_protection: "a system role cannot be deleted"), and the
    // org cannot be deleted while those system roles reference it. The
    // established pattern (tests/jobs/jobs-rls.test.ts) is to leave the org
    // behind — the CI ephemeral branch is dropped after the run anyway.
    // The afterEach above already removes this file's jobs rows.
    await owner.end();
  });

  it('sweeps a due failed row to pending in one statement, and returns the count', async () => {
    const ins = await owner.query(
      `insert into public.jobs (org_id, type, status, attempts, max_attempts, next_run_at, error_code)
       values ($1::uuid, 'email', 'failed', 2, 5, now() - interval '1 minute', 'ETIMEDOUT')
       returning id`,
      [orgId],
    );
    const jobId = ins.rows[0].id as string;

    const swept = await sweepRetryableJobs();
    expect(swept).toBe(1);

    const row = (
      await owner.query(
        `select status, attempts, error_code from public.jobs where id = $1::uuid`,
        [jobId],
      )
    ).rows[0];
    expect(row.status).toBe('pending');
    expect(Number(row.attempts)).toBe(2); // attempts preserved
    expect(row.error_code).toBe('ETIMEDOUT'); // error kept
  });

  it('leaves a not-yet-due failed row and an attempts>=max row untouched', async () => {
    await owner.query(
      `insert into public.jobs (org_id, type, status, attempts, max_attempts, next_run_at)
       values ($1::uuid, 'email', 'failed', 1, 5, now() + interval '1 hour'),
              ($1::uuid, 'email', 'failed', 5, 5, now() - interval '1 minute')`,
      [orgId],
    );

    expect(await sweepRetryableJobs()).toBe(0);
  });
});
