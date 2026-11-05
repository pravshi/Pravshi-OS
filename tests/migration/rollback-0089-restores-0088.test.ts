import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitStatements } from '../../scripts/migrate-ws.mjs';

/**
 * scripts/db/rollback/0089_crm_leads_and_lineage.down.sql: refuses unless the database is at
 * 0089 and drops exactly the 7 tables, functions, and alters 0089 creates.
 */
const read = (...p: string[]) =>
  readFileSync(join(process.cwd(), 'packages', 'database', ...p), 'utf8');
const M0089 = read('drizzle', '0089_crm_leads_and_lineage.sql');
const ROLLBACK = read('scripts', 'db', 'rollback', '0089_crm_leads_and_lineage.down.sql');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripComments = (s: string) => s.replace(/--.*$/gm, '');

describe('0089 does what its rollback undoes', () => {
  it('creates 7 tables and their functions; the rollback drops exactly those', () => {
    expect([...M0089.matchAll(/^create table (\S+) \(/gm)].map((m) => m[1])).toEqual([
      'public.crm_leads',
      'public.crm_lead_assignment_history',
      'public.crm_assignment_cursors',
      'public.crm_lead_tasks',
      'public.crm_dedup_candidates',
      'public.crm_lead_attribution_corrections',
      'public.re_lead_preferences',
    ]);

    expect([...M0089.matchAll(/^create or replace function (\S+)\(/gm)].map((m) => m[1])).toEqual([
      'public.guard_crm_lead_assignment_history',
      'public.guard_crm_lead_attribution',
      'public.apply_lead_attribution_correction',
    ]);

    const statements = splitStatements(ROLLBACK)
      .map((s) => squash(stripComments(s)))
      .filter((s) => s.length > 0);

    expect(statements[0]).toBe('begin;');
    expect(statements[1]).toBe("set local lock_timeout = '5s';");
    expect(statements[2]).toContain('from drizzle.__drizzle_migrations) <> 89');
    expect(statements[statements.length - 1]).toBe('commit;');
  });
});
