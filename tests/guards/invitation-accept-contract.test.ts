import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The invitation-accept call contract between the app and the database.
 *
 * This drifted once: the app called public.accept_invitation(digest, passwordHash,
 * fullName) while the function declares (p_token_hash, p_full_name, p_password_hash),
 * and selected linked_person_id/linked_org_id/linked_auth_user_id while the function
 * returns (person_id, auth_user_id, org_id, email). The invite→login path was broken
 * end to end, and nothing caught it because no test read both sides. The function's
 * error codes drifted too: it raised P0001 everywhere while the app maps 28000 to
 * "invalid link" and 55000 to "cannot complete".
 *
 * This guard pins the three together: the function's signature, the app's call, and
 * the error codes. Like the other guards it is a heuristic over source text and
 * fails closed on any shape it does not recognise.
 */

const MIGRATION_19 = readFileSync(
  join(process.cwd(), 'drizzle/0019_invitation_accept_functions.sql'),
  'utf8',
);
const CALLER = readFileSync(join(process.cwd(), 'src/lib/auth/invitations.ts'), 'utf8');

describe('accept_invitation call contract', () => {
  it('0019: function takes (p_token_hash, p_full_name, p_password_hash) in that order', () => {
    expect(MIGRATION_19).toMatch(
      /create function public\.accept_invitation\(([\s\S]*?)p_token_hash text,[\s\S]*?p_full_name text,[\s\S]*?p_password_hash text[\s\S]*?\)/,
    );
  });

  it('0019: function returns (person_id, auth_user_id, org_id, email)', () => {
    expect(MIGRATION_19).toMatch(
      /returns table \(person_id uuid, auth_user_id uuid, org_id uuid, email public\.citext\)/,
    );
  });

  it('app: calls accept_invitation(digest, fullName, passwordHash) and reads person_id/org_id', () => {
    expect(CALLER).toMatch(
      /from public\.accept_invitation\(\$\{digest\}, \$\{input\.fullName\}, \$\{passwordHash\}\)/,
    );
    expect(CALLER).toMatch(/select person_id, auth_user_id, org_id/);
    expect(CALLER).not.toMatch(/linked_person_id/);
  });

  it('0019: invalid/expired/used/revoked raises 28000, the code the app maps to "invalid link"', () => {
    expect(MIGRATION_19).toMatch(
      /invitation invalid, expired, revoked or already used'[\s\S]*?using errcode = '28000'/,
    );
    expect(CALLER).toMatch(/if \(code === '28000'\)/);
  });

  it('0019: cannot-complete states raise 55000, the code the app maps to "cannot complete"', () => {
    expect(MIGRATION_19).toMatch(
      /the person named by this invitation cannot accept it'[\s\S]*?using errcode = '55000'/,
    );
    expect(MIGRATION_19).toMatch(
      /this invitation carries no engagement and the person has none'[\s\S]*?using errcode = '55000'/,
    );
    expect(CALLER).toMatch(/if \(code === '55000' \|\| code === '23505'\)/);
  });
});
