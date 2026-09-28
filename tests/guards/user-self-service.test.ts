import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * User self-service guards: change-password and personal login history.
 *
 * Static/source-level like the other guards — no database needed. Pins the
 * contract: current-password verification before rotation, the shared password
 * policy (no drift between reset and change), other-sessions revocation that
 * keeps the current session, audit attribution, and the narrow SELF read on
 * login_events.
 */

const root = (...p: string[]) => join(process.cwd(), ...p);
const SERVICE = readFileSync(root('src/lib/auth/change-password.ts'), 'utf8');
const ACTIONS = readFileSync(root('src/app/(app)/me/security/actions.ts'), 'utf8');
const CLIENT = readFileSync(root('src/app/(app)/me/security/security-client.tsx'), 'utf8');
const MIGRATION_29 = readFileSync(root('drizzle/0029_login_events_self_read.sql'), 'utf8');
const JOURNAL = readFileSync(root('drizzle/meta/_journal.json'), 'utf8');

describe('change password: current password is verified first', () => {
  it('reads the stored credential hash and verifies before anything else', () => {
    expect(SERVICE).toMatch(/provider_id = 'credential'/);
    expect(SERVICE).toMatch(/context\.password\.verify\(\{\s*password: currentPassword/);
    const verifyIdx = SERVICE.indexOf('context.password.verify');
    const policyIdx = SERVICE.indexOf('validateNewPasswordPolicy(newPassword)');
    const updateIdx = SERVICE.indexOf('update_credential_password');
    expect(verifyIdx).toBeGreaterThan(-1);
    // Verify → policy → update: no rotation without a correct current password.
    expect(policyIdx).toBeGreaterThan(verifyIdx);
    expect(updateIdx).toBeGreaterThan(policyIdx);
  });

  it('wrong current password fails closed with a distinct error', () => {
    expect(SERVICE).toMatch(/'WRONG_CURRENT_PASSWORD'/);
  });

  it('guessing the current password is rate-limited per login', () => {
    expect(SERVICE).toMatch(/pwchange:\$\{authUserId\}/);
    expect(SERVICE).toMatch(/check_rate_limit/);
  });
});

describe('change password: the policy is shared, never duplicated', () => {
  it('uses validateNewPasswordPolicy from the reset module', () => {
    expect(SERVICE).toMatch(
      /import \{ validateNewPasswordPolicy, PasswordResetError \} from '\.\/password-reset'/,
    );
    expect(SERVICE).toMatch(/await validateNewPasswordPolicy\(newPassword\)/);
  });

  it('the reset module still owns the policy (no second copy)', () => {
    const policy = readFileSync(root('src/lib/auth/password-reset.ts'), 'utf8');
    expect(policy).toMatch(/export async function validateNewPasswordPolicy/);
    expect(policy).toMatch(/if \(isCommonPassword\(password\)\)/);
  });
});

describe('change password: sessions and audit', () => {
  it('revokes every OTHER session but keeps the current one', () => {
    expect(SERVICE).toMatch(/delete from auth\.auth_sessions/);
    expect(SERVICE).toMatch(/and token != \$\{currentSessionToken\}/);
    // No sessions_revoked_at stamp: that would kill the session in flight.
    expect(SERVICE).not.toMatch(/stamp_sessions_revoked/);
  });

  it('writes a HIGH audit entry attributed to the person', () => {
    expect(SERVICE).toMatch(/writeAuditEntry/);
    expect(SERVICE).toMatch(/'auth\.password_change'/);
    expect(SERVICE).toMatch(/severity: 'HIGH'/);
  });

  it('never logs a plaintext password', () => {
    for (const src of [SERVICE, ACTIONS]) {
      expect(src).not.toMatch(/console\.(log|error|warn)\([\s\S]{0,120}password/i);
    }
  });
});

describe('login history: narrow SELF read', () => {
  it('0029 installs a SELECT-only self policy on login_events', () => {
    expect(MIGRATION_29).toMatch(/create policy login_events_select_self/);
    expect(MIGRATION_29).toMatch(/for select to app_user/);
    expect(MIGRATION_29).toMatch(/authz\.person_id\(\)/);
    expect(MIGRATION_29).toMatch(/authz\.is_active\(\)/);
    // Still no write policy for app_user in this migration.
    expect(MIGRATION_29).not.toMatch(/for (insert|update|delete)/);
  });

  it('0029 is registered in the drizzle journal', () => {
    expect(JOURNAL).toMatch(/0029_login_events_self_read/);
  });

  it('both actions open with requirePermission (people.view, SELF)', () => {
    expect(ACTIONS).toMatch(/permission: 'people\.view'/);
    expect(ACTIONS).toMatch(/minScope: 'SELF'/);
  });

  it('the action pages 20 at a time through the authorized (RLS) connection', () => {
    expect(ACTIONS).toMatch(/HISTORY_PAGE_SIZE = 20/);
    expect(ACTIONS).toMatch(/withAuthorizedDb\(authz\.ctx/);
    expect(ACTIONS).toMatch(/from public\.login_events/);
    expect(ACTIONS).toMatch(/order by occurred_at desc/);
  });

  it('the client exposes change-password and history sections', () => {
    expect(CLIENT).toMatch(/Change password/);
    expect(CLIENT).toMatch(/Login history/);
    expect(CLIENT).toMatch(/changePasswordAction/);
    expect(CLIENT).toMatch(/getLoginHistoryAction/);
  });
});
