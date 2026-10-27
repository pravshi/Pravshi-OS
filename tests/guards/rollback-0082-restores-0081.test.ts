import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitStatements } from '../../scripts/migrate-ws.mjs';

/**
 * scripts/db/rollback/0082_least_privilege_cleanup.down.sql promises to restore the 0081
 * privileges. This pins that promise statically, as the other rollback guards do: every
 * privilege 0082 revokes, the rollback grants back, and it touches nothing else. (Executed
 * against a disposable database too: a rolled-back 0082 database matched a fresh 0081 database
 * on the privilege fingerprint.)
 */
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const M0082 = read('drizzle', '0082_least_privilege_cleanup.sql');
const ROLLBACK = read('scripts', 'db', 'rollback', '0082_least_privilege_cleanup.down.sql');

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripComments = (s: string) => s.replace(/--.*$/gm, '');
const statements = (sql: string) =>
  splitStatements(sql)
    .map((s) => squash(stripComments(s)))
    .filter((s) => s.length > 0);

describe('0082 does what its rollback undoes', () => {
  it('0082 only revokes, then verifies', () => {
    const heads = statements(M0082).map((s) => s.split(' ')[0]);
    expect(heads).toEqual(['revoke', 'revoke', 'revoke', 'do']);
  });

  it('the rollback grants back exactly what 0082 revokes, in one transaction', () => {
    const revoked = statements(M0082)
      .filter((s) => s.startsWith('revoke'))
      .map((s) =>
        s
          .replace(
            /^revoke all on function (\S+) from public;$/,
            'execute on function $1 to public',
          )
          .replace(/^revoke delete on (.+) from app_user;$/, 'delete on $1 to app_user'),
      );
    const granted = statements(ROLLBACK)
      .filter((s) => s.startsWith('grant'))
      .map((s) => s.replace(/^grant /, '').replace(/;$/, ''));
    expect(granted).toEqual(revoked);
    expect(statements(ROLLBACK).map((s) => s.split(' ')[0])).toEqual([
      'begin;',
      'set',
      'grant',
      'grant',
      'grant',
      'commit;',
    ]);
  });
});
