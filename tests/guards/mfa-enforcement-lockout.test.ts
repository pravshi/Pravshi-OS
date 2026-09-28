import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * MFA enforcement + login lockout guards.
 *
 * Static/source-level like the other guards — no database needed. These pin the
 * Phase 1 authentication hardening: privileged roles must enroll in TOTP (gated
 * at the admin layout and steered post-login), the TOTP lifecycle is audited at
 * HIGH severity, and consecutive password failures lock the account without
 * leaking the lockout to the client.
 */

const root = (...p: string[]) => join(process.cwd(), ...p);
const MIGRATION = readFileSync(root('drizzle/0027_mfa_enforcement_lockout.sql'), 'utf8');
const HELPER = readFileSync(root('src/lib/auth/mfa-enforcement.ts'), 'utf8');
const LOGIN_ROUTE = readFileSync(root('src/app/api/auth/login/route.ts'), 'utf8');
const ADMIN_LAYOUT = readFileSync(root('src/app/(app)/admin/layout.tsx'), 'utf8');
const LOGIN_PAGE = readFileSync(root('src/app/(auth)/login/page.tsx'), 'utf8');
const SECURITY_PAGE = readFileSync(root('src/app/(app)/me/security/page.tsx'), 'utf8');
const AUDIT_LIB = readFileSync(root('src/lib/admin/audit.ts'), 'utf8');

describe('migration 0027: login lockout table', () => {
  it('creates auth.login_lockouts keyed by login with window + lockout columns', () => {
    expect(MIGRATION).toMatch(/create table auth\.login_lockouts/);
    expect(MIGRATION).toMatch(/failed_count integer not null/);
    expect(MIGRATION).toMatch(/window_start timestamptz not null/);
    expect(MIGRATION).toMatch(/locked_until timestamptz/);
  });

  it('enables and forces RLS with an owner-only policy', () => {
    expect(MIGRATION).toMatch(/enable row level security/);
    expect(MIGRATION).toMatch(/force row level security/);
    expect(MIGRATION).toMatch(/for all to app_owner/);
  });

  it('defines check/record/clear functions as SECURITY DEFINER granted to app_user only', () => {
    for (const fn of ['check_login_lockout', 'record_login_failure', 'clear_login_lockout']) {
      expect(MIGRATION).toMatch(new RegExp(`function authz\\.${fn}`));
      expect(MIGRATION).toMatch(/security definer/);
    }
    expect(MIGRATION).toMatch(
      /revoke all on function authz\.check_login_lockout\(text\) from public/,
    );
    expect(MIGRATION).toMatch(
      /grant execute on function authz\.check_login_lockout\(text\) to app_user/,
    );
  });

  it('locks after 5 failures in 15 minutes for 15 minutes', () => {
    expect(MIGRATION).toMatch(/v_failed >= 5/);
    expect(MIGRATION).toMatch(/interval '15 minutes'/);
  });

  it('writes a HIGH auth.login.lockout audit entry on lockout, attributed to the person', () => {
    expect(MIGRATION).toMatch(/'auth\.login\.lockout'/);
    expect(MIGRATION).toMatch(/'HIGH'/);
    expect(MIGRATION).toMatch(/actor_person_id/);
  });

  it('does not track unknown emails and does not extend an active lockout', () => {
    expect(MIGRATION).toMatch(/if v_auth_user_id is null then\s+return false/);
    expect(MIGRATION).toMatch(/neither extended/i);
  });
});

describe('migration 0027: TOTP lifecycle audit trigger', () => {
  it('attaches an AFTER trigger on auth.auth_two_factors', () => {
    expect(MIGRATION).toMatch(/create trigger audit_two_factor_change/);
    expect(MIGRATION).toMatch(/after insert or update or delete on auth\.auth_two_factors/);
  });

  it('maps insert/update/delete to enroll/enabled/disabled/backup-codes actions', () => {
    expect(MIGRATION).toMatch(/'mfa\.totp\.enroll'/);
    expect(MIGRATION).toMatch(/'mfa\.totp\.enabled'/);
    expect(MIGRATION).toMatch(/'mfa\.totp\.disabled'/);
    expect(MIGRATION).toMatch(/'mfa\.backup_codes\.regenerated'/);
  });

  it('audits at HIGH severity and never carries the secret or backup codes', () => {
    expect(MIGRATION).toMatch(/'HIGH', 'SUCCESS'/);
    expect(MIGRATION).not.toMatch(/NEW\.secret/);
    // NEW.backup_codes is used only in the `is distinct from` change-detection
    // comparison; the audit row itself must not carry the code values.
    const triggerFn = MIGRATION.match(
      /create function authz\.audit_two_factor_change\(\)[\s\S]*?\$\$;/,
    )?.[0];
    expect(triggerFn).toBeDefined();
    const insertBlock = triggerFn!.match(/insert into public\.audit_logs[\s\S]*?;/);
    expect(insertBlock).toBeDefined();
    expect(insertBlock![0]).not.toMatch(/backup_codes|secret/i);
  });

  it('stays quiet on non-lifecycle updates (e.g. failed_verification_count)', () => {
    expect(MIGRATION).toMatch(/is distinct from NEW\.backup_codes/);
    expect(MIGRATION).toMatch(/return null/);
  });
});

describe('migration 0027: mfa_enrollment_required()', () => {
  it('checks users.manage or roles.manage and the verified TOTP factor', () => {
    expect(MIGRATION).toMatch(/function authz\.mfa_enrollment_required/);
    expect(MIGRATION).toMatch(/'users\.manage', 'roles\.manage'/);
    expect(MIGRATION).toMatch(/tf\.verified = true/);
  });

  it('is SECURITY DEFINER granted to app_user (callable pre-auth)', () => {
    expect(MIGRATION).toMatch(
      /grant execute on function authz\.mfa_enrollment_required\(uuid\) to app_user/,
    );
  });
});

describe('mfa-enforcement helper', () => {
  it('exposes mfaEnrollmentRequired() and requireMfaEnrolled()', () => {
    expect(HELPER).toMatch(/export async function mfaEnrollmentRequired/);
    expect(HELPER).toMatch(/export async function requireMfaEnrolled/);
  });

  it('requireMfaEnrolled redirects unenrolled privileged users to /me/security', () => {
    expect(HELPER).toMatch(/redirect\('\/me\/security\?enrollment=required'\)/);
  });

  it('validates the login id as a UUID before querying', () => {
    expect(HELPER).toMatch(/UUID\.test\(authUserId\)/);
  });
});

describe('admin layout enrollment gate', () => {
  it('calls requireMfaEnrolled before rendering admin routes', () => {
    expect(ADMIN_LAYOUT).toMatch(/await requireMfaEnrolled\(\)/);
  });
});

describe('login route: lockout + enrollment', () => {
  it('checks the lockout before the credential check and answers generic 401', () => {
    expect(LOGIN_ROUTE).toMatch(/isLockedOut\(body\.email\)/);
    expect(LOGIN_ROUTE).toMatch(/INVALID_CREDENTIALS/);
    // No lockout-specific error code may reach the client.
    expect(LOGIN_ROUTE).not.toMatch(/ACCOUNT_LOCKED|LOCKED_OUT/);
  });

  it('records failures and clears the counter on success', () => {
    // Lockout bookkeeping lives in the auth module (single-db-path guard:
    // authDb is auth-module only); the route delegates to it.
    expect(LOGIN_ROUTE).toMatch(/from '@\/lib\/auth\/login-lockout'/);
    expect(LOGIN_ROUTE).toMatch(/noteLoginFailure\(body\.email, ip, userAgent\)/);
    expect(LOGIN_ROUTE).toMatch(/noteLoginSuccess\(body\.email\)/);
  });

  it('adds the mfaEnrollmentRequired hint to the success response', () => {
    expect(LOGIN_ROUTE).toMatch(/mfaEnrollmentRequired/);
  });

  it('keeps anti-enumeration: failure paths stay generic', () => {
    const failures = LOGIN_ROUTE.match(/return reply\(401, \{ error: 'INVALID_CREDENTIALS' \}\)/g);
    expect(failures).not.toBeNull();
    expect(failures!.length).toBeGreaterThanOrEqual(3);
  });
});

describe('login page: enrollment steer', () => {
  it('redirects to /me/security when the server flags enrollment', () => {
    expect(LOGIN_PAGE).toMatch(/mfaEnrollmentRequired/);
    expect(LOGIN_PAGE).toMatch(/router\.push\('\/me\/security\?enrollment=required'\)/);
  });
});

describe('/me/security: enrollment notice', () => {
  it('renders the required-enrollment banner on ?enrollment=required', () => {
    expect(SECURITY_PAGE).toMatch(/enrollment=required/);
    expect(SECURITY_PAGE).toMatch(/Two-factor authentication is required/);
  });
});

describe('audit logs: severity visibility', () => {
  it('queries and filters by severity', () => {
    expect(AUDIT_LIB).toMatch(/severity\?: string/);
    expect(AUDIT_LIB).toMatch(/a\.severity/);
  });
});
