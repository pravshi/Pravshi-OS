import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import { authDb } from '@/lib/db/auth-client';
import { authDbSchema } from './schema';
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
    }),
  },
});

export type Auth = typeof auth;
