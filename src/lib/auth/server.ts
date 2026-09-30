import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import { authDb } from '@/lib/db/auth-client';
import { authDbSchema } from './schema';
import { loginPersonActive } from './login-person-check';
import { env } from '@/env';

/** Blueprint section 25: "minimum 12 characters". */
export const MIN_PASSWORD_LENGTH = 12;

/** 30-day rolling expiry, refreshed at most once a day. Blueprint section 25. */
const SESSION_EXPIRY_SECONDS = 60 * 60 * 24 * 30;
const SESSION_REFRESH_SECONDS = 60 * 60 * 24;

/**
 * Every endpoint that accepts a NEW password. The breach-list check of blueprint section 25
 * belongs on all of them, not only on sign-up, because a reset is just as good a way to
 * install a known-compromised password.
 *
 * None of these paths is reachable today: sign-up is disabled outright, and reset needs an
 * email transport that arrives with the invitation task. The list exists so the check has
 * one place to attach rather than being rediscovered three times.
 */
export const PASSWORD_SETTING_PATHS = [
  '/sign-up/email',
  '/reset-password',
  '/change-password',
] as const;

/**
 * The only requests that may mint an aal2 session. Better Auth creates a session after a
 * second factor in exactly one place — verify-two-factor.ts — and it reaches that place
 * through these endpoints: TOTP at sign-in, TOTP at the end of enrolment, and a recovery
 * code. Anything else produces aal1.
 */
export const TWO_FACTOR_VERIFY_PREFIX = '/two-factor/verify-';

/** aal2 means a second factor was verified on THIS session, not that one is enrolled. */
export const sessionAssuranceFor = (path: string | undefined): 'aal1' | 'aal2' =>
  typeof path === 'string' && path.startsWith(TWO_FACTOR_VERIFY_PREFIX) ? 'aal2' : 'aal1';

export const auth = betterAuth({
  appName: 'PRAVSHI OS',
  baseURL: env.APP_URL,
  secret: env.BETTER_AUTH_SECRET,

  database: drizzleAdapter(authDb, { provider: 'pg', schema: authDbSchema }),

  /**
   * THERE IS NO SIGNUP ROUTE — blueprint section 25, and threat T-01 turns on it: "Not
   * 'signup disabled in a dashboard' — no route exists. An account can only come into being
   * by an administrator issuing an invitation."
   *
   * disableSignUp makes the endpoint refuse. It is the library's half of the guarantee; the
   * structural half is that nothing in this repository calls signUpEmail, and that an
   * auth_user with no public.people row pointing at it reaches nothing even if one somehow
   * existed. Three independent barriers, none of which is a frontend check.
   */
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    // Hashing is the library's scrypt. This project does not roll its own KDF.
  },

  session: {
    modelName: 'auth_sessions',
    expiresIn: SESSION_EXPIRY_SECONDS,
    updateAge: SESSION_REFRESH_SECONDS,
    additionalFields: {
      // input: false — no client can propose its own assurance level. It is written by the
      // hook below at creation time and never updated: a session does not gain assurance
      // after the fact, it is minted with it or without it.
      aal: { type: 'string', defaultValue: 'aal1', input: false },
    },
  },
  user: { modelName: 'auth_users' },
  account: { modelName: 'auth_accounts' },
  verification: { modelName: 'auth_verifications' },

  /**
   * Threat T-18, credential stuffing. Storage is the database rather than memory because
   * this runs serverless: per-instance counters reset on every cold start and are shared by
   * nobody, so an attacker spread across instances is not limited at all.
   *
   * Sign-in is singled out well below the default because it is the endpoint being guessed
   * at — ten attempts a minute from one address, against a hundred for everything else.
   */
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    storage: 'database',
    modelName: 'auth_rate_limits',
    customRules: {
      '/sign-in/email': { window: 60, max: 10 },
      '/forget-password': { window: 60, max: 5 },
      '/reset-password': { window: 60, max: 5 },
    },
  },

  advanced: {
    // public.people.auth_user_id has been uuid since Task 1.2. The library adapts to the
    // approved schema, not the other way round.
    database: { generateId: 'uuid' },
    useSecureCookies: env.NODE_ENV === 'production',
    defaultCookieAttributes: {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
    },
  },

  /**
   * TOTP, per blueprint section 25. The library's own plugin rather than a parallel
   * implementation: it already does the things that are easy to get wrong — the challenge
   * cookie is consumed atomically before a session is minted, so a replayed challenge
   * cannot produce a second one; the seed and the recovery codes are encrypted with the
   * application secret before they reach the database; enrolment is not complete until
   * possession is proven; and there is an account-level lockout on consecutive failures.
   *
   * skipVerificationOnEnable is deliberately NOT set. Generating a secret is not enrolment;
   * the factor is only enabled once a code from it has been accepted.
   */
  plugins: [
    twoFactor({
      issuer: 'PRAVSHI OS',
      // Explicit rather than relying on the plugin's default staying put: the low-level
      // helper writes PLAINTEXT recovery codes when this is unset.
      backupCodeOptions: { storeBackupCodes: 'encrypted' },
      // The plugin calls its model `twoFactor`; ours follows the auth_* convention Task 1.12
      // set. Column names are mapped by the Drizzle definitions, as for every other table.
      schema: { twoFactor: { modelName: 'auth_two_factors' } },
    }),
  ],

  databaseHooks: {
    session: {
      create: {
        /**
         * Stamps the assurance onto the session at the moment it is created. This is the
         * whole mechanism: `aal2` is a fact about how THIS session came to exist, not a
         * property inherited from the person's enrolment status.
         *
         * BUG-002: the same hook is the liveness gate for session minting. A suspended
         * (or deleted, or person-less) login must not receive a session from ANY path —
         * the mediated /api/auth/login and /api/auth/mfa/verify routes, or the raw
         * [...all] endpoints. Returning false aborts the creation before any row or
         * cookie exists; the library answers 401 UNAUTHORIZED (FAILED_TO_CREATE_SESSION)
         * and the mediated routes record their normal failure events with the
         * deliberately generic 401, so suspension is indistinguishable from bad
         * credentials. Fail closed: when the check itself cannot be answered, no
         * session is minted.
         */
        before: async (session, ctx) => {
          const userId = (session as { userId?: unknown }).userId;
          if (typeof userId !== 'string' || !(await loginPersonActive(userId))) {
            return false;
          }
          return {
            data: { ...session, aal: sessionAssuranceFor(ctx?.path) },
          };
        },
      },
    },
  },

  hooks: {
    /**
     * A second refusal in front of sign-up, independent of the library's own.
     *
     * disableSignUp is configuration, and configuration is one edit away from being
     * flipped by somebody who wants a quick test account. This is the same guarantee
     * expressed as code, next to a comment explaining why it must not be removed. Threat
     * T-01's test is "attempt account creation by every reachable path (direct POST to the
     * auth endpoints included) → rejected".
     */
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/sign-up/email') {
        throw new APIError('FORBIDDEN', {
          message:
            'Accounts are created by invitation only. There is no sign-up route in PRAVSHI OS.',
        });
      }

      /**
       * Remembered devices are refused.
       *
       * The plugin can issue a trusted-device cookie that skips the prompt for thirty days.
       * A session minted that way has not had a second factor verified on it, so calling it
       * aal2 would make the level mean "enrolled and recently trusted" instead of "verified
       * now" — which is the distinction this task exists to establish. Asking for it is an
       * error rather than a silently ignored flag, so a client cannot believe it got
       * something it did not.
       */
      if (ctx.path?.startsWith('/two-factor/') && ctx.body?.trustDevice) {
        throw new APIError('BAD_REQUEST', {
          message:
            'Trusted devices are disabled: every privileged session must verify its second factor.',
        });
      }
    }),
  },
});

export type Auth = typeof auth;
