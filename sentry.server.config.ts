import * as Sentry from '@sentry/nextjs';
import { env } from '@/env';
import { scrubBreadcrumb, scrubEvent } from '@/lib/observability/redact';

// Server runtime. The DSN is read through src/env.ts, honouring the global contract
// that application configuration never comes from process.env directly.
//
// With SENTRY_DSN unset, `dsn` is undefined and the SDK initialises in a disabled
// state: it captures nothing and sends nothing. Sentry being unconfigured must never
// be a reason the application fails to start.
Sentry.init({
  dsn: env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  // PRAVSHI OS holds employee personal data. Never let it ride along on an error.
  sendDefaultPii: false,
  // Credentials never leave in an event: no cookies, credential headers or request body, and
  // every message, exception value, URL, breadcrumb (console lines included), span and structured
  // field redacted (src/lib/observability/redact.ts). A failed query's message carries its bound
  // parameters — for the session lookup, the session's bearer token.
  beforeSend: (event) => scrubEvent(event),
  beforeSendTransaction: (event) => scrubEvent(event),
  beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
});
