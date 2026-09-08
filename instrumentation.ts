import * as Sentry from '@sentry/nextjs';

/**
 * Next.js calls this once per server runtime at startup. The runtime-specific config
 * is imported dynamically so the edge bundle never pulls in the Node build, and vice
 * versa.
 *
 * Nothing here touches the database. Instrumentation runs before a request exists and
 * therefore before any authorization context exists; a query here would have no
 * identity and would be exactly the fail-closed case the data layer is designed around.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

/** Next.js hands server-side request errors here; Sentry formats and forwards them. */
export const onRequestError = Sentry.captureRequestError;
