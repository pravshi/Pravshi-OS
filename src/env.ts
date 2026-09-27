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
  const r = runtimeSchema.safeParse(withoutBlanks(raw));
  return r.success ? r.data : fail(r.error.issues);
}

export function parseToolingEnv(raw: Record<string, unknown>): ToolingEnv {
  const r = toolingSchema.safeParse(withoutBlanks(raw));
  return r.success ? r.data : fail(r.error.issues);
}

export const env: RuntimeEnv = parseRuntimeEnv(process.env);
