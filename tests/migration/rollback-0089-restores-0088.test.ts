import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitStatements } from '../../scripts/migrate-ws.mjs';

/**
 * scripts/db/rollback/0089_crm_leads_and_lineage.down.sql: refuses unless the database is at
 * 0089 and drops exactly the 6 tables and the functions 0089 creates, and reverts its alters.
 */
const read = (...p: string[]) =>
  readFileSync(join(process.cwd(), 'packages', 'database', ...p), 'utf8');
const M0089 = read('drizzle', '0089_crm_leads_and_lineage.sql');
const ROLLBACK = read('scripts', 'db', 'rollback', '0089_crm_leads_and_lineage.down.sql');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripComments = (s: string) => s.replace(/--.*$/gm, '');

const TABLES = [
  'public.crm_leads',
  'public.crm_lead_assignment_history',
  'public.crm_assignment_cursors',
  'public.crm_lead_tasks',
  'public.crm_dedup_candidates',
  'public.crm_lead_attribution_corrections',
];

const FUNCTIONS = [
  'public.guard_crm_lead_assignment_history',
  'public.guard_crm_lead_attribution',
  'public.guard_crm_lead_owner_change',
  'public.crm_stamp_actor',
  'public.crm_lead_in_edit_scope',
  'public.apply_lead_attribution_correction',
];

describe('0089 does what its rollback undoes', () => {
  it('creates 6 tables and 6 functions; the rollback drops exactly those', () => {
    expect([...M0089.matchAll(/^create table (\S+) \(/gm)].map((m) => m[1])).toEqual(TABLES);
    expect([...M0089.matchAll(/^create or replace function (\S+)\(/gm)].map((m) => m[1])).toEqual(
      FUNCTIONS,
    );

    const statements = splitStatements(ROLLBACK)
      .map((s) => squash(stripComments(s)))
      .filter((s) => s.length > 0);

    expect(statements[0]).toBe('begin;');
    expect(statements[1]).toBe("set local lock_timeout = '5s';");
    expect(statements[2]).toContain('from drizzle.__drizzle_migrations) <> 89');
    expect(statements[statements.length - 1]).toBe('commit;');

    const droppedTables = statements
      .map((s) => s.match(/^drop table if exists (\S+) cascade;$/)?.[1])
      .filter(Boolean);
    expect([...droppedTables].sort()).toEqual([...TABLES].sort());

    const droppedFunctions = statements
      .map((s) => s.match(/^drop function if exists (\S+)\(/)?.[1])
      .filter(Boolean);
    expect([...droppedFunctions].sort()).toEqual([...FUNCTIONS].sort());

    // The scope helper is referenced by a policy on crm_lead_attribution_corrections, so it can
    // only be dropped after that table.
    const at = (needle: string) => statements.findIndex((s) => s.includes(needle));
    expect(at('drop function if exists public.crm_lead_in_edit_scope')).toBeGreaterThan(
      at('drop table if exists public.crm_lead_attribution_corrections'),
    );
  });
});
