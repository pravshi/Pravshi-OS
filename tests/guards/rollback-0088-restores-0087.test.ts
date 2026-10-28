import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitStatements } from '../../scripts/migrate-ws.mjs';

/**
 * scripts/db/rollback/0088_crm_import_decisions.down.sql: refuses unless the database is at
 * 0088, and drops exactly the table and the function 0088 creates (the trigger and policies go
 * with the table).
 */
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const M0088 = read('drizzle', '0088_crm_import_decisions.sql');
const ROLLBACK = read('scripts', 'db', 'rollback', '0088_crm_import_decisions.down.sql');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripComments = (s: string) => s.replace(/--.*$/gm, '');

describe('0088 does what its rollback undoes', () => {
  it('creates two tables and their guards; the rollback drops exactly those', () => {
    expect([...M0088.matchAll(/^create table (\S+) \(/gm)].map((m) => m[1])).toEqual([
      'public.crm_import_decisions',
      'public.crm_import_row_plans',
    ]);
    expect([...M0088.matchAll(/^create function (\S+)\(/gm)].map((m) => m[1])).toEqual([
      'public.crm_import_decisions_guard',
      'public.crm_import_row_plans_guard',
    ]);
    expect(M0088).not.toMatch(/^alter table public\.crm_import(s|_rows) /m);
    expect(M0088).not.toMatch(/^create or replace/m);
    const heads = splitStatements(ROLLBACK)
      .map((s) => squash(stripComments(s)))
      .filter((s) => s.length > 0);
    expect(heads).toEqual([
      'begin;',
      "set local lock_timeout = '5s';",
      expect.stringContaining('from drizzle.__drizzle_migrations) <> 88'),
      'drop table public.crm_import_row_plans;',
      'drop function public.crm_import_row_plans_guard();',
      'drop table public.crm_import_decisions;',
      'drop function public.crm_import_decisions_guard();',
      'commit;',
    ]);
  });
});
