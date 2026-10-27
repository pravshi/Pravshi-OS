import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitStatements } from '../../scripts/migrate-ws.mjs';

/**
 * scripts/db/rollback/0086_platform_console.down.sql: refuses unless the database is at 0086,
 * and drops exactly the one function 0086 adds.
 */
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const M0086 = read('drizzle', '0086_platform_console.sql');
const ROLLBACK = read('scripts', 'db', 'rollback', '0086_platform_console.down.sql');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripComments = (s: string) => s.replace(/--.*$/gm, '');

describe('0086 does what its rollback undoes', () => {
  it('0086 creates exactly platform.list_admins(); the rollback drops exactly that', () => {
    expect([...M0086.matchAll(/^create function (\S+)\(/gm)].map((m) => m[1])).toEqual([
      'platform.list_admins',
    ]);
    const heads = splitStatements(ROLLBACK)
      .map((s) => squash(stripComments(s)))
      .filter((s) => s.length > 0);
    expect(heads.map((s) => s.split(' ').slice(0, 3).join(' '))).toEqual([
      'begin;',
      'set local lock_timeout',
      'do $$ begin',
      'drop function platform.list_admins();',
      'commit;',
    ]);
    expect(heads[2]).toContain('from drizzle.__drizzle_migrations) <> 86');
  });
});
