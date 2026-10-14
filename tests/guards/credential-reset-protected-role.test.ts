import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Credential-reset protected-role target guard (ADR-001, security fix).
 *
 * adminResetCredential() authorizes the CALLER (users.edit) but a non-SUPER_ADMIN
 * holder of users.edit must never reset a protected-role holder's credential —
 * the latent account takeover. The application connects as app_user, whose RLS
 * view of the role tables is self-only, so the target-side question cannot be a
 * join in the application: it would see none of the target's assignments and
 * conclude "not protected", failing OPEN. The truth comes from a SECURITY
 * DEFINER function (migration 0030) that answers as the owner through
 * role_is_protected().
 *
 * Like the other guards this is a heuristic over source text, not a type proof:
 * it fails closed on any shape it does not recognise. The behaviour itself is
 * pinned against a real database in tests/db/credential-reset.test.ts.
 */

const MIGRATION = readFileSync(
  join(process.cwd(), 'drizzle/0030_credential_reset_protected_target.sql'),
  'utf8',
);
const SERVICE = readFileSync(join(process.cwd(), 'src/lib/admin/credential-reset.ts'), 'utf8');
// Since 0072 the decision is made in the database, by the definer that proves the administrator
// from their own session token: the ADR-001 rule, its DENIED audit and the target errors live
// there; the service maps the outcome and writes the success entry.
const DEFINER = (() => {
  const sql = readFileSync(join(process.cwd(), 'drizzle/0072_auth_role_expand.sql'), 'utf8');
  const start = sql.indexOf('create function authz.admin_issue_credential_reset(');
  return sql.slice(start, sql.indexOf('$$;', start));
})();
const AUTH_LAYER = readFileSync(join(process.cwd(), 'src/lib/auth/admin-credentials.ts'), 'utf8');

describe('0030: person_holds_protected_role is an app-callable definer function', () => {
  it('is SECURITY DEFINER with a pinned search_path', () => {
    expect(MIGRATION).toMatch(/security definer/);
    expect(MIGRATION).toMatch(/set search_path = ''/);
  });

  it('is revoked from PUBLIC and granted to app_user only', () => {
    expect(MIGRATION).toMatch(
      /revoke all on function public\.person_holds_protected_role\(uuid, uuid\) from public/,
    );
    expect(MIGRATION).toMatch(
      /grant execute on function public\.person_holds_protected_role\(uuid, uuid\) to app_user/,
    );
  });

  it('derives protection through role_is_protected, not the flag alone', () => {
    // Protection follows the capability: a role carrying roles.manage /
    // permissions.manage is protected even without the is_protected flag.
    expect(MIGRATION).toMatch(/public\.role_is_protected\(r\.id\)/);
  });

  it('counts only live assignments in the given organization', () => {
    expect(MIGRATION).toMatch(/pr\.org_id = p_org_id/);
    expect(MIGRATION).toMatch(/pr\.expires_at is null or pr\.expires_at > now\(\)/);
    expect(MIGRATION).toMatch(/r\.deleted_at is null/);
    expect(MIGRATION).toMatch(/r\.status = 'ACTIVE'/);
  });
});

describe('adminResetCredential refuses protected-role targets for unprivileged callers', () => {
  it('asks the definer function about the target, not a local join (in the 0072 definer)', () => {
    expect(DEFINER).toMatch(/public\.person_holds_protected_role\(p_target_person_id, v_org\)/);
  });

  it('checks the actor holds roles.manage at GLOBAL scope (in the 0072 definer)', () => {
    expect(DEFINER).toMatch(/authz\.scope_for\('roles\.manage'\)\) = 'GLOBAL'/);
  });

  it('takes the actor from the verified session, never from a setting (0072)', () => {
    expect(DEFINER).toMatch(/from authz\.verified_session_actor\(p_actor_session_token\) a/);
    expect(DEFINER).not.toMatch(/current_setting\(/);
  });

  it('audits the refusal as a HIGH denial that commits (returned, not raised)', () => {
    expect(DEFINER).toMatch(/p_result := 'DENIED'::public\.audit_result/);
    expect(DEFINER).toMatch(/p_severity := 'HIGH'/);
    expect(DEFINER).toMatch(/'reason', 'PROTECTED_ROLE_TARGET'/);
    expect(DEFINER).toMatch(/return query select 'DENIED'::text/);
  });

  it('throws a clear error naming protected roles', () => {
    expect(SERVICE).toMatch(/holds a protected role/);
  });

  it('keeps the existing target errors and the HIGH success audit', () => {
    expect(AUTH_LAYER).toMatch(/Person not found\./);
    expect(AUTH_LAYER).toMatch(/This person has no login\./);
    expect(SERVICE).toMatch(/result: 'SUCCESS'/);
    // The success audit stays HIGH severity.
    const successAudit = SERVICE.match(
      /action: 'admin\.credential_reset'[\s\S]*?result: 'SUCCESS'[\s\S]*?severity: 'HIGH'/,
    );
    expect(successAudit).not.toBeNull();
  });
});
