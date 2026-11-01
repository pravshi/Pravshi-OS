/**
 * Worker-process flag (REL-05, REL-11).
 *
 * Kept in its own minimal module with zero dependencies so that code shared between web and
 * worker planes (such as src/lib/observability/report.ts) can check whether it is running
 * inside the worker without transitively importing @/env or the wake client.
 */

let insideWorker = false;

/**
 * runner.ts calls this at worker start-up: inside the worker, work enqueued by a handler is
 * picked up by the running loop, so no wake is sent over the network.
 */
export function markWorkerProcess(value = true): void {
  insideWorker = value;
}

/** Whether runner.ts marked this process as the worker (observability/report.ts reads it). */
export function isWorkerProcess(): boolean {
  return insideWorker;
}
