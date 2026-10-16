import { describe, expect, it } from 'vitest';
import {
  describeLaunch,
  launchReport,
  markSeen,
  newLaunch,
  recordExit,
  recordOutput,
  redact,
  waitFailure,
} from './worker-launch';

/**
 * The worker E2E's start-up diagnostics (worker-launch.ts). A failed wait must say whether the
 * worker exited or was still running, how far it had got, and never carry a connection string.
 * No database and no process: pure record keeping.
 */
describe('worker E2E start-up diagnostics', () => {
  const T0 = 1_000_000;
  const NODE_WARNING = '(node:1) ExperimentalWarning: Transform Types is an experimental feature\n';

  it("records first output and first worker log separately (Node's warnings are not the worker)", () => {
    const launch = newLaunch(T0);
    recordOutput(launch, NODE_WARNING, T0 + 700);
    expect(launch.firstOutputMs).toBe(700);
    expect(launch.firstWorkerLogMs).toBeNull();
    recordOutput(launch, '[worker] starting workerId=w-1\n', T0 + 8_000);
    recordOutput(launch, '[jobs] db maintenance {}\n', T0 + 8_300);
    expect(launch.firstOutputMs).toBe(700);
    expect(launch.firstWorkerLogMs).toBe(8_000);
  });

  it('marks the first time an awaited line is seen, once', () => {
    const launch = newLaunch(T0);
    expect(markSeen(launch, '[jobs] db maintenance', 'nothing yet', T0 + 1_000)).toBe(false);
    expect(markSeen(launch, '[jobs] db maintenance', '[jobs] db maintenance {}', T0 + 8_300)).toBe(
      true,
    );
    expect(markSeen(launch, '[jobs] db maintenance', '[jobs] db maintenance {}', T0 + 9_999)).toBe(
      true,
    );
    expect(launch.seen['[jobs] db maintenance']).toBe(8_300);
  });

  it('a wait that ran out while the worker was still running is a timeout, with its progress', () => {
    const launch = newLaunch(T0);
    recordOutput(launch, NODE_WARNING, T0 + 700);
    const error = waitFailure(
      'log "[jobs] db maintenance"',
      launch,
      20_000,
      NODE_WARNING,
      T0 + 21_700,
    );
    expect(error.name).toBe('WorkerWaitTimeoutError');
    expect(error.message).toContain(
      'timed out after 20000 ms waiting for log "[jobs] db maintenance"',
    );
    expect(error.message).toContain('still running at 21700 ms');
    expect(error.message).toContain('first output: 700 ms');
    expect(error.message).toContain('first worker log: never');
    expect(error.message).toContain('ExperimentalWarning');
  });

  it('a worker that exits before the line is reported as an exit, with its code or signal', () => {
    const launch = newLaunch(T0);
    recordOutput(launch, '[worker] fatal startup error: boom\n', T0 + 1_150);
    recordExit(launch, 1, null, T0 + 1_200);
    const error = waitFailure(
      'log "[jobs] db maintenance"',
      launch,
      20_000,
      '[worker] fatal',
      T0 + 1_300,
    );
    expect(error.name).toBe('WorkerExitedError');
    expect(error.message).toContain('worker exited before log "[jobs] db maintenance"');
    expect(error.message).toContain('exited at 1200 ms (code 1, signal none)');

    const killed = newLaunch(T0);
    recordExit(killed, null, 'SIGKILL', T0 + 5_000);
    expect(describeLaunch(killed)).toContain('(code none, signal SIGKILL)');
  });

  it('never carries a connection string', () => {
    const secret = ['postgresql://app_worker', 's3cr3t@ep-x-pooler.example.test/db'].join(':');
    const logs = `[worker] could not connect to ${secret} (ECONNREFUSED)\n`;
    expect(redact(logs)).not.toContain('s3cr3t');
    expect(redact(logs)).toContain('postgresql://[redacted]');
    const error = waitFailure('log "x"', newLaunch(T0), 20_000, logs, T0 + 20_001);
    expect(error.message).not.toContain('s3cr3t');
    expect(error.message).not.toContain('app_worker:');
  });

  it('reports relative timings and the exit for every launch', () => {
    const a = newLaunch(T0);
    recordOutput(a, '[worker] starting\n', T0 + 8_000);
    markSeen(a, '[jobs] db maintenance', '[jobs] db maintenance', T0 + 8_300);
    recordExit(a, null, 'SIGTERM', T0 + 90_000);
    const b = newLaunch(T0 + 100_000);
    expect(launchReport([a, b])).toEqual([
      {
        launch: 1,
        firstOutputMs: 8_000,
        firstWorkerLogMs: 8_000,
        seenMs: { '[jobs] db maintenance': 8_300 },
        exit: { code: null, signal: 'SIGTERM', atMs: 90_000 },
      },
      { launch: 2, firstOutputMs: null, firstWorkerLogMs: null, seenMs: {}, exit: null },
    ]);
  });
});
