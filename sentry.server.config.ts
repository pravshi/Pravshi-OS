import * as Sentry from '@sentry/nextjs';
import { env } from '@/env';

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
  beforeSend(event) {
    delete event.request?.cookies;
    if (event.request?.headers) {
      delete event.request.headers.authorization;
      delete event.request.headers.cookie;
    }
    return event;
  },
});
