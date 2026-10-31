/**
 * Next.js calls register() once per server instance, before any request. With a `src/` folder
 * Next loads THIS file and ignores a root-level instrumentation.ts (verified on Next 15.5: the
 * build emits no .next/server/instrumentation.js for the root file).
 *
 * Its only job today is to connect the domain-event ports (src/lib/events) to the real
 * subscribers via the composition root — see ADR-010 and ADR-005's Step 6 amendment. Without it
 * a web process would emit workflow and webhook events into nothing.
 *
 * Nothing here touches the database: instrumentation runs before a request exists, so there is
 * no authorization context. The edge runtime emits nothing, so it loads nothing.
 *
 * This file deliberately does not load the Sentry configs the root instrumentation.ts names:
 * turning Sentry's server init on is a separate decision, not part of Step 6.
 */
export async function register() {
  // NEXT_RUNTIME is set by Next itself (not application configuration, so it is not in src/env.ts);
  // the check keeps the Node-only import out of the edge bundle.
  // eslint-disable-next-line no-restricted-syntax
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('@/lib/composition/domain-events');
  }
}
