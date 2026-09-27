import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Session revocation has two halves (blueprint §25): deleting the session rows and
 * stamping people.sessions_revoked_at so a surviving session still fails. The helper
 * once promised both and delivered only the delete. app_user holds a SELECT-only
 * policy on people, so the stamp goes through the narrow SECURITY DEFINER function
 * from migration 0023.
 */

const MIGRATION_23 = readFileSync(
  join(process.cwd(), 'drizzle/0023_stamp_sessions_revoked.sql'),
  'utf8',
);
const SESSION = readFileSync(join(process.cwd(), 'src/lib/auth/session.ts'), 'utf8');

describe('session revocation stamps sessions_revoked_at', () => {
  it('0023: authz.stamp_sessions_revoked is SECURITY DEFINER with a pinned search_path', () => {
    expect(MIGRATION_23).toMatch(/security definer/);
    expect(MIGRATION_23).toMatch(/set search_path = ''/);
    expect(MIGRATION_23).toMatch(/sessions_revoked_at = now\(\)/);
  });

  it('0023: the stamp function is granted to app_user only', () => {
    expect(MIGRATION_23).toMatch(
      /revoke all on function authz\.stamp_sessions_revoked\(uuid\) from public/,
    );
    expect(MIGRATION_23).toMatch(
      /grant execute on function authz\.stamp_sessions_revoked\(uuid\) to app_user/,
    );
  });

  it('revokeSessionsFor deletes the rows AND calls the stamp function', () => {
    expect(SESSION).toMatch(/delete from auth\.auth_sessions where user_id/);
    expect(SESSION).toMatch(/select authz\.stamp_sessions_revoked\(\$\{authUserId\}::uuid\)/);
  });
});
