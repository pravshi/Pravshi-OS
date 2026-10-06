/**
 * Phase 6 Retry Sweeper — automatic re-drive of retryable 'failed' jobs.
 *
 * Owner: Retry Sweeper Engineer. Modified 2026-10-06 by the Worker-Plane
 * Definer Engineer (per Phase 6 orchestration): the sweep now runs through
 * the SECURITY DEFINER function public.jobs_sweep_retryable() (migration
 * 0049) instead of a raw UPDATE.
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────
 * failJob() parks a retryable failure in status='failed' with a backoff
 * next_run_at — but nothing re-drove 'failed' → 'pending', so the job sat
 * inert until an operator hit POST /api/jobs/[id]/retry. This sweeper closes
 * that gap: jobs that are still retryable and whose backoff has elapsed are
 * flipped back to 'pending' by the worker-plane function, so claimJob picks
 * them up on its next poll.
 *
 * ── WHY A NEW MODULE, NOT CODE INSIDE worker.ts ───────────────────────────
 * worker.ts is owned by the Worker Runtime Engineer (its header reserves
 * modification rights), and the sweeper is a distinct worker-plane utility —
 * the same shape as reapStaleJobs(). Keeping it here means the claim/execute
 * loop keeps its contracts untouched; runWorker only gained a ~6-line
 * periodic call site (config.retrySweepIntervalMs).
 *
 * ── PRIVILEGE PATH (migration 0049) ───────────────────────────────────────
 * The sweeper is a global worker-plane loop: it sweeps jobs across ALL orgs
 * and carries no per-request identity, so a plain UPDATE is fail-closed
 * against the FORCED RLS on public.jobs (it would match zero rows forever).
 * The sweep therefore runs through public.jobs_sweep_retryable(p_limit) —
 * SECURITY DEFINER, set search_path='', EXECUTE granted to app_user only.
 * The function is cross-org by design and takes NO org_id; the WHERE clause
 * (status='failed' AND next_run_at <= now() AND attempts < max_attempts) is
 * the safety.
 *
 * ── failed-STATE INVARIANT (from failJob, queue.ts) ────────────────────────
 *   retryable && attempts < max_attempts  →  'failed'   (eligible for re-drive)
 *   otherwise                            →  'dead_letter' (terminal until manual replay)
 *
 * The sweeper preserves that invariant (enforced inside the 0049 function):
 *   - WHERE status='failed'            → never resurrects 'dead_letter'.
 *   - AND attempts < max_attempts      → defense-in-depth: a 'failed' row whose
 *     attempts have reached max (e.g. max_attempts was lowered after the job
 *     parked) is NOT re-driven; it waits for manual review/replay via
 *     POST /api/jobs/[id]/retry (which resets the attempt budget explicitly).
 *   - attempts is NOT reset (unlike manual retryJob, which sets attempts=0):
 *     resetting here would loop forever (sweep→fail→sweep…); the attempts
 *     counter is the exhaustion budget, and failJob dead-letters the job when
 *     attempts reaches max_attempts.
 *   - error_code / error_message are KEPT: they describe the last attempt's
 *     failure and are overwritten by the next failJob; clearing them would
 *     erase the only record of why the job was parked.
 *
 * ── RACE WITH MANUAL RETRY ────────────────────────────────────────────────
 * POST /api/jobs/[id]/retry does SELECT … FOR UPDATE → assert → UPDATE. The
 * 0049 function's outer WHERE repeats the status='failed' guard so the whole
 * flip is one atomic statement: if the manual retry commits first (row now
 * 'pending'), the predicate no longer matches and the row is untouched; if
 * the sweep commits first, the manual retry's assertTransition(pending →
 * pending) throws. Exactly one of them wins — a manually-replayed job can
 * never be "re-swept".
 *
 * ── RUNNING IT ────────────────────────────────────────────────────────────
 * runWorker() calls sweepRetryableJobs() every retrySweepIntervalMs
 * (default 30s; first sweep fires one interval after worker start). A sweep
 * failure (DB blip) is swallowed so it can never kill the worker.
 */

import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import { connectWithWake } from '../db/pool';
import type { Tx } from '../db/authorized';

/** Maximum rows flipped per sweep call. Default 100. */
export const RETRY_SWEEP_DEFAULT_LIMIT = 100;

/** Hard ceiling for the limit (mirrors the 0049 function guard). */
const RETRY_SWEEP_MAX_LIMIT = 10000;

// ── Worker-plane DB (same model as reapStaleJobs in worker.ts) ──────────────

async function withWorkerDb<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await connectWithWake();
  try {
    const db = drizzle(client);
    return await db.transaction(fn);
  } finally {
    client.release();
  }
}

/**
 * Validate the sweep limit before touching the DB — fail fast on a wiring
 * bug. The 0049 function re-validates server-side; this client check avoids
 * opening a connection for a doomed call.
 */
function validateSweepLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > RETRY_SWEEP_MAX_LIMIT) {
    throw new Error(
      `INVALID_REQUEST: limit must be an integer between 1 and ${RETRY_SWEEP_MAX_LIMIT}`,
    );
  }
  return limit;
}

/**
 * Re-drive retryable 'failed' jobs whose backoff has elapsed → 'pending'.
 * Runs through public.jobs_sweep_retryable() (SECURITY DEFINER, migration
 * 0049) — the worker plane carries no per-request identity, so a raw UPDATE
 * would match zero rows under the FORCED RLS on public.jobs.
 * Returns the number of jobs swept. Throws INVALID_REQUEST for a bad limit
 * before touching the DB.
 */
export async function sweepRetryableJobs(
  limit: number = RETRY_SWEEP_DEFAULT_LIMIT,
): Promise<number> {
  const safeLimit = validateSweepLimit(limit);
  const swept = await withWorkerDb(async (tx) => {
    const rows = await tx.execute<{ swept: string }>(
      sql`select public.jobs_sweep_retryable(${safeLimit})::text as swept`,
    );
    return Number(rows.rows[0]?.swept ?? 0);
  });
  return swept;
}
