import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * WP-W — every code path that commits new or rescheduled worker work wakes a worker that is
 * sleeping in low-cost mode, and does so AFTER its transaction: a wake sent before the commit
 * could reach a worker that looks, finds nothing, and sleeps until its next scheduled wake.
 *
 * Static: each writer's function body must call requestWorkerWake() after the
 * withAuthorizedDb(...) block that writes. Add a writer here when one is added to the code.
 */

const read = (p: string) => readFileSync(join(process.cwd(), ...p.split('/')), 'utf8');

/** The source of one exported function, from its signature to the next top-level `}`. */
function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end);
}

const WRITERS: Array<{ file: string; fn: string; what: string }> = [
  {
    file: 'src/lib/jobs/queue.ts',
    fn: 'export async function enqueueJob(',
    what: 'every enqueued job',
  },
  { file: 'src/lib/jobs/queue.ts', fn: 'export async function retryJob(', what: 'a manual retry' },
  {
    file: 'src/lib/work/reminders.ts',
    fn: 'export async function createReminder(',
    what: 'a new reminder',
  },
  {
    file: 'src/app/api/jobs/store.ts',
    fn: 'export async function createSchedule(',
    what: 'a new schedule',
  },
  {
    file: 'src/app/api/jobs/store.ts',
    fn: 'export async function updateSchedule(',
    what: 'a rescheduled schedule',
  },
];

describe('worker work writers wake the worker after committing', () => {
  it.each(WRITERS)('$fn ($what)', ({ file, fn }) => {
    const src = body(read(file), fn);
    const write = src.indexOf('withAuthorizedDb(');
    const wake = src.lastIndexOf('await requestWorkerWake()');
    expect(write, 'the writer commits through withAuthorizedDb').toBeGreaterThanOrEqual(0);
    expect(wake, 'the writer wakes the worker').toBeGreaterThan(write);
    // The wake sits after the transaction callback has closed, never inside it: find the
    // `});` at the indentation of the line that opened withAuthorizedDb(.
    const lineStart = src.lastIndexOf('\n', write) + 1;
    const indent = /^\s*/.exec(src.slice(lineStart))![0];
    const txClose = src.indexOf(`\n${indent}});`, write);
    expect(txClose).toBeGreaterThan(write);
    expect(wake).toBeGreaterThan(txClose);
  });

  it('the forgot-password route wakes after the reset step, outside any branch', () => {
    const route = read('src/app/api/auth/forgot-password/route.ts');
    const reset = route.indexOf('await requestPasswordReset(');
    const wake = route.indexOf(
      '  await requestWorkerWake();\n  return reply(200, { ok: true });\n}',
    );
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(wake).toBeGreaterThan(reset);
  });
});
