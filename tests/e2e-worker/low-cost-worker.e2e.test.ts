/**
 * WP-W — end-to-end: the REAL worker process (`src/lib/jobs/runner.ts`, default low-cost
 * mode) against a real Postgres, measured from outside.
 *
 * OPT-IN: runs only with WPW_E2E=1 (plus the usual database env). It spawns the worker
 * process, binds a local port and waits on real timers (~2 minutes), and the worker it starts
 * claims ANY due job in the database — so it must never share a database with the parallel
 * suite. Run it alone against a throwaway database:
 *
 *   WPW_E2E=1 pnpm exec vitest run tests/e2e-worker/low-cost-worker.e2e.test.ts
 *
 * WPW_NODE=<path to node 22> when the shell's node is not 22 (the worker needs Node 22).
 *
 * What it proves:
 *   1. while asleep the worker holds NO database connection (Neon can suspend);
 *   2. a wake signal gets a committed job claimed and finished within seconds;
 *   3. a reminder created for the future is delivered on time (wake → re-read next due);
 *   4. a job whose wake signal was lost is still picked up by the safety-cap wake;
 *   5. a scheduled automation fires at its due time while the worker was asleep;
 *   6. after a restart, work that fell due while the worker was down is drained at once,
 *      and the start-up maintenance pass runs.
 *
 * Start-up diagnostics (worker-launch.ts): every launch records when it first wrote anything,
 * when it wrote its first worker log line, when each start-up milestone and awaited line
 * appeared, and its exit code or signal. A failed wait says whether the worker EXITED first or
 * was still RUNNING at the deadline, with that record and the (redacted) tail of its output.
 * WPW_E2E_REPORT=<file> also writes the launches and every test's outcome as JSON — a test
 * that never ran is "not run".
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

import { mkOrg, mkPerson, mkTask, mkWorkflow, RUN } from '../workflows/helpers';
import {
  launchReport,
  markSeen,
  newLaunch,
  recordExit,
  recordOutput,
  waitFailure,
  type WorkerLaunch,
} from './worker-launch';

const ENABLED = process.env.WPW_E2E === '1' && !!process.env.DATABASE_URL_MIGRATE;
const TOKEN = `wpw-e2e-${RUN}-token-0123456789abcdefghij`;
const PORT = 18_000 + Math.floor(Math.random() * 1_000);
const ACTIVE_WINDOW_MS = 3_000;
const MAX_SLEEP_MS = 40_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!ENABLED)('low-cost worker, end to end (real process, real database)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  let worker: ChildProcess | null = null;
  let logs = '';
  let launch: WorkerLaunch | null = null; // the current worker process
  const launches: WorkerLaunch[] = [];
  let setupCompleted = false; // beforeAll reached the end: the tests could run
  let orgId = '';
  let personId = '';
  let taskId = '';
  let workflowId = '';

  /**
   * The worker host's environment: the test environment without DATABASE_URL_AUTH, the web app's
   * authentication login (0072/0073), which a worker host never holds — runner.ts refuses to start
   * when it is present (see the last case below).
   */
  function workerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WORKER_ACTIVE_WINDOW_MS: String(ACTIVE_WINDOW_MS),
      WORKER_MAX_SLEEP_MS: String(MAX_SLEEP_MS),
      WORKER_WAKE_TOKEN: TOKEN,
      PORT: String(PORT),
      SCHEDULER_TICK_MS: '60000',
    };
    delete env.DATABASE_URL_AUTH;
    return { ...env, ...extra };
  }

  const WORKER_ARGS = [
    '--experimental-transform-types',
    '--import',
    './scripts/ci/neon-local.mjs',
    '--import',
    './scripts/worker-loader.mjs',
    'src/lib/jobs/runner.ts',
  ];

  function startWorker(): void {
    logs = '';
    const current = newLaunch();
    launch = current;
    launches.push(current);
    worker = spawn(
      // The worker needs Node 22 (--experimental-transform-types; .nvmrc pins 22). WPW_NODE
      // points at a Node 22 binary when the test runner itself runs on another version.
      process.env.WPW_NODE ?? process.execPath,
      WORKER_ARGS,
      { env: workerEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const capture = (d: Buffer) => {
      const text = d.toString();
      logs += text;
      recordOutput(current, text, Date.now(), logs);
    };
    worker.stdout!.on('data', capture);
    worker.stderr!.on('data', capture);
    worker.once('exit', (code, signal) => recordExit(current, code, signal));
  }

  async function stopWorker(): Promise<void> {
    if (!worker) return;
    const w = worker;
    worker = null;
    // Already gone (it crashed, or was refused): 'exit' will not fire again.
    if (w.exitCode !== null || w.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      w.once('exit', () => resolve());
      w.kill('SIGTERM');
    });
  }

  async function waitFor<T>(what: string, probe: () => Promise<T | null>, timeoutMs: number) {
    const started = Date.now();
    for (;;) {
      const value = await probe();
      if (value !== null) return { value, afterMs: Date.now() - started };
      if (Date.now() - started > timeoutMs) {
        if (launch) throw waitFailure(what, launch, timeoutMs, logs);
        throw new Error(`timed out waiting for ${what}`);
      }
      await sleep(250);
    }
  }

  /** Waits for a line from the CURRENT worker; fails at once, as an exit, if it has exited. */
  const waitForLog = (needle: string, timeoutMs = 20_000) =>
    waitFor(
      `log "${needle}"`,
      async () => {
        if (!launch) throw new Error('no worker has been started');
        if (markSeen(launch, needle, logs)) return true;
        if (launch.exit) throw waitFailure(`log "${needle}"`, launch, timeoutMs, logs);
        return null;
      },
      timeoutMs,
    );

  const ring = () =>
    fetch(`http://127.0.0.1:${PORT}/wake`, {
      method: 'POST',
      headers: { 'x-pravshi-worker-token': TOKEN },
    }).then((r) => r.status);

  /**
   * Connections the worker holds right now — on BOTH of its logins: app_worker for the worker
   * plane (0070) and app_user for work run as a real person. A sleeping worker must hold none.
   */
  const workerConnections = async () =>
    Number(
      (
        await owner.query<{ n: string }>(
          `select count(*)::text n from pg_stat_activity
            where usename in ('app_user', 'app_worker')`,
        )
      ).rows[0]!.n,
    );

  const insertJob = async (): Promise<string> =>
    (
      await owner.query<{ id: string }>(
        `insert into public.jobs (org_id, type, status, payload, next_run_at)
         values ($1, 'cleanup', 'pending', '{"target":"stale_jobs","dryRun":true}'::jsonb, now())
         returning id`,
        [orgId],
      )
    ).rows[0]!.id;

  const jobStatus = async (id: string) =>
    (await owner.query<{ status: string }>(`select status from public.jobs where id = $1`, [id]))
      .rows[0]!.status;

  const insertReminder = async (inMs: number): Promise<string> =>
    (
      await owner.query<{ id: string }>(
        `insert into public.task_reminders (org_id, task_id, person_id, remind_at)
         values ($1, $2, $3, now() + ($4 || ' milliseconds')::interval) returning id`,
        [orgId, taskId, personId, String(inMs)],
      )
    ).rows[0]!.id;

  const reminderSent = async (id: string) =>
    (
      await owner.query<{ is_sent: boolean }>(
        `select is_sent from public.task_reminders where id = $1`,
        [id],
      )
    ).rows[0]!.is_sent;

  beforeAll(async () => {
    if (!ENABLED) return;
    orgId = await mkOrg(owner, `wpw-${RUN}`);
    personId = await mkPerson(owner, orgId, `Wpw ${RUN}`);
    taskId = await mkTask(owner, orgId, null, `wpw task ${RUN}`);
    workflowId = (await mkWorkflow(owner, orgId, { createdBy: personId })).id;
    startWorker();
    await waitForLog('[jobs] db maintenance'); // start-up pass ran
    await waitForLog('[worker] deep sleep');
    setupCompleted = true;
  }, 60_000);

  // Vitest passes the suite second and requires the first argument to be destructured.
  // eslint-disable-next-line no-empty-pattern
  afterAll(async ({}, suite) => {
    if (!ENABLED) return;
    await stopWorker();
    await owner.end();
    const report = process.env.WPW_E2E_REPORT;
    if (report) {
      // When start-up fails Vitest marks every test 'skip'; say what happened instead.
      const tests = suite.tasks.map((t) => ({
        name: t.name,
        state: setupCompleted ? (t.result?.state ?? 'not run') : 'not run: start-up failed',
      }));
      const verdict = tests.every((t) => t.state === 'pass')
        ? 'passed'
        : setupCompleted
          ? 'failed'
          : 'not run: start-up failed';
      const body = { verdict, setupCompleted, tests, launches: launchReport(launches) };
      writeFileSync(report, JSON.stringify(body, null, 2));
    }
  });

  it('1. holds no database connection while asleep', async () => {
    // The pool releases idle clients after 10 s.
    await sleep(12_000);
    expect(await workerConnections()).toBe(0);
    // REL-11, through the real runner: the sleeping worker reports itself healthy on
    // /healthz, and answering opens no database connection.
    const health = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');
    expect(await workerConnections()).toBe(0);
    expect(logs).toContain('[worker] liveness budgets');
  }, 30_000);

  it('2. a wake gets a committed job claimed and finished within seconds', async () => {
    const id = await insertJob();
    expect(await ring()).toBe(202);
    const { afterMs } = await waitFor(
      'job succeeded',
      async () => ((await jobStatus(id)) === 'succeeded' ? true : null),
      10_000,
    );
    console.log(`[wpw-e2e] wake → job succeeded in ${afterMs} ms`);
    expect(afterMs).toBeLessThan(5_000);
  }, 30_000);

  it('3. a reminder created for the future is delivered on time', async () => {
    await waitForLog('[worker] deep sleep');
    const dueInMs = 15_000;
    const created = Date.now();
    const id = await insertReminder(dueInMs);
    await ring(); // what createReminder() does after committing
    const { afterMs } = await waitFor(
      'reminder sent',
      async () => ((await reminderSent(id)) ? true : null),
      dueInMs + 20_000,
    );
    const lateMs = Date.now() - (created + dueInMs);
    console.log(
      `[wpw-e2e] reminder delivered ${lateMs} ms after its due time (waited ${afterMs} ms)`,
    );
    expect(Date.now()).toBeGreaterThanOrEqual(created + dueInMs - 500);
    expect(lateMs).toBeLessThan(5_000);
  }, 60_000);

  it('4. a job whose wake signal was lost is picked up by the safety-cap wake', async () => {
    // Let the worker settle into a sleep with nothing due (the cap applies).
    await sleep(ACTIVE_WINDOW_MS + 2_000);
    const id = await insertJob(); // no ring
    await sleep(3_000);
    expect(await jobStatus(id)).toBe('pending'); // not polled: still waiting
    const { afterMs } = await waitFor(
      'job picked up without a wake',
      async () => ((await jobStatus(id)) === 'succeeded' ? true : null),
      MAX_SLEEP_MS + 15_000,
    );
    console.log(
      `[wpw-e2e] lost wake: job picked up ${afterMs + 3_000} ms after insert (cap ${MAX_SLEEP_MS} ms)`,
    );
  }, 90_000);

  it('5. a scheduled automation fires at its due time while the worker slept', async () => {
    const dueInMs = 10_000;
    const scheduleId = (
      await owner.query<{ id: string }>(
        `insert into public.schedules (org_id, workflow_id, name, cron, timezone, is_active, next_run_at, created_by)
         values ($1, $2, $3, '0 9 * * *', 'UTC', true, now() + ($4 || ' milliseconds')::interval, $5)
         returning id`,
        [orgId, workflowId, `wpw-${RUN}`, String(dueInMs), personId],
      )
    ).rows[0]!.id;
    await ring(); // what the schedule writer does after committing
    const { afterMs } = await waitFor(
      'scheduled_trigger job enqueued',
      async () => {
        const { rows } = await owner.query(
          `select 1 from public.jobs where type = 'scheduled_trigger' and dedup_key like $1`,
          [`sched:${scheduleId}:%`],
        );
        return rows.length > 0 ? true : null;
      },
      dueInMs + 20_000,
    );
    console.log(`[wpw-e2e] schedule fired ${afterMs - dueInMs} ms after its due time`);
    expect(afterMs).toBeGreaterThanOrEqual(dueInMs - 1_000);
    expect(afterMs - dueInMs).toBeLessThan(5_000);
  }, 60_000);

  it('6. after a restart, work that fell due while it was down is drained at once', async () => {
    await stopWorker();
    const id = await insertJob(); // due now, worker down, no ring
    const reminderId = await insertReminder(-60_000); // overdue
    startWorker();
    const { afterMs } = await waitFor(
      'overdue job drained after restart',
      async () =>
        (await jobStatus(id)) === 'succeeded' && (await reminderSent(reminderId)) ? true : null,
      30_000,
    );
    console.log(`[wpw-e2e] restart: overdue job + reminder drained ${afterMs} ms after start`);
    expect(afterMs).toBeLessThan(15_000);
    expect(logs).toContain('[jobs] db maintenance');
  }, 60_000);

  it('7. refuses to start on a host that holds the web app’s authentication login (0072/0073)', async () => {
    await stopWorker();
    const authUrl =
      process.env.DATABASE_URL_AUTH ?? 'postgresql://u:p@ep-x-auth-pooler.example.test/db';
    const refused = spawn(process.env.WPW_NODE ?? process.execPath, WORKER_ARGS, {
      env: workerEnv({ DATABASE_URL_AUTH: authUrl, PORT: String(PORT + 1) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    refused.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    refused.stderr!.on('data', (d: Buffer) => (out += d.toString()));
    // A worker that does NOT refuse would run until stopped: stop it after 30 s and fail, so a
    // regression never leaves a worker process behind.
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        refused.kill('SIGKILL');
        resolve(-1);
      }, 30_000);
      refused.once('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).toBe(1);
    expect(out).toContain('DATABASE_URL_AUTH is set on the worker host');
    // The message names the variable, never its value.
    expect(out).not.toContain(authUrl);
  }, 60_000);
});
