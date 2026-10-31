import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Redesign Step 5 — the worker's handler wiring after the queue/worker split.
 *
 * Handlers register themselves into the queue core's registry (src/lib/jobs/handler-registry.ts)
 * when their module is imported, and src/worker/runner.ts imports the three modules that hold
 * them. If the runner stopped importing one, its job types would silently have no handler. This
 * pins both halves: the runner's registering imports, and the set of job types they register.
 *
 * 'retry' is a member of JOB_TYPES with no handler on main either: retries are the retry
 * sweeper's job (src/worker/retry-sweeper.ts), not a handler's. It is pinned as unhandled so a
 * change to that fact is a reviewed one.
 */

const RUNNER = readFileSync('src/worker/runner.ts', 'utf8');

/** The modules that register handlers, exactly as the runner imports them at start-up. */
const REGISTERING_IMPORTS = [
  "await import('./handlers')", // notification, webhook, email, cleanup
  "await import('./workflow-jobs')", // workflow_run, scheduled_trigger
  "await import('@/lib/import/sales-sheet/job')", // crm_import
  "await import('@/lib/composition/domain-events')", // Step 6: wires the domain-event ports
] as const;

const HANDLED = [
  'notification',
  'webhook',
  'email',
  'cleanup',
  'workflow_run',
  'scheduled_trigger',
  'crm_import',
] as const;

describe('worker handler wiring (queue core registry + src/worker)', () => {
  it('the runner imports every module that registers a handler', () => {
    for (const imp of REGISTERING_IMPORTS) {
      expect(RUNNER, `runner.ts no longer contains ${imp}`).toContain(imp);
    }
  });

  it('importing those modules registers a handler for every handled job type, and none for retry', async () => {
    await import('@/worker/handlers');
    await import('@/worker/workflow-jobs');
    await import('@/lib/import/sales-sheet/job');
    const { getRegisteredHandler } = await import('@/lib/jobs/handler-registry');
    const { JOB_TYPES } = await import('@/lib/jobs/types');

    for (const type of HANDLED) {
      expect(getRegisteredHandler(type), `no handler registered for ${type}`).toBeTypeOf(
        'function',
      );
    }
    expect(getRegisteredHandler('retry')).toBeUndefined();
    // Every job type is accounted for here: a new type must be added to HANDLED or pinned.
    expect([...HANDLED, 'retry'].sort()).toEqual([...JOB_TYPES].sort());
  });

  it('the queue core never imports the worker (the registry is the only seam)', () => {
    // Every file in src/lib/jobs, not a hand-picked list: a new queue-core file is covered too.
    const files = readdirSync('src/lib/jobs').filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const file of files) {
      const source = readFileSync(`src/lib/jobs/${file}`, 'utf8');
      expect(source, `${file} imports the worker`).not.toMatch(
        /(from\s+|import\s*\(\s*)'(@\/worker|(\.\.\/)+worker|(\.\.\/)+src\/worker)/,
      );
    }
  });
});
