import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitStatements } from '../../scripts/migrate-ws.mjs';

/**
 * scripts/db/rollback/0084_platform_provisioning.down.sql promises to restore the 0083 state.
 * Pinned statically: it locks, refuses before changing anything unless the database is exactly
 * at 0084 and nothing was provisioned or suspended through the platform, and removes exactly
 * the functions, tables, constraints and columns 0084 adds. (Executed against disposable
 * databases too: see the commit.)
 */
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const M0084 = read('drizzle', '0084_platform_provisioning.sql');
const ROLLBACK = read('scripts', 'db', 'rollback', '0084_platform_provisioning.down.sql');

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripComments = (s: string) => s.replace(/--.*$/gm, '');
const statements = (sql: string) =>
  splitStatements(sql)
    .map((s) => squash(stripComments(s)))
    .filter((s) => s.length > 0);

describe('0084 does what its rollback undoes', () => {
  it('every function 0084 creates is dropped, and nothing else', () => {
    const created = [...M0084.matchAll(/^create function (platform\.[a-z_]+)\(/gm)]
      .map((m) => m[1])
      .sort();
    const dropped = [...ROLLBACK.matchAll(/^drop function (platform\.[a-z_]+)\(/gm)]
      .map((m) => m[1])
      .sort();
    expect(dropped).toEqual(created);
    expect(created).toHaveLength(7);
  });

  it('every table and column 0084 adds is dropped', () => {
    const tables = [...M0084.matchAll(/^create table (platform\.[a-z_]+) \(/gm)]
      .map((m) => m[1])
      .sort();
    const droppedTables = [...ROLLBACK.matchAll(/^drop table (platform\.[a-z_]+);/gm)]
      .map((m) => m[1])
      .sort();
    expect(droppedTables).toEqual(tables);
    for (const col of ['suspended_at', 'suspended_by', 'suspension_reason']) {
      expect(M0084).toMatch(new RegExp(`add column ${col} `));
      expect(ROLLBACK).toMatch(new RegExp(`drop column ${col}[,;]`));
    }
    for (const c of [
      'organizations_suspension_only_when_suspended',
      'organizations_suspension_reason_valid',
    ]) {
      expect(M0084).toMatch(new RegExp(`add constraint ${c}`));
      expect(ROLLBACK).toMatch(new RegExp(`drop constraint ${c}`));
    }
  });

  it('the rollback runs in one transaction, locks, and refuses before changing anything', () => {
    const s = statements(ROLLBACK);
    expect(s[0]).toBe('begin;');
    expect(s.at(-1)).toBe('commit;');
    const lock = s.findIndex((x) => x.startsWith('lock table platform.provisioning_requests'));
    const refusal = s.findIndex((x) => x.includes('0084 rollback refused'));
    const firstChange = s.findIndex((x) => /^(drop|alter|create)/.test(x));
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(refusal);
    expect(refusal).toBeLessThan(firstChange);
    expect(s[refusal]).toContain('from drizzle.__drizzle_migrations) <> 84');
  });
});
