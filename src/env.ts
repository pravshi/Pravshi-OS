import { z } from 'zod';

/**
 * RUNTIME — everything the deployed application is permitted to see.
 *
 * DATABASE_URL_MIGRATE (role app_owner) is deliberately absent. app_owner owns the
 * schema, and an owner connection is precisely what RLS does not constrain. It lives
 * in GitHub Actions and on developer machines. Never in Vercel.
 */
const runtimeSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .refine((u) => u.includes('-pooler.'), {
      message: 'DATABASE_URL must use the pooled Neon endpoint (host contains "-pooler")',
    }),
  /**
   * The background worker's own connection (role app_worker, migration 0070) — the only
   * credential that can claim jobs or run the other worker-plane functions. Worker host
   * only (Railway): never on Vercel, which parseRuntimeEnv refuses. Optional here because
   * the web app never needs it; the worker requires it at start (src/lib/jobs/runner.ts).
   */
  DATABASE_URL_WORKER: z
    .string()
    .url()
    .refine((u) => u.includes('-pooler.'), {
      message: 'DATABASE_URL_WORKER must use the pooled Neon endpoint (host contains "-pooler")',
    })
    .optional(),
  /**
   * The authentication plane's own connection (role app_auth, migrations 0072/0073): Better
   * Auth and the pre-login functions. The web app only — never the worker host (runner.ts
   * refuses it there). Required on Vercel (parseRuntimeEnv); anywhere else the auth module
   * refuses to load without it (src/lib/db/auth-pool.ts). There is no fallback to
   * DATABASE_URL: app_user holds no privilege in the auth schema.
   */
  DATABASE_URL_AUTH: z
    .string()
    .url()
    .refine((u) => u.includes('-pooler.'), {
      message: 'DATABASE_URL_AUTH must use the pooled Neon endpoint (host contains "-pooler")',
    })
    .optional(),
  APP_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'test', 'production']),
  HEALTH_CHECK_TOKEN: z.string().min(32).optional(),
  SENTRY_DSN: z.string().url().optional(),
  /**
   * Signs Better Auth's session cookies and tokens. Required, not optional: without it the
   * library would fall back to a generated value that differs between serverless instances,
   * so a session issued by one would be rejected by the next. 32 characters is the same
   * floor HEALTH_CHECK_TOKEN uses.
   */
  BETTER_AUTH_SECRET: z.string().min(32),
  /**
   * Invitation email delivery. Both optional: when either is unset, invitation emails
   * are not sent and the create-invitation endpoint returns the token to the admin
   * instead, so the link can be shared another way. EMAIL_FROM must be an address on
   * a domain verified in Resend — there is no safe default to invent.
   */
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().email().optional(),
  /**
   * Phase 6 job email handler (src/lib/jobs/handlers.ts). Both optional: when
   * either is unset the email job dead-letters with EMAIL_PROVIDER_UNCONFIGURED
   * (non-retryable) instead of sending.
   */
  EMAIL_PROVIDER: z.string().min(1).optional(),
  EMAIL_PROVIDER_API_KEY: z.string().min(1).optional(),
  /**
   * Phase 6 dispatcher transport (src/lib/workflows/events.ts). Optional:
   * when set to the exact string 'true', top-level workflow event dispatches
   * are enqueued as `workflow_run` jobs instead of running inline in the HTTP
   * request. Enable ONLY when a dedicated Phase 6 worker is running to claim
   * and execute those jobs — otherwise events sit in the queue unexecuted.
   * Default (unset, blank, or any other value): inline execution, zero new
   * infrastructure. Chained re-dispatches (depth > 0) always stay inline to
   * preserve the D4 depth guard, and any enqueue failure falls back to inline
   * (the event is never dropped, the caller never breaks).
   */
  WORKFLOWS_USE_QUEUE: z.string().optional(),
  /**
   * WP-W: the shortest gap allowed between two runs of one schedule, in minutes. Every
   * scheduled run wakes the database (on Neon Free, for at least five minutes), so a
   * 15-minute schedule alone would keep compute awake a third of the day. Default 60
   * when unset; '0' disables the check (paid plans). Checked when a schedule is created,
   * when its cron/timezone changes, and when a paused schedule is enabled again
   * (src/lib/jobs/schedule-policy.ts); existing active schedules are not altered.
   */
  SCHEDULE_MIN_INTERVAL_MINUTES: z
    .string()
    .regex(/^\d+$/, 'SCHEDULE_MIN_INTERVAL_MINUTES must be a whole number of minutes')
    .optional(),
  /**
   * Phase 9 AI Foundation (src/lib/ai). Every key is optional: with none of them
   * set the application runs on the deterministic mock provider, and boot is
   * unaffected. AI_API_KEY is a server-side secret only — never NEXT_PUBLIC_,
   * never logged; src/lib/ai reads these keys only through this parsed env.
   * AI_TIMEOUT_MS and AI_MAX_OUTPUT_TOKENS stay strings here (the WORKFLOWS_USE_QUEUE
   * precedent); src/lib/ai/config.ts parses and clamps them.
   */
  AI_PROVIDER: z.string().min(1).optional(),
  AI_MODEL: z.string().min(1).optional(),
  AI_API_KEY: z.string().min(1).optional(),
  AI_BASE_URL: z.string().url().optional(),
  AI_TIMEOUT_MS: z.string().optional(),
  AI_MAX_OUTPUT_TOKENS: z.string().optional(),
  /**
   * Phase 10 Integrations credential vault (src/lib/integrations/secrets.ts).
   * Optional: when unset, org-entered (Tier V) credentials are NOT_CONFIGURED —
   * a typed error and a dedicated UI state — while the app boots normally and
   * env-referenced (Tier E) integrations keep working. When present it must be
   * base64 encoding exactly 32 bytes (an AES-256 key). Server-side secret only:
   * never NEXT_PUBLIC_, never logged; read only through this parsed env.
   */
  INTEGRATIONS_ENCRYPTION_KEY: z
    .string()
    .refine((v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 32, {
      message: 'INTEGRATIONS_ENCRYPTION_KEY must be base64 encoding exactly 32 bytes',
    })
    .optional(),
  /**
   * WP-W low-cost worker mode. The worker sleeps without polling the database (so Neon
   * Free compute can suspend) and the web app wakes it after enqueuing work by POSTing to
   * WORKER_WAKE_URL (the worker's /wake endpoint) with WORKER_WAKE_TOKEN. Both optional:
   * unset, the web app sends no wake and the worker still finds every job at its next
   * scheduled wake (WORKER_MAX_SLEEP_MS) — slower, never lost. The token is a shared secret
   * set identically on the web app and the worker; server-side only, never logged.
   */
  WORKER_WAKE_URL: z.string().url().optional(),
  WORKER_WAKE_TOKEN: z.string().min(32).optional(),
});

/** TOOLING — migrations and integration tests only. Never imported from src/app. */
const toolingSchema = z.object({
  DATABASE_URL_MIGRATE: z
    .string()
    .url()
    .refine((u) => !u.includes('-pooler.'), {
      message: 'DATABASE_URL_MIGRATE must use the direct Neon endpoint (no "-pooler" in host)',
    }),
});

export type RuntimeEnv = z.infer<typeof runtimeSchema>;
export type ToolingEnv = z.infer<typeof toolingSchema>;

/**
 * A `.env` file expresses "unset" as a blank value (`SENTRY_DSN=`), and dotenv loads
 * that as `''`, not `undefined` — so an optional variable would fail its format check
 * merely for being left blank in `.env.example`. Drop blanks before validating.
 *
 * This does not loosen anything required: a blank DATABASE_URL still fails, now as
 * "missing" rather than "invalid URL". Only genuinely optional fields are affected.
 */
function withoutBlanks(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ''));
}

function fail(issues: z.ZodIssue[]): never {
  throw new Error(
    `Invalid environment:\n${issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
  );
}

/**
 * Credentials the serving runtime must never hold, and why. Each one belongs to a role that
 * can do something app_user deliberately cannot.
 */
const RUNTIME_FORBIDDEN_CREDENTIALS = {
  DATABASE_URL_MIGRATE: 'It uses app_owner, which owns the schema and is not constrained by RLS.',
  DATABASE_URL_BOOTSTRAP:
    'It uses app_admin, the role that can bootstrap the first SUPER_ADMIN, and belongs on the ' +
    'operator machine only.',
} as const;

export function parseRuntimeEnv(raw: Record<string, unknown>): RuntimeEnv {
  // A leaked owner or bootstrap credential is a silent, total loss of the access model.
  // Refuse to start.
  //
  // `next build` is not a boot. It evaluates every route module to collect page
  // data, and it runs on developer machines and in CI — developer machines hold
  // these credentials legitimately, because that is where migrations and the
  // bootstrap are run from. Exempting that one phase keeps the rule aimed at the
  // thing it protects: the serving runtime, which must never hold app_owner or
  // app_admin. A credential wrongly added to Vercel still fails the application
  // closed on its first request; it does not slip through.
  const isBuildPhase = raw.NEXT_PHASE === 'phase-production-build';
  if (!isBuildPhase && raw.NODE_ENV === 'production') {
    for (const [name, reason] of Object.entries(RUNTIME_FORBIDDEN_CREDENTIALS)) {
      if (raw[name]) {
        throw new Error(
          `${name} must never be present in the runtime environment. ${reason} ` +
            'Remove it from the Vercel environment.',
        );
      }
    }
  }
  // The worker credential belongs on the worker host only. Vercel sets VERCEL=1 in every
  // build and runtime it hosts; the worker host does not. Refused in builds too: the
  // variable has no business in any Vercel environment.
  if (raw.VERCEL && raw.DATABASE_URL_WORKER) {
    throw new Error(
      'DATABASE_URL_WORKER must never be present on Vercel. It uses app_worker, the role ' +
        'that can claim every organization’s jobs. Set it on the worker host only.',
    );
  }
  // The authentication credential is the web app's. On Vercel it is required — every
  // sign-in and session check runs on it — so a deployment without it is refused rather
  // than left to fail request by request. And it must name a different login than the
  // business connection: the same URL would put authentication back on app_user.
  const present = (v: unknown) => typeof v === 'string' && v.length > 0;
  if (raw.VERCEL && !present(raw.DATABASE_URL_AUTH)) {
    throw new Error(
      'DATABASE_URL_AUTH must be set on Vercel. It is the authentication plane’s own login ' +
        '(app_auth); app_user holds no privilege in the auth schema.',
    );
  }
  if (present(raw.DATABASE_URL_AUTH) && raw.DATABASE_URL_AUTH === raw.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL_AUTH must not be the same connection string as DATABASE_URL: authentication ' +
        'runs on its own login, app_auth.',
    );
  }
  const r = runtimeSchema.safeParse(withoutBlanks(raw));
  return r.success ? r.data : fail(r.error.issues);
}

export function parseToolingEnv(raw: Record<string, unknown>): ToolingEnv {
  const r = toolingSchema.safeParse(withoutBlanks(raw));
  return r.success ? r.data : fail(r.error.issues);
}

export const env: RuntimeEnv = parseRuntimeEnv(process.env);

/**
 * Phase 6 webhook signing secrets are dynamic (`WEBHOOK_SIGNING_SECRET_<REF>`
 * per signatureSecretRef) so they cannot be static schema keys. This helper —
 * in the one file allowed to read process.env — is the sanctioned read path
 * for them. Returns undefined when the ref is unset or blank.
 */
export function webhookSigningSecret(ref: string): string | undefined {
  const key = `WEBHOOK_SIGNING_SECRET_${ref.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`;
  const value = process.env[key];
  return value && value.length > 0 ? value : undefined;
}
