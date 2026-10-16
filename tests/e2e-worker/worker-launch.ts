/**
 * Start-up diagnostics for the worker E2E (low-cost-worker.e2e.test.ts).
 *
 * One record per launched worker process: when it was launched, when it first wrote anything,
 * when it wrote its first worker log line, when each start-up milestone and awaited line
 * appeared, and how it ended.
 * When a wait fails, the error says which of two different things happened:
 *
 *   - the process EXITED before the line appeared (with its exit code or signal), or
 *   - it was still RUNNING when the time ran out (with how far it had got),
 *
 * followed by the tail of what it wrote. Connection strings are redacted from every message, so
 * a worker that prints one cannot leak it into a test report.
 */

export interface WorkerExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly atMs: number;
}

export interface WorkerLaunch {
  readonly launchedAt: number;
  firstOutputMs: number | null;
  firstWorkerLogMs: number | null;
  readonly seen: Record<string, number>;
  exit: WorkerExit | null;
}

/** A line the worker itself wrote, as opposed to Node's own start-up warnings. */
const WORKER_LOG = /^\[(worker|jobs)\]/m;
const CONNECTION_STRING = /\b(postgres(?:ql)?):\/\/[^\s'"`]+/gi;
const TAIL_CHARS = 4_000;

export function newLaunch(now = Date.now()): WorkerLaunch {
  return { launchedAt: now, firstOutputMs: null, firstWorkerLogMs: null, seen: {}, exit: null };
}

/** Start-up milestones recorded for every launch, whether or not a test waits for them. */
export const MILESTONES = ['[worker] starting', '[jobs] db maintenance', '[worker] deep sleep'];

/**
 * Records a chunk of output. `output` is everything this launch has written so far (so a
 * milestone split across two chunks is still found); it defaults to the chunk itself.
 */
export function recordOutput(
  launch: WorkerLaunch,
  chunk: string,
  now = Date.now(),
  output = chunk,
): void {
  const at = now - launch.launchedAt;
  if (launch.firstOutputMs === null) launch.firstOutputMs = at;
  if (launch.firstWorkerLogMs === null && WORKER_LOG.test(chunk)) launch.firstWorkerLogMs = at;
  for (const milestone of MILESTONES) markSeen(launch, milestone, output, now);
}

export function recordExit(
  launch: WorkerLaunch,
  code: number | null,
  signal: string | null,
  now = Date.now(),
): void {
  launch.exit = { code, signal, atMs: now - launch.launchedAt };
}

/** Remembers when `needle` was first seen in the output; true once it has been. */
export function markSeen(launch: WorkerLaunch, needle: string, logs: string, now = Date.now()) {
  if (launch.seen[needle] === undefined && logs.includes(needle)) {
    launch.seen[needle] = now - launch.launchedAt;
  }
  return launch.seen[needle] !== undefined;
}

export function redact(text: string): string {
  return text.replace(CONNECTION_STRING, '$1://[redacted]');
}

const ms = (value: number | null) => (value === null ? 'never' : `${value} ms`);

export function describeLaunch(launch: WorkerLaunch, now = Date.now()): string {
  const state = launch.exit
    ? `exited at ${launch.exit.atMs} ms (code ${launch.exit.code ?? 'none'}, signal ${launch.exit.signal ?? 'none'})`
    : `still running at ${now - launch.launchedAt} ms`;
  return (
    `worker ${state}; first output: ${ms(launch.firstOutputMs)}; ` +
    `first worker log: ${ms(launch.firstWorkerLogMs)}`
  );
}

/**
 * The error for a wait that did not succeed. `exited` when the process ended before the awaited
 * line; `timeout` when it was still running at the deadline.
 */
export function waitFailure(
  what: string,
  launch: WorkerLaunch,
  timeoutMs: number,
  logs: string,
  now = Date.now(),
): Error {
  const kind = launch.exit ? 'exited' : 'timeout';
  const head =
    kind === 'exited'
      ? `worker exited before ${what}`
      : `timed out after ${timeoutMs} ms waiting for ${what}`;
  const tail = redact(logs.slice(-TAIL_CHARS));
  const error = new Error(
    `${head} — ${describeLaunch(launch, now)}\n--- worker output (tail) ---\n${tail}`,
  );
  error.name = kind === 'exited' ? 'WorkerExitedError' : 'WorkerWaitTimeoutError';
  return error;
}

/** A JSON-safe summary of every launch, relative times only. */
export function launchReport(launches: readonly WorkerLaunch[]) {
  return launches.map((l, i) => ({
    launch: i + 1,
    firstOutputMs: l.firstOutputMs,
    firstWorkerLogMs: l.firstWorkerLogMs,
    seenMs: { ...l.seen },
    exit: l.exit,
  }));
}
