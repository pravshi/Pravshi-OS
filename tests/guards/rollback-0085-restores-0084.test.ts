import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitStatements } from '../../scripts/migrate-ws.mjs';

/**
 * scripts/db/rollback/0085_login_email_case.down.sql promises to restore the 0084 behaviour:
 * it refuses unless the database is at 0085, restores 0020's resolve_login_org, 0083's
 * bootstrap_organization and 0015's complete_bootstrap_setup word for word, and removes exactly
 * the CHECK, trigger and function 0085 adds. (Executed against disposable databases too: see
 * the commit.)
 */
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const M0015 = read('drizzle', '0015_bootstrap.sql');
const M0020 = read('drizzle', '0020_resolve_login_org.sql');
const M0083 = read('drizzle', '0083_platform_identity.sql');
const M0085 = read('drizzle', '0085_login_email_case.sql');
const ROLLBACK = read('scripts', 'db', 'rollback', '0085_login_email_case.down.sql');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripComments = (s: string) => s.replace(/--.*$/gm, '');
const fn = (sql: string, name: string) => {
  const m = sql.match(
    new RegExp(`create (or replace )?function public\\.${name}\\([\\s\\S]*?\\$\\$;`),
  );
  expect(m, name).not.toBeNull();
  return squash(stripComments(m![0].replace('create or replace function', 'create function')));
};

describe('0085 does what its rollback undoes', () => {
  it('0085 adds the CHECK, the trigger and its function, and fixes three comparisons', () => {
    expect(M0085).toMatch(/add constraint auth_users_email_lowercase check/);
    expect(M0085).toMatch(/create trigger auth_users_normalize_email/);
    expect(M0085).toMatch(/create function auth\.normalize_login_email\(\)/);
    expect(M0085).toMatch(/where p\.work_email operator\(public\.=\) p_email/);
    expect(M0085).toMatch(/u\.email operator\(public\.=\) p_owner_work_email::public\.citext/);
    expect(M0085).toMatch(/u\.email operator\(public\.=\) v_person\.work_email/);
  });

  it('the rollback restores the three functions word for word', () => {
    expect(fn(ROLLBACK, 'resolve_login_org')).toBe(fn(M0020, 'resolve_login_org'));
    expect(fn(ROLLBACK, 'bootstrap_organization')).toBe(fn(M0083, 'bootstrap_organization'));
    expect(fn(ROLLBACK, 'complete_bootstrap_setup')).toBe(fn(M0015, 'complete_bootstrap_setup'));
  });

  it('the rollback removes exactly what 0085 added, and refuses unless at 0085', () => {
    const heads = splitStatements(ROLLBACK)
      .map((s) => squash(stripComments(s)))
      .filter((s) => s.length > 0)
      .map((s) => s.split(' ').slice(0, 5).join(' '));
    expect(heads).toEqual([
      'begin;',
      "set local lock_timeout = '5s';",
      'do $$ begin if (select',
      'create or replace function public.resolve_login_org(p_email',
      'create or replace function public.bootstrap_organization(',
      'create or replace function public.complete_bootstrap_setup(p_setup_token_hash',
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
