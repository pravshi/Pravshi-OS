import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitStatements } from '../../scripts/migrate-ws.mjs';

/**
 * scripts/db/rollback/0083_platform_identity.down.sql promises to restore the 0082 state.
 * Pinned statically, as the other rollback guards are: it locks the platform tables, refuses
 * before changing anything unless the database is exactly at 0083 and the platform holds no
 * administrator or audit history, restores 0015's bootstrap_organization, 0008's
 * may_manage_protected_roles and 0024's request_password_reset word for word, and removes
 * only what 0083 added. (Executed against disposable databases too: see the 0083 commit.)
 */
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const M0008 = read('drizzle', '0008_roles_and_permissions.sql');
const M0015 = read('drizzle', '0015_bootstrap.sql');
const M0024 = read('drizzle', '0024_password_reset.sql');
const M0083 = read('drizzle', '0083_platform_identity.sql');
const ROLLBACK = read('scripts', 'db', 'rollback', '0083_platform_identity.down.sql');

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripComments = (s: string) => s.replace(/--.*$/gm, '');
const fn = (sql: string, qualified: string) => {
  const name = qualified.replace('.', '\\.');
  const m = sql.match(new RegExp(`create (or replace )?function ${name}\\([\\s\\S]*?\\$\\$;`));
  expect(m, qualified).not.toBeNull();
  return squash(stripComments(m![0].replace('create or replace function', 'create function')));
};

describe('0083 does what its rollback undoes', () => {
  it('0083 creates the platform schema, the people trigger, and redefines the three functions', () => {
    expect(M0083).toMatch(/^create schema platform authorization app_owner;$/m);
    expect(M0083).toMatch(/create trigger people_login_not_a_platform_admin/);
    expect(M0083).toMatch(/create or replace function public\.bootstrap_organization\(/);
    expect(M0083).toMatch(/create or replace function public\.may_manage_protected_roles\(/);
    expect(M0083).toMatch(/create or replace function authz\.request_password_reset\(/);
  });

  it('the rollback runs in one transaction, locks, and refuses before changing anything', () => {
    expect(ROLLBACK).toMatch(/^begin;$/m);
    expect(ROLLBACK).toMatch(/^commit;$/m);
    const statements = splitStatements(ROLLBACK).map((s) => squash(stripComments(s)));
    const lock = statements.findIndex((s) => s.startsWith('lock table platform.admins'));
    const refusal = statements.findIndex((s) => s.includes('0083 rollback refused'));
    const firstChange = statements.findIndex((s) => /^(drop|alter|create)/.test(s));
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(refusal);
    expect(refusal).toBeLessThan(firstChange);
    expect(statements[refusal]).toContain('from drizzle.__drizzle_migrations) <> 83');
  });

  it('restores 0015, 0008 and 0024 word for word', () => {
    for (const [file, name] of [
      [M0015, 'public.bootstrap_organization'],
      [M0008, 'public.may_manage_protected_roles'],
      [M0024, 'authz.request_password_reset'],
    ] as const) {
      expect(fn(ROLLBACK, name)).toBe(fn(file, name));
    }
  });

  it('touches nothing 0083 did not', () => {
    const heads = splitStatements(ROLLBACK)
      .map((s) => squash(stripComments(s)))
      .filter((s) => s.length > 0)
      .map((s) => s.split(' ').slice(0, 4).join(' '));
    expect(heads).toEqual([
      'begin;',
      'set local lock_timeout =',
      'lock table platform.admins, platform.audit_events,',
      'do $$ begin if',
      'create or replace function', // bootstrap_organization (pinned verbatim above)
      'create or replace function', // may_manage_protected_roles (pinned verbatim above)
      'create or replace function', // request_password_reset (pinned verbatim above)
      'drop trigger people_login_not_a_platform_admin on',
      'drop schema platform cascade;',
      'commit;',
    ]);
  });
});
