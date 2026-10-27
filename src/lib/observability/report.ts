/**
 * Error reporting without loading Sentry at import time (REL-05).
 *
 * `@sentry/nextjs` resolves, under Node, to its server build: about 815 CommonJS modules
 * (@sentry/core, @sentry/node, OpenTelemetry …). On a cold file cache, loading it took 19 s on
 * its own — and the worker loaded it at start-up only to call functions that do nothing there:
 * Sentry is initialised by the Next.js runtime (instrumentation.ts → sentry.*.config.ts), never
 * in the worker, so every capture in the worker was already a no-op.
 *
 * So code that both planes import reports through here:
 *   - in the worker process (runner.ts marks it before loading any handler): a no-op, exactly as
 *     before, and Sentry is never imported;
 *   - anywhere else (the web app): forwarded to Sentry, which instrumentation has already loaded
 *     and initialised, through one cached dynamic import. Calls are forwarded in the order they
 *     were made; the forwarding keeps the caller's async context, so the request's Sentry scope
 *     applies.
 * Reporting never throws into the caller: a failing import or capture is caught here, logged
 * once, and the application carries on exactly as it would have without Sentry.
 *
 * Giving the worker real error reporting is REL-09: it adds a worker-side Sentry.init and
 * changes the worker branch below, nothing else.
 */
import type * as SentryModule from '@sentry/nextjs';
import { isWorkerProcess } from '@/lib/jobs/process-context';

type Sentry = typeof SentryModule;

let loading: Promise<Sentry> | null = null;
let warned = false;

/** Test hook: forget the cached module so a different mock can be imported. */
export function resetReporterForTests(): void {
  loading = null;
  warned = false;
}

function forward(call: (sentry: Sentry) => void): void {
  if (isWorkerProcess()) return;
  loading ??= import('@sentry/nextjs');
  loading.then(call).catch((error: unknown) => {
    if (warned) return;
    warned = true;
    console.error('[observability] error reporting unavailable', error);
  });
}

export function captureMessage(...args: Parameters<Sentry['captureMessage']>): void {
  forward((sentry) => {
    sentry.captureMessage(...args);
  });
}

export function captureException(...args: Parameters<Sentry['captureException']>): void {
  forward((sentry) => {
    sentry.captureException(...args);
  });
}

export function addBreadcrumb(...args: Parameters<Sentry['addBreadcrumb']>): void {
  forward((sentry) => {
    sentry.addBreadcrumb(...args);
  });
}
