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

export function parseRuntimeEnv(raw: Record<string, unknown>): RuntimeEnv {
  // A leaked owner credential is a silent, total loss of RLS. Refuse to start.
  //
  // `next build` is not a boot. It evaluates every route module to collect page
  // data, and it runs on developer machines and in CI — both of which hold
  // DATABASE_URL_MIGRATE legitimately, because that is where migrations are run
  // from. Exempting that one phase keeps the rule aimed at the thing it protects:
  // the serving runtime, which must never hold app_owner. A migration credential
  // wrongly added to Vercel still fails the application closed on its first
  // request; it does not slip through.
  const isBuildPhase = raw.NEXT_PHASE === 'phase-production-build';
  if (!isBuildPhase && raw.NODE_ENV === 'production' && raw.DATABASE_URL_MIGRATE) {
    throw new Error(
      'DATABASE_URL_MIGRATE must never be present in the runtime environment. ' +
        'It uses app_owner, which owns the schema and is not constrained by RLS. ' +
        'Remove it from the Vercel environment.',
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
