/**
 * Phase 6 — Production Worker Entrypoint.
 *
 * Owner: Worker Entrypoint Agent. This file wires the Phase 6 job plane into a
 * single long-running production process. Other agents MUST NOT modify it.
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────
 *   pnpm worker                 # start the worker (claims jobs + scheduler ticks)
 *   pnpm worker --help          # print usage without touching env or the DB
 *
 * The `worker` script runs this file with Node's native TypeScript support
 * (`--experimental-transform-types`, needed for parameter properties used in
 * the Phase 5 workflow engine) plus a tiny ESM loader
 * (scripts/worker-loader.mjs) that resolves the `@/` path alias. No
 * tsx/ts-node dependency is required.
 *
 * ── REQUIRED ENV VARS ───────────────────────────────────────────────────────
 * Validated by `@/env` on startup — the process refuses to boot without them:
 *   DATABASE_URL        pooled Neon connection string (host contains "-pooler.")
 *   APP_URL             public app URL
 *   NODE_ENV            development | test | production
 *   BETTER_AUTH_SECRET  >= 32 chars (session signing)
 *
 * Optional:
 *   HEALTH_CHECK_TOKEN  >= 32 chars when set. Optional in src/env.ts: unset
 *                       means /health/db denies everyone (fail-closed). The
 *                       worker's liveness does not depend on it.
 *   SCHEDULER_TICK_MS   scheduler tick interval in ms (default 60000)
 *   HOSTNAME            used in the worker id; falls back to os.hostname()
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 * 1. Imports `./handlers` and `./workflow-jobs` for their side effects: that
 *    registers the notification, webhook, email, cleanup, workflow_run and
 *    scheduled_trigger handlers with the worker runtime.
 * 2. Reaps stale claims once at startup (`reapStaleJobs()`, Phase 12
 *    F-12-02): jobs a previous, dead worker left in 'claimed'/'running' with
 *    a stale claim lease are reset to 'pending' BEFORE the first claim, so a
 *    crashed predecessor's work is recovered immediately instead of waiting
 *    for the in-loop reap (reapIntervalMs, default 5 min) — and lease expiry
 *    no longer depends on per-org cleanup jobs existing. A reap failure is
 *    logged and swallowed; the in-loop reap retries on cadence.
 * 3. Starts `runWorker(config)` — the claim → execute → complete/fail loop.
 *    runWorker installs its own SIGTERM/SIGINT handlers and resolves when a
 *    graceful shutdown finishes; the process then exits 0.
 * 4. Runs `tickScheduler()` on an interval in the SAME process so cron-like
 *    schedules are turned into jobs without a second deployment. Ticks are
 *    serialized across instances by a Postgres advisory lock, and a tick that
 *    throws is logged and swallowed — it can never kill the worker.
 *
 * ── CAPACITY (Phase 12, F-12-03 — a documented assumption, not a bug) ─────
 * Execution is strictly sequential: one job at a time per worker process.
 * Capacity per process ≈ 3600 ÷ mean job seconds (jobs/hour); scale is
 * horizontal — add worker processes. A single long job (e.g. a 30 s webhook
 * timeout chain) head-of-line blocks other job types on its process for
 * its duration. A parallel-claim redesign is deliberately NOT implemented:
 * it requires measured queue-depth evidence (Phase 12 §4.4 harness or
 * production telemetry) before the shutdown/claim-lease reasoning is
 * complicated.
 *
 * ── IDLE POLLING (Phase 12, F-12-04) ─────────────────────────────────────
 * When a claim finds no work, the worker's idle sleep backs off
 * geometrically from 1 s to a 10 s ceiling (pollIntervalMs →
 * pollMaxIdleMs), resetting to 1 s on any claimed job. An idle worker
 * therefore polls at most once per 10 s instead of once per second, so a
 * running worker no longer holds the database awake by existence alone.
 * Tradeoff: a job arriving during deep idle can wait up to the 10 s
 * ceiling before it is claimed — acceptable for every current job type
 * (none is user-blocking; user-facing work is synchronous). Scheduler
 * tick unchanged (60 s default).
 *
 * The process stays alive until SIGTERM/SIGINT. A supervisor (systemd,
 * Docker, Render, etc.) should restart it on non-zero exit.
 */

import { hostname } from 'node:os';

const DEFAULT_TICK_MS = 60_000;
const MAX_WORKER_ID_LENGTH = 128;

function printHelp(): void {
  console.log(`Pravshi OS job worker.

Usage:
  pnpm worker            Start the worker (claims jobs, runs scheduler ticks).
  pnpm worker --help     Show this help.

Required env (validated before start): DATABASE_URL, APP_URL, NODE_ENV,
BETTER_AUTH_SECRET, HEALTH_CHECK_TOKEN.
Optional env: SCHEDULER_TICK_MS (default 60000), HOSTNAME.

The worker claims jobs from the queue, fires due schedules on a tick
interval, and shuts down gracefully on SIGTERM/SIGINT.`);
}

/** Parse SCHEDULER_TICK_MS; invalid/blank values fall back to the default. */
function parseTickMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TICK_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `[worker] invalid SCHEDULER_TICK_MS=${JSON.stringify(raw)}; using default ${DEFAULT_TICK_MS}ms`,
    );
    return DEFAULT_TICK_MS;
  }
  return Math.floor(n);
}

/** Unique per process, e.g. `worker-myhost-1234`. Capped at 128 chars. */
function buildWorkerId(): string {
  // HOSTNAME is platform-provided process identity (set by Docker/K8s), not
  // application configuration; there is nothing to validate through src/env.ts
  // and no secret involved.
  // eslint-disable-next-line no-restricted-syntax
  const host = process.env.HOSTNAME?.trim() || hostname();
  const id = `worker-${host}-${process.pid}`;
  return id.length > MAX_WORKER_ID_LENGTH ? id.slice(0, MAX_WORKER_ID_LENGTH) : id;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  // Dynamic imports so `--help` above can exit before env validation runs.
  // Importing these modules validates env (`@/env` throws on missing/invalid
  // vars) and registers every job handler as a side effect.
  const { env } = await import('@/env');
  await import('./handlers'); // notification, webhook, email, cleanup
  await import('./workflow-jobs'); // workflow_run, scheduled_trigger
  const { runWorker, reapStaleJobs } = await import('./worker');
  const { tickScheduler } = await import('./scheduler');

  // The shared Neon pool emits 'error' for failures on idle clients (e.g. a
  // scale-to-zero suspend dropping sockets — normal, not exceptional). With no
  // listener Node throws "Unhandled error." and the process dies. Log and
  // continue: the pool discards the broken client, and per-query errors still
  // surface through the normal await paths. This must attach before any query.
  //
  // Additionally, the driver can emit 'error' on a Client the pool no longer
  // tracks (a socket dying right after a failed query, before release). That
  // client-level emission has no pool re-emit, so a no-op listener is attached
  // to every checked-out client to suppress the "Unhandled error." throw. The
  // pool's own 'error' re-emit for tracked clients is unaffected, so nothing
  // is silently lost.
  const { pool } = await import('../db/pool');
  const poolConnect = pool.connect.bind(pool);
  pool.connect = (async () => {
    const client = await poolConnect();
    client.on('error', () => undefined);
    return client;
  }) as typeof pool.connect;
  pool.on('error', (err: unknown) => {
    console.error('[worker] pool error (worker continues):', err);
  });

  const workerId = buildWorkerId();
  // SCHEDULER_TICK_MS is a non-secret numeric tuning knob with a validated safe
  // default, read only by this process-bootstrap entrypoint; it is not
  // application configuration.
  // eslint-disable-next-line no-restricted-syntax
  const tickMs = parseTickMs(process.env.SCHEDULER_TICK_MS);

  console.log(
    `[worker] starting workerId=${workerId} schedulerTickMs=${tickMs} nodeEnv=${env.NODE_ENV}`,
  );

  // Never let a stray rejection take the process down silently.
  process.on('unhandledRejection', (reason) => {
    console.error('[worker] unhandled rejection (worker continues):', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[worker] uncaught exception; exiting for supervisor restart:', err);
    process.exit(1);
  });

  // Stop firing new ticks once shutdown begins; runWorker drains in flight.
  let shuttingDown = false;
  const markShuttingDown = () => {
    shuttingDown = true;
  };
  process.once('SIGTERM', markShuttingDown);
  process.once('SIGINT', markShuttingDown);

  // Overlap guard: a slow tick never stacks behind the next interval.
  let tickInFlight = false;
  const runTick = async (reason: string): Promise<void> => {
    if (shuttingDown || tickInFlight) return;
    tickInFlight = true;
    try {
      const fired = await tickScheduler();
      if (fired > 0) console.log(`[worker] scheduler tick (${reason}): fired ${fired} job(s)`);
    } catch (err) {
      // A tick failure must never kill the worker.
      console.error('[worker] scheduler tick failed (worker continues):', err);
    } finally {
      tickInFlight = false;
    }
  };

  // Crash recovery before anything else claims work (Phase 12, F-12-02):
  // reset claims orphaned by a dead predecessor to 'pending'. Logged with
  // the reaped count; a failure here must never kill the worker — the
  // in-loop reap (reapIntervalMs) retries on cadence.
  try {
    const reaped = await reapStaleJobs();
    console.log(`[worker] startup reap: reaped ${reaped} stale job(s)`);
  } catch (err) {
    console.error('[worker] startup reap failed (worker continues):', err);
  }

  // Fire once at startup so a fresh deploy does not wait a full interval,
  // then keep ticking. The first tick runs before the claim loop blocks.
  await runTick('startup');
  const timer = setInterval(() => void runTick('interval'), tickMs);

  try {
    // runWorker installs its own SIGTERM/SIGINT handlers, stops claiming,
    // drains the in-flight job, and resolves. Resolving means we may exit.
    await runWorker({ workerId });
  } finally {
    clearInterval(timer);
  }

  console.log('[worker] graceful shutdown complete');
  process.exit(0);
}

main().catch((err) => {
  console.error('[worker] fatal startup error:', err);
  process.exit(1);
});
