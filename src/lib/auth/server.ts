import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware, APIError, isAPIError } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import { sql } from 'drizzle-orm';
import { authDb } from '@/lib/db/auth-client';
import { authDbSchema } from './schema';
import { loginPersonActive } from './login-person-check';
import { recordLoginEvent, resolveLoginOrg } from './login-events';
import { isLockedOut, noteLoginFailure, noteLoginSuccess } from './login-lockout';
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
 * The check exists and has one home: validateNewPasswordPolicy() in
 * src/lib/auth/password-reset.ts (length, the common-password list, and the HIBP
 * k-anonymity breach check). The reset and change flows call it directly. The two
 * password-setting flows that are NOT library endpoints — invitation accept and
 * bootstrap setup, both application paths — call the same function (F-11-07), so
 * no path that installs a password is weaker than another. Sign-up stays disabled
 * outright; its entry remains here so the list stays complete.
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

/**
 * ── THE SIGN-IN CHOKE POINT (Phase 11, F-11-04 / F-11-05) ─────────────────────
 *
 * The per-account lockout and the login-event recording used to live only in the
 * mediated route (src/app/api/auth/login/route.ts). Better Auth's own
 * POST /api/auth/sign-in/email — mounted by the [...all] catch-all — skipped
 * both: credential stuffing against one account was bounded only per-IP, and
 * the attempt left no trace in public.login_events. A comment in the client
 * ("direct calls are a bug") was a convention, not a control.
 *
 * Both controls now live in the hooks below, the one place every sign-in
 * crosses: the library dispatches auth.api.* calls and HTTP requests through
 * the same hook pipeline (better-auth 1.7's dispatchAuthEndpoint), so the
 * mediated route (which delegates via auth.api.signInEmail) and a raw POST to
 * the library endpoint are enforced and recorded identically — exactly once
 * per attempt, because the route no longer records anything itself.
 *
 * Lockout semantics are the mediated route's, unchanged (login-lockout.ts,
 * migration 0027): the check runs BEFORE the credential check; a locked
 * account is refused with an error body-identical to the library's own
 * invalid-credentials error, so the refusal is not an oracle; the locked
 * attempt records a LOGIN_FAILURE event but does NOT feed the failure counter
 * (an active lockout is never extended by knocking); and the fixed parity
 * delay below keeps the locked branch from answering faster than a wrong
 * password, which pays for scrypt verification inside the endpoint. (The
 * library itself dummy-hashes on the unknown-user branches — verified in the
 * 1.7.3 sign-in endpoint source — so ordinary failure timing needs no floor.)
 *
 * The after-hook reads the outcome off the dispatch context: a thrown
 * credential failure lands in ctx.context.returned as an APIError; a success
 * lands as the endpoint's result object. An MFA challenge is recognised
 * before the two-factor plugin rewrites that result: user after-hooks run
 * ahead of plugin after-hooks, and when the freshly minted session's user has
 * a second factor enrolled, the plugin is certain to convert the result into
 * { twoFactorRedirect: true } (the trusted-device shortcut that could divert
 * it is refused in the before-hook and can never have been minted here).
 */

/** Timing parity for the lockout refusal — see the choke-point note above. */
const LOCKOUT_TIMING_PARITY_MS = 250;
const timingParityDelay = () =>
  new Promise<void>((resolve) => setTimeout(resolve, LOCKOUT_TIMING_PARITY_MS));

/** The email a sign-in attempt names, trimmed as the mediated route's schema trims it. */
function signInEmailOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const email = (body as { email?: unknown }).email;
  if (typeof email !== 'string') return null;
  const trimmed = email.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** clientIp()'s rule (login-events.ts) over the Headers a hook carries instead of a Request. */
function ipOfHeaders(headers: Headers | undefined): string | null {
  const forwarded = headers?.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() ?? null;
  return ip && ip.length > 0 ? ip : null;
}

/**
 * Records one /sign-in/email outcome — the after-hook half of the choke point.
 * Every helper used here is never-throw by design; the caller still guards, so
 * bookkeeping can never break authentication itself.
 */
async function recordSignInOutcome(args: {
  email: string;
  headers: Headers | undefined;
  returned: unknown;
  newSession: { user: { id?: unknown; twoFactorEnabled?: unknown } } | null | undefined;
}): Promise<void> {
  const ip = ipOfHeaders(args.headers);
  const userAgent = args.headers?.get('user-agent') ?? null;

  if (isAPIError(args.returned)) {
    // Any library refusal of the attempt — wrong password, unknown email, the
    // session-liveness veto, rate limit — is a failed sign-in, recorded the
    // way the mediated route always recorded it.
    const orgId = await resolveLoginOrg(args.email);
    await noteLoginFailure(args.email, ip, userAgent);
    await recordLoginEvent({
      orgId,
      eventType: 'LOGIN_FAILURE',
      email: args.email,
      authUserId: null,
      ip,
      userAgent,
    });
    return;
  }

  if (typeof args.returned !== 'object' || args.returned === null) return;

  const returnedUserId = (args.returned as { user?: { id?: unknown } }).user?.id;
  const sessionUserId = args.newSession?.user.id;
  const authUserId =
    typeof returnedUserId === 'string'
      ? returnedUserId
      : typeof sessionUserId === 'string'
        ? sessionUserId
        : null;
  const orgId = await resolveLoginOrg(args.email);
  await noteLoginSuccess(args.email);

  const challenge =
    (args.returned as { twoFactorRedirect?: unknown }).twoFactorRedirect === true ||
    args.newSession?.user.twoFactorEnabled === true;
  if (challenge) {
    await recordLoginEvent({
      orgId,
      eventType: 'MFA_CHALLENGE',
      email: args.email,
      authUserId,
      ip,
      userAgent,
      metadata: { twoFactorMethods: true },
    });
  } else {
    await recordLoginEvent({
      orgId,
      eventType: 'LOGIN_SUCCESS',
      email: args.email,
      authUserId,
      ip,
      userAgent,
    });
  }
}

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
      delete: {
        /**
         * Sign-out events (F-11-05, Info sub-item): a session deleted BY the
         * /sign-out endpoint is recorded as SESSION_REVOKED.
         *
         * This cannot live in hooks.after on /sign-out: the endpoint keeps
         * the session in a local variable, deletes the row, and returns only
         * { success: true } — by the time an after-hook runs there is nothing
         * left to observe. This hook is the one observation point the library
         * offers: the delete pipeline pre-reads the row and hands it over
         * together with the endpoint context, whose path discriminates a
         * sign-out from every other deletion (revoke-session(s), the
         * two-factor challenge teardown, expiry cleanup — none of them is
         * recorded here). It fires only when a session row actually existed,
         * which is exactly the contract's "when a session existed".
         */
        after: async (session, ctx) => {
          if (ctx?.path !== '/sign-out') return;
          const userId = (session as { userId?: unknown }).userId;
          if (typeof userId !== 'string') return;
          let email: string | null = null;
          try {
            const res = await authDb.execute<{ email: string }>(sql`
              select email::text as email from auth.auth_users where id = ${userId}::uuid limit 1
            `);
            email = res.rows[0]?.email ?? null;
          } catch {
            email = null;
          }
          const ipAddress = (session as { ipAddress?: unknown }).ipAddress;
          const userAgent = (session as { userAgent?: unknown }).userAgent;
          await recordLoginEvent({
            orgId: email !== null ? await resolveLoginOrg(email) : null,
            eventType: 'SESSION_REVOKED',
            email,
            authUserId: userId,
            ip: typeof ipAddress === 'string' ? ipAddress : null,
            userAgent: typeof userAgent === 'string' ? userAgent : null,
          });
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
       * The raw Better Auth change-password endpoint is refused.
       *
       * P1-2 (real-human E2E, 2026-10-03): POST /api/auth/change-password was
       * directly reachable and rotated the credential while bypassing the
       * application's own change-password path (lib/auth/change-password.ts) —
       * its 5/minute rate limit on the current-password oracle, its revocation
       * of every other session, and its auth.password_change audit entry.
       * There is no Better Auth option that disables this endpoint (1.7.x), so
       * the refusal lives here, in the same before-hook that refuses sign-up:
       * the single legitimate way to change a password is the /me/security
       * server action, which never calls this endpoint.
       */
      if (ctx.path === '/change-password') {
        throw new APIError('FORBIDDEN', {
          message:
            'Password changes go through the application security settings. This endpoint is disabled.',
        });
      }

      /**
       * The library's password-reset request is refused (F-11-05).
       *
       * No sendResetPassword is configured, so today the endpoint can only
       * answer RESET_PASSWORD_DISABLED — but it sits unrefused, one config
       * change away from becoming a live second reset flow that bypasses the
       * application policy (breach check, event recording, the app token
       * store). The single legitimate way to request a reset is the mediated
       * /api/auth/forgot-password route.
       *
       * Path note: in the installed Better Auth (1.7.3) the endpoint lives at
       * /request-password-reset; /forget-password is the legacy spelling the
       * library no longer routes (it survives only in its rate-limiter's
       * path list). Both are refused: the live one because it must be, the
       * legacy one so the refusal survives a future re-introduction.
       */
      if (ctx.path === '/forget-password' || ctx.path === '/request-password-reset') {
        throw new APIError('FORBIDDEN', {
          message:
            'Password resets go through /api/auth/forgot-password. This endpoint is disabled.',
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

      /**
       * The per-account lockout, enforced before the credential check on
       * EVERY sign-in path (F-11-04 — see the choke-point note at the top of
       * this file). The refusal is body-identical to the library's own
       * invalid-credentials error, so a locked account is indistinguishable
       * from a wrong password; the attempt is recorded here because a
       * before-hook refusal ends the dispatch before any after-hook runs.
       */
      if (ctx.path === '/sign-in/email') {
        const email = signInEmailOf(ctx.body);
        if (email !== null && (await isLockedOut(email))) {
          const ip = ipOfHeaders(ctx.headers);
          const userAgent = ctx.headers?.get('user-agent') ?? null;
          await recordLoginEvent({
            orgId: await resolveLoginOrg(email),
            eventType: 'LOGIN_FAILURE',
            email,
            authUserId: null,
            ip,
            userAgent,
          });
          // Timing parity: do not answer faster than a wrong-password attempt.
          await timingParityDelay();
          throw new APIError('UNAUTHORIZED', {
            code: 'INVALID_EMAIL_OR_PASSWORD',
            message: 'Invalid email or password',
          });
        }
      }
    }),

    /**
     * Login-event recording for every sign-in outcome (F-11-04 — see the
     * choke-point note). Runs for the mediated route's delegated call and
     * for raw [...all] requests alike; the mediated route records nothing
     * itself, so each attempt lands in public.login_events exactly once.
     */
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/sign-in/email') return;
      const email = signInEmailOf(ctx.body);
      if (email === null) return;
      try {
        await recordSignInOutcome({
          email,
          headers: ctx.headers,
          returned: ctx.context.returned,
          newSession: ctx.context.newSession,
        });
      } catch (e) {
        // The recording helpers are never-throw by design; this guard is the
        // belt to their braces — an APIError escaping an after-hook would
        // replace the sign-in response, so nothing may escape.
        console.error('[auth] sign-in outcome recording failed', {
          name: e instanceof Error ? e.name : typeof e,
        });
      }
    }),
  },
});

export type Auth = typeof auth;
