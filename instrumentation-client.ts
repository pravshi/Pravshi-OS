import * as Sentry from '@sentry/nextjs';
import { scrubBreadcrumb, scrubEvent } from '@/lib/observability/redact';

/**
 * THE ONE INTENTIONAL EXCEPTION to the "no process.env outside src/env.ts" rule.
 *
 * Next.js replaces the literal text `process.env.NEXT_PUBLIC_SENTRY_DSN` at build
 * time. Reading it through src/env.ts would defeat that substitution and leave the
 * browser SDK uninitialised — failing silently, which is the worst kind.
 *
 * Scope of the exception: this file only, this variable only, and only because it
 * is a NEXT_PUBLIC_ value that is already shipped to the browser. No secret may
 * ever be read this way. See ENVIRONMENT.md.
 *
 * The plan names this file `sentry.client.config.ts`. @sentry/nextjs v10 emits a
 * deprecation warning for that name and directs you to `instrumentation-client.ts`,
 * which Next 15 loads natively. The contract above is unchanged; only the filename
 * follows the SDK's current convention.
 */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  // One-time credentials travel in this app's URLs — /reset-password?token=…, /invite#token=…,
  // /setup#token=… — and the browser SDK records the page URL on every event and navigation
  // breadcrumb. The server's redaction applies here too (src/lib/observability/redact.ts).
  beforeSend: (event) => scrubEvent(event),
  beforeSendTransaction: (event) => scrubEvent(event),
  beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
});

/** Reports client-side navigation timing to Sentry. Inert without a DSN. */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
