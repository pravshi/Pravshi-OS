import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Auth choke point guards (Phase 11, F-11-04 / F-11-05).
 *
 * PR #66's third carry-over: a control that lives only in a custom route is
 * bypassed by Better Auth's built-in endpoints. The sign-in controls —
 * per-account lockout and login-event recording — therefore live in the
 * hooks of src/lib/auth/server.ts, which the library's dispatch runs for
 * auth.api.* calls and [...all] HTTP requests alike (better-auth 1.7.3,
 * dispatchAuthEndpoint). The mediated login route delegates through the
 * same pipeline and records nothing itself, which is what makes every
 * outcome land in public.login_events exactly once.
 *
 * Static/source-level like the other guards — no database needed. The
 * behavioural proof (row counts per path) is DB-backed and lives in
 * tests/integration/auth-choke-point.test.ts, executed in CI.
 */

const root = (...p: string[]) => join(process.cwd(), ...p);
const read = (p: string) => readFileSync(root(...p.split('/')), 'utf8');

const SERVER = read('src/lib/auth/server.ts');
const LOGIN_ROUTE = read('src/app/api/auth/login/route.ts');
const CLIENT = read('src/lib/auth/client.ts');

describe('choke point: both hooks are registered on the auth instance', () => {
  it('defines hooks.before and hooks.after via createAuthMiddleware', () => {
    expect(SERVER).toMatch(/before: createAuthMiddleware/);
    expect(SERVER).toMatch(/after: createAuthMiddleware/);
  });

  it('the after-hook acts on /sign-in/email only', () => {
    const afterHook = SERVER.slice(SERVER.indexOf('after: createAuthMiddleware'));
    expect(afterHook).toMatch(/if \(ctx\.path !== '\/sign-in\/email'\) return;/);
  });
});

describe('choke point: sign-in outcomes are recorded in the after-hook', () => {
  it('records LOGIN_SUCCESS, LOGIN_FAILURE and MFA_CHALLENGE via recordLoginEvent', () => {
    for (const type of ['LOGIN_SUCCESS', 'LOGIN_FAILURE', 'MFA_CHALLENGE']) {
      expect(SERVER).toMatch(new RegExp(`eventType: '${type}'`));
    }
    expect(SERVER).toMatch(/recordSignInOutcome/);
  });

  it('detects failure from the dispatch result (APIError), not from the response', () => {
    expect(SERVER).toMatch(/isAPIError\(args\.returned\)/);
    expect(SERVER).toMatch(/returned: ctx\.context\.returned/);
  });

  it('recognises an MFA challenge from the minted session before the plugin rewrites it', () => {
    expect(SERVER).toMatch(/newSession: ctx\.context\.newSession/);
    expect(SERVER).toMatch(/args\.newSession\?\.user\.twoFactorEnabled === true/);
    expect(SERVER).toMatch(/twoFactorRedirect\?: unknown/);
  });

  it('guards the recording so bookkeeping can never break authentication', () => {
    const afterHook = SERVER.slice(SERVER.indexOf('after: createAuthMiddleware'));
    expect(afterHook).toMatch(/try \{/);
    expect(afterHook).toMatch(/sign-in outcome recording failed/);
  });
});

describe('choke point: single recording (the mediated route holds no second copy)', () => {
  it('the login route delegates and records nothing', () => {
    expect(LOGIN_ROUTE).toMatch(/auth\.api\.signInEmail/);
    expect(LOGIN_ROUTE).not.toMatch(/recordLoginEvent/);
    expect(LOGIN_ROUTE).not.toMatch(/noteLoginFailure|noteLoginSuccess|isLockedOut/);
    expect(LOGIN_ROUTE).not.toMatch(/resolveLoginOrg|clientIp/);
  });

  it('the login route keeps its own jobs: origin check, forwarding, enrolment steer', () => {
    expect(LOGIN_ROUTE).toMatch(/originAllowed\(req\)/);
    expect(LOGIN_ROUTE).toMatch(/twoFactorRedirect/);
    expect(LOGIN_ROUTE).toMatch(/mfaEnrollmentRequired/);
    expect(LOGIN_ROUTE).toMatch(/getSetCookie/);
  });
});

describe('choke point: the library reset request is refused (F-11-05)', () => {
  it('refuses both the live 1.7 path and the legacy spelling, as FORBIDDEN', () => {
    expect(SERVER).toMatch(
      /ctx\.path === '\/forget-password' \|\| ctx\.path === '\/request-password-reset'/,
    );
    const refusal = SERVER.slice(SERVER.indexOf("'/request-password-reset'"));
    expect(refusal.slice(0, 400)).toMatch(/APIError\('FORBIDDEN'/);
    expect(refusal.slice(0, 400)).toMatch(/\/api\/auth\/forgot-password/);
  });

  it('no application code calls the library reset flow', () => {
    expect(CLIENT).not.toMatch(/forgetPassword|requestPasswordReset/);
    expect(LOGIN_ROUTE).not.toMatch(/forgetPassword|requestPasswordReset/);
  });

  it('no sendResetPassword is configured — the refusal is the only door, and it is shut', () => {
    expect(SERVER).not.toMatch(/sendResetPassword\s*:/);
  });
});

describe('choke point: sign-out is recorded (F-11-05, Info)', () => {
  it('records SESSION_REVOKED from the session delete hook, sign-out path only', () => {
    expect(SERVER).toMatch(/delete: \{/);
    expect(SERVER).toMatch(/ctx\?\.path !== '\/sign-out'\) return;/);
    expect(SERVER).toMatch(/eventType: 'SESSION_REVOKED'/);
  });
});
