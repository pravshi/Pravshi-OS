import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitStatements } from '../../scripts/migrate-ws.mjs';

/**
 * scripts/db/rollback/0085_login_email_case.down.sql promises to restore the 0084 behaviour:
 * it refuses unless the database is at 0085, restores 0020's resolve_login_org word for word
 * and removes exactly the CHECK, trigger and function 0085 adds. (Executed against disposable
 * databases too: see the commit.)
 */
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const M0020 = read('drizzle', '0020_resolve_login_org.sql');
const M0085 = read('drizzle', '0085_login_email_case.sql');
const ROLLBACK = read('scripts', 'db', 'rollback', '0085_login_email_case.down.sql');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripComments = (s: string) => s.replace(/--.*$/gm, '');
const fn = (sql: string) => {
  const m = sql.match(/create (or replace )?function public\.resolve_login_org\([\s\S]*?\$\$;/);
  expect(m).not.toBeNull();
  return squash(stripComments(m![0].replace('create or replace function', 'create function')));
};

describe('0085 does what its rollback undoes', () => {
  it('0085 adds the CHECK, the trigger and its function, and redefines resolve_login_org', () => {
    expect(M0085).toMatch(/add constraint auth_users_email_lowercase check/);
    expect(M0085).toMatch(/create trigger auth_users_normalize_email/);
    expect(M0085).toMatch(/create function auth\.normalize_login_email\(\)/);
    expect(M0085).toMatch(/where p\.work_email operator\(public\.=\) p_email/);
  });

  it('the rollback restores 0020 word for word and removes exactly what 0085 added', () => {
    expect(fn(ROLLBACK)).toBe(fn(M0020));
    const heads = splitStatements(ROLLBACK)
      .map((s) => squash(stripComments(s)))
      .filter((s) => s.length > 0)
      .map((s) => s.split(' ').slice(0, 5).join(' '));
    expect(heads).toEqual([
      'begin;',
      "set local lock_timeout = '5s';",
      'do $$ begin if (select',
      'create or replace function public.resolve_login_org(p_email',
      'alter table auth.auth_users drop constraint',
      'drop trigger auth_users_normalize_email on auth.auth_users;',
      'drop function auth.normalize_login_email();',
      'commit;',
    ]);
    const s = splitStatements(ROLLBACK).map((x) => squash(stripComments(x)));
    expect(s.find((x) => x.includes('0085 rollback refused'))).toContain(
      'from drizzle.__drizzle_migrations) <> 85',
    );
  });
});
