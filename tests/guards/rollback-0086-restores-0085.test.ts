import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitStatements } from '../../scripts/migrate-ws.mjs';

/**
 * scripts/db/rollback/0086_platform_console.down.sql: refuses unless the database is at 0086,
 * drops exactly the one function 0086 adds, and restores the two it replaces verbatim from 0083.
 */
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const M0086 = read('drizzle', '0086_platform_console.sql');
const ROLLBACK = read('scripts', 'db', 'rollback', '0086_platform_console.down.sql');
const M0083 = read('drizzle', '0083_platform_identity.sql');
/** A function's whole definition, from its create statement to the end of its body. */
const definition = (sql: string, name: string) => {
  const head = [`create function ${name}(`, `create or replace function ${name}(`]
    .map((h) => sql.indexOf(h))
    .filter((i) => i >= 0);
  expect(head.length, name).toBe(1);
  const start = head[0]!;
  const end = sql.indexOf('$$;', sql.indexOf('as $$', start)) + 3;
  return sql.slice(start, end).replace('create or replace function', 'create function');
};
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripComments = (s: string) => s.replace(/--.*$/gm, '');

describe('0086 does what its rollback undoes', () => {
  it('every object 0086 creates, the rollback drops — and nothing else', () => {
    const created = [...M0086.matchAll(/^create function (\S+)\(/gm)].map((m) => m[1]);
    expect(created).toEqual([
      'platform.list_admins',
      'platform.login_may_sign_in',
      'platform.end_stale_admin_session',
      'platform.first_admin_recipient_fixed',
      'platform.invite_admin_once',
      'platform.reissue_admin_setup',
    ]);
    const dropped = [...ROLLBACK.matchAll(/^drop function (\S+)\(/gm)].map((m) => m[1]);
    expect([...dropped].sort()).toEqual([...created].sort());
    expect([...M0086.matchAll(/^create table (\S+) \(/gm)].map((m) => m[1])).toEqual([
      'platform.admin_invite_requests',
    ]);
    expect([...ROLLBACK.matchAll(/^drop table (\S+);/gm)].map((m) => m[1])).toEqual([
      'platform.admin_invite_requests',
    ]);
    expect([...M0086.matchAll(/^create trigger (\S+)\s/gm)].map((m) => m[1])).toEqual([
      'people_first_admin_recipient_fixed',
    ]);
    expect([...ROLLBACK.matchAll(/^drop trigger (\S+) on/gm)].map((m) => m[1])).toEqual([
      'people_first_admin_recipient_fixed',
    ]);
    const heads = splitStatements(ROLLBACK)
      .map((s) => squash(stripComments(s)))
      .filter((s) => s.length > 0);
    expect(heads.map((s) => s.split(' ').slice(0, 3).join(' '))).toEqual([
      'begin;',
      'set local lock_timeout',
      'do $$ begin',
      'drop trigger people_first_admin_recipient_fixed',
      'drop function platform.first_admin_recipient_fixed();',
      'drop function platform.reissue_admin_setup(uuid,',
      'drop function platform.invite_admin_once(text,',
      'drop table platform.admin_invite_requests;',
      'drop function platform.end_stale_admin_session(text);',
      'drop function platform.login_may_sign_in(uuid);',
      'drop function platform.list_admins();',
      'create or replace',
      'create or replace',
      'commit;',
    ]);
    expect(heads[2]).toContain('from drizzle.__drizzle_migrations) <> 86');
  });

  it('0086 replaces record_failure and current_admin; the rollback restores both exactly as 0083', () => {
    for (const name of ['platform.record_failure', 'platform.current_admin']) {
      expect(definition(ROLLBACK, name), name).toBe(definition(M0083, name));
      expect(definition(M0086, name), name).not.toBe(definition(M0083, name));
    }
    expect(definition(M0086, 'platform.current_admin')).toContain('app.platform_session_id');
    expect(definition(M0086, 'platform.record_failure')).toContain("'platform.admin.list'");
  });
});
