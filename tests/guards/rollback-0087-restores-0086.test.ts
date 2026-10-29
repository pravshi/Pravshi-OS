import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitStatements } from '../../scripts/migrate-ws.mjs';

/**
 * scripts/db/rollback/0087_org_admin_setup_email.down.sql: refuses unless the database is at
 * 0087, drops exactly the two functions 0087 adds, and restores record_failure verbatim from
 * 0086.
 */
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const M0087 = read('drizzle', '0087_org_admin_setup_email.sql');
const M0086 = read('drizzle', '0086_platform_console.sql');
const ROLLBACK = read('scripts', 'db', 'rollback', '0087_org_admin_setup_email.down.sql');
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

describe('0087 does what its rollback undoes', () => {
  it('every function 0087 creates, the rollback drops — and nothing else', () => {
    const created = [...M0087.matchAll(/^create function (\S+)\(/gm)].map((m) => m[1]);
    expect(created).toEqual([
      'platform.org_admin_setup_recipient',
      'platform.revoke_org_admin_setup',
    ]);
    const dropped = [...ROLLBACK.matchAll(/^drop function (\S+)\(/gm)].map((m) => m[1]);
    expect([...dropped].sort()).toEqual([...created].sort());
    expect(M0087).not.toMatch(/^(create|alter|drop) (table|trigger|index|policy)/m);
    const heads = splitStatements(ROLLBACK)
      .map((s) => squash(stripComments(s)))
      .filter((s) => s.length > 0);
    expect(heads.map((s) => s.split(' ').slice(0, 3).join(' '))).toEqual([
      'begin;',
      'set local lock_timeout',
      'do $$ begin',
      'drop function platform.revoke_org_admin_setup(uuid,',
      'drop function platform.org_admin_setup_recipient(uuid);',
      'create or replace',
      'commit;',
    ]);
    expect(heads[2]).toContain('from drizzle.__drizzle_migrations) <> 87');
  });

  it('0087 extends record_failure; the rollback restores it exactly as 0086 defined it', () => {
    expect(definition(ROLLBACK, 'platform.record_failure')).toBe(
      definition(M0086, 'platform.record_failure'),
    );
    expect(definition(M0087, 'platform.record_failure')).toContain(
      "'platform.organization.admin_setup_revoke'",
    );
    expect(definition(M0087, 'platform.record_failure')).not.toBe(
      definition(M0086, 'platform.record_failure'),
    );
  });
});
