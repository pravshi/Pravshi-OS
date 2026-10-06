/**
 * Phase 6 — Retry sweeper tests (closes the DESIGN GAP flagged in
 * failure-resilience.test.ts: retryable failures parked in 'failed' with a
 * backoff next_run_at, but nothing automatically re-drove failed→pending).
 *
 * Real module under test: sweepRetryableJobs (src/lib/jobs/retry-sweeper.ts).
 *
 * Mocked at the module boundary (repo convention, cf. failure-resilience.test.ts):
 *   - '@/lib/db/pool' → fake connectWithWake
 *   - 'drizzle-orm/neon-serverless' → a tiny SQL interpreter that applies the
 *     public.jobs_sweep_retryable() call (migration 0049, SECURITY DEFINER)
 *     to an in-memory store, honoring the real function's semantics:
 *     status='failed' AND next_run_at <= now() AND attempts < max_attempts,
 *     oldest-due first, bounded by the bound p_limit parameter, guarded to
 *     status='failed' at flip time (the atomicity analog of the single-statement
 *     UPDATE vs. a manual retryJob winning).
 *
 * The two properties only real Postgres can prove (the exact id-subquery
 * plan against the real schema, and a true concurrent manual-retry race)
 * cannot live in this file: its file-scoped vi.mock('@/lib/db/pool') would
 * route any DB-gated block through the in-memory mock store instead of
 * Postgres. They live in the mock-free companion
 * tests/jobs/retry-sweeper-live.test.ts (describe.skipIf(!DB_READY)).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── In-memory fake store (vi.hoisted so mock factories can close over it) ────

const hoisted = vi.hoisted(() => {
  interface FakeJob {
    id: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    nextRunAtMs: number;
    claimedBy: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  }

  const jobs = new Map<string, FakeJob>();
  let seq = 0;
  let failNext: Error | null = null;

  function seedJob(overrides: Partial<FakeJob> = {}): FakeJob {
    seq += 1;
    const job: FakeJob = {
      id: `sweep-job-${String(seq).padStart(4, '0')}`,
      status: 'failed',
      attempts: 1,
      maxAttempts: 5,
      nextRunAtMs: Date.now() - 60_000, // backoff already elapsed
      claimedBy: null,
      errorCode: 'ETIMEDOUT',
      errorMessage: 'connect ETIMEDOUT',
      ...overrides,
    };
    jobs.set(job.id, job);
    return job;
  }

  function renderSql(q: unknown): { sql: string; params: unknown[] } {
    const queryable = q as {
      toQuery: (cfg: Record<string, unknown>) => { sql: string; params: unknown[] };
    };
    return queryable.toQuery({
      casing: undefined,
      escapeName: (name: string) => `"${name}"`,
      escapeParam: (index: number) => `$${index + 1}`,
      escapeString: (str: string) => `'${str}'`,
    });
  }

  function interpret(
    sqlText: string,
    params: unknown[],
  ): { rows: Array<{ swept: string }>; rowCount: number } {
    if (failNext) {
      const err = failNext;
      failNext = null;
      throw err;
    }
    if (sqlText.includes('jobs_sweep_retryable')) {
      // The limit arrives as the bound p_limit parameter (no literal in the
      // SQL text anymore — the function validates and applies it).
      const limit = Number(params[0] ?? 100);
      const now = Date.now();
      const eligible = [...jobs.values()]
        .filter((j) => j.status === 'failed' && j.nextRunAtMs <= now && j.attempts < j.maxAttempts)
        .sort((a, b) => a.nextRunAtMs - b.nextRunAtMs || a.id.localeCompare(b.id));
      const picked = eligible.slice(0, limit);
      let n = 0;
      for (const j of picked) {
        // Atomic-statement analog: the outer WHERE re-checks status='failed' —
        // if a manual retryJob flipped it to 'pending' first, the sweep skips it.
        if (j.status !== 'failed') continue;
        j.status = 'pending';
        j.claimedBy = null;
        j.nextRunAtMs = now;
        n += 1;
      }
      // The real module reads Number(rows[0].swept); the mock mirrors that shape.
      return { rows: [{ swept: String(n) }], rowCount: 1 };
    }
    throw new Error(`retry-sweeper mock: unhandled SQL: ${sqlText.slice(0, 220)}`);
  }

  function reset(): void {
    jobs.clear();
    seq = 0;
    failNext = null;
    executed.length = 0;
  }

  function armFailure(err: Error): void {
    failNext = err;
  }

  const executed: Array<{ sql: string; params: unknown[] }> = [];

  return {
    jobs,
    seedJob,
    renderSql,
    interpret,
    reset,
    armFailure,
    executed,
    releaseClient: vi.fn(),
  };
});

vi.mock('@/lib/db/pool', () => ({
  connectWithWake: vi.fn(async () => ({ release: hoisted.releaseClient })),
}));

vi.mock('drizzle-orm/neon-serverless', () => ({
  drizzle: () => ({
    transaction: async (
      fn: (tx: { execute: (q: unknown) => Promise<unknown> }) => Promise<unknown>,
    ) =>
      fn({
        execute: async (q: unknown) => {
          const rendered = hoisted.renderSql(q);
          hoisted.executed.push({ sql: rendered.sql, params: rendered.params });
          return hoisted.interpret(rendered.sql, rendered.params);
        },
      }),
  }),
}));

// ── Real modules under test ─────────────────────────────────────────────────

import { sweepRetryableJobs } from '@/lib/jobs/retry-sweeper';
import { canTransitionJob } from '@/lib/jobs/types';

beforeEach(() => {
  hoisted.reset();
  vi.clearAllMocks();
});

// ── sweepRetryableJobs ──────────────────────────────────────────────────────

describe('sweepRetryableJobs', () => {
  it('calls the SECURITY DEFINER sweep function with the bound limit (never a raw UPDATE)', async () => {
    hoisted.seedJob();

    expect(await sweepRetryableJobs(25)).toBe(1);
    expect(hoisted.executed).toHaveLength(1);
    const stmt = hoisted.executed[0]!;
    expect(stmt.sql).toContain('jobs_sweep_retryable');
    expect(stmt.sql).not.toMatch(/update\s+public\.jobs/i);
    expect(stmt.sql).not.toMatch(/update\s+jobs/i);
    expect(stmt.params).toEqual([25]);
  });

  it('binds the default limit of 100 when none is given', async () => {
    hoisted.seedJob();

    await sweepRetryableJobs();

    expect(hoisted.executed).toHaveLength(1);
    expect(hoisted.executed[0]!.params).toEqual([100]);
  });

  it('sweeps a failed job whose backoff elapsed → pending, keeping attempts and the error', async () => {
    const job = hoisted.seedJob();
    const before = Date.now();

    const swept = await sweepRetryableJobs();

    expect(swept).toBe(1);
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(1); // NOT reset — attempts is the exhaustion budget
    expect(job.errorCode).toBe('ETIMEDOUT'); // kept: evidence of why it parked
    expect(job.nextRunAtMs).toBeGreaterThanOrEqual(before);
    expect(job.nextRunAtMs).toBeLessThanOrEqual(Date.now());
  });

  it('leaves a failed job whose backoff has NOT elapsed alone', async () => {
    const job = hoisted.seedJob({ nextRunAtMs: Date.now() + 60_000 });

    expect(await sweepRetryableJobs()).toBe(0);
    expect(job.status).toBe('failed');
  });

  it('does not sweep a failed job at max_attempts (stays for manual dead-letter review)', async () => {
    // Invariant: failJob dead-letters on exhaustion, so a failed row at
    // attempts >= max_attempts is anomalous (e.g. max_attempts lowered after
    // parking) — the sweeper must not re-drive it into an infinite loop.
    const atMax = hoisted.seedJob({ attempts: 5, maxAttempts: 5 });
    const overMax = hoisted.seedJob({ attempts: 6, maxAttempts: 5 });

    expect(await sweepRetryableJobs()).toBe(0);
    expect(atMax.status).toBe('failed');
    expect(overMax.status).toBe('failed');
  });

  it('never resurrects dead_letter jobs', async () => {
    const dead = hoisted.seedJob({ status: 'dead_letter', attempts: 4, maxAttempts: 5 });

    expect(await sweepRetryableJobs()).toBe(0);
    expect(dead.status).toBe('dead_letter');
  });

  it('ignores jobs already pending (not double-driven)', async () => {
    const pending = hoisted.seedJob({ status: 'pending', errorCode: null });

    expect(await sweepRetryableJobs()).toBe(0);
    expect(pending.status).toBe('pending');
  });

  it('respects the limit and drains oldest-due first', async () => {
    const now = Date.now();
    const oldest = hoisted.seedJob({ nextRunAtMs: now - 300_000 });
    const middle = hoisted.seedJob({ nextRunAtMs: now - 200_000 });
    hoisted.seedJob({ nextRunAtMs: now - 100_000 });
    const notYet = hoisted.seedJob({ nextRunAtMs: now + 60_000 });

    expect(await sweepRetryableJobs(2)).toBe(2);
    expect(oldest.status).toBe('pending');
    expect(middle.status).toBe('pending');
    expect(notYet.status).toBe('failed');

    expect(await sweepRetryableJobs()).toBe(1); // the third eligible row
  });

  it('uses the default limit of 100 when none is given', async () => {
    for (let i = 0; i < 3; i += 1) hoisted.seedJob();
    expect(await sweepRetryableJobs()).toBe(3);
  });

  it('does not touch a job a manual retry already replayed (race guard)', async () => {
    const job = hoisted.seedJob();
    // Simulate POST /api/jobs/[id]/retry winning the race: row is now
    // 'pending' with a fresh attempt budget — the atomic status='failed'
    // guard must make the sweep a no-op for it.
    job.status = 'pending';
    job.attempts = 0;
    job.errorCode = null;
    job.nextRunAtMs = Date.now();

    expect(await sweepRetryableJobs()).toBe(0);
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(job.errorCode).toBeNull();
  });

  it('rejects an invalid limit before touching the DB', async () => {
    await expect(sweepRetryableJobs(0)).rejects.toThrow(/INVALID_REQUEST/);
    expect(hoisted.releaseClient).not.toHaveBeenCalled(); // validation happens first
  });

  it('propagates DB errors (runWorker swallows them so the loop survives)', async () => {
    hoisted.seedJob();
    hoisted.armFailure(new Error('db blip'));
    await expect(sweepRetryableJobs()).rejects.toThrow('db blip');
  });

  it('failed → pending is a valid state-machine transition', () => {
    expect(canTransitionJob('failed', 'pending')).toBe(true);
    expect(canTransitionJob('dead_letter', 'pending')).toBe(true); // manual path only
  });
});
