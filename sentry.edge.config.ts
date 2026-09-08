import * as Sentry from '@sentry/nextjs';
import { env } from '@/env';

// Edge runtime — middleware and edge route handlers. Identical policy to the server
// config: DSN through src/env.ts, no PII, and the same scrubbing before send.
Sentry.init({
  dsn: env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  // PRAVSHI OS holds employee personal data. Never let it ride along on an error.
  sendDefaultPii: false,
  beforeSend(event) {
    delete event.request?.cookies;
    if (event.request?.headers) {
      delete event.request.headers.authorization;
      delete event.request.headers.cookie;
    }
    return event;
  },
});
