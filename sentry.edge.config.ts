import * as Sentry from '@sentry/nextjs';
import { env } from '@/env';
import { scrubBreadcrumb, scrubEvent } from '@/lib/observability/redact';

// Edge runtime — middleware and edge route handlers. Identical policy to the server
// config: DSN through src/env.ts, no PII, and the same scrubbing before send.
Sentry.init({
  dsn: env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  // PRAVSHI OS holds employee personal data. Never let it ride along on an error.
  sendDefaultPii: false,
  // Same redaction as sentry.server.config.ts (src/lib/observability/redact.ts).
  beforeSend: (event) => scrubEvent(event),
  beforeSendTransaction: (event) => scrubEvent(event),
  beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
});
