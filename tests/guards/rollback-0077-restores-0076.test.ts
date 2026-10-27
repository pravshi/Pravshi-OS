import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * scripts/db/rollback/0077_deal_history_and_org_identity.down.sql promises to restore
 * the 0076 state. This pins that promise statically, as the 0075 rollback guard does:
 * the rollback undoes exactly what 0077 does, and the policy it recreates is 0037's
 * policy word for word — a rollback that recreated a different policy would be a
 * new migration nobody reviewed.
 */
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const M0037 = read('drizzle', '0037_sales_pipeline.sql');
const M0077 = read('drizzle', '0077_deal_history_and_org_identity.sql');
const ROLLBACK = read('scripts', 'db', 'rollback', '0077_deal_history_and_org_identity.down.sql');

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The `create policy deal_stage_history_insert … ;` statement of a file. */
function insertPolicy(sql: string): string {
  const m = sql.match(/create policy deal_stage_history_insert[\s\S]*?\);/);
  expect(m, 'create policy deal_stage_history_insert').not.toBeNull();
  return squash(m![0]);
}

describe('0077 does what its rollback undoes', () => {
  it('0077 drops the policy, revokes the grants and adds the freeze', () => {
    expect(M0077).toMatch(
      /drop policy if exists deal_stage_history_insert on public\.deal_stage_history;/,
    );
    expect(M0077).toMatch(
      /revoke insert, update on public\.deal_stage_history from app_user, app_admin;/,
    );
    expect(M0077).toMatch(
      /create trigger organizations_identity_freeze\s+before update on public\.organizations/,
    );
    expect(M0077).toMatch(/create function public\.organizations_identity_freeze\(\)/);
  });

  it('the rollback runs in one transaction', () => {
    expect(ROLLBACK).toMatch(/^begin;$/m);
    expect(ROLLBACK).toMatch(/^commit;$/m);
  });

  it('the rollback removes the freeze trigger and its function', () => {
    expect(ROLLBACK).toMatch(
      /drop trigger if exists organizations_identity_freeze on public\.organizations;/,
    );
    expect(ROLLBACK).toMatch(/drop function if exists public\.organizations_identity_freeze\(\);/);
  });

  it("the rollback restores app_user's grants and 0037's insert policy exactly", () => {
    expect(ROLLBACK).toMatch(/grant insert, update on public\.deal_stage_history to app_user;/);
    expect(insertPolicy(ROLLBACK)).toBe(insertPolicy(M0037));
  });

  it('the rollback touches nothing 0077 did not', () => {
    // Comments first: a semicolon inside a comment is not a statement boundary.
    const statements = ROLLBACK.replace(/--.*$/gm, '')
      .split(';')
      .map(squash)
      .filter((s) => s.length > 0);
    expect(statements.map((s) => s.split(' ').slice(0, 3).join(' '))).toEqual([
      'begin',
      'drop trigger if',
      'drop function if',
      'grant insert, update',
      'drop policy if',
      'create policy deal_stage_history_insert',
      'commit',
    ]);
  });
});
