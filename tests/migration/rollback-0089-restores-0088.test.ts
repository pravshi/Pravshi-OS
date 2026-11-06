import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitStatements } from '../../scripts/migrate-ws.mjs';

/**
 * scripts/db/rollback/0089_crm_leads_and_lineage.down.sql: refuses unless the database is at
 * exactly this revision of 0089 with complete, consistent history metadata, and drops exactly the
 * tables, functions and permissions 0089 creates, and reverts its alters. The data-level rehearsal
 * (refusals with real rows, schema identical to 0088 afterwards) is recorded in the PR report.
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
  'public.crm_statement_identity',
];

const FUNCTIONS = [
  'public.guard_crm_lead_assignment_history',
  'public.guard_crm_lead_attribution',
  'public.guard_crm_lead_server_fields',
  'public.guard_crm_lead_owner_change',
  'public.crm_stamp_actor',
  'public.guard_crm_dedup_candidate_identity',
  'public.crm_capture_statement_identity',
  'public.crm_assert_statement_identity',
  'public.crm_record_lead_assignment',
  'public.crm_lead_in_scope',
  'public.crm_attribution_policy',
  'public.set_lead_attribution_policy',
  'public.crm_decide_lead_attribution_correction',
  'public.apply_lead_attribution_correction',
  'public.reject_lead_attribution_correction',
];

const PERMISSIONS = [
  'leads.attribution.request',
  'leads.attribution.approve',
  'leads.attribution.single_manager',
];

const JOURNAL = JSON.parse(read('drizzle', 'meta', '_journal.json')) as {
  entries: Array<{ idx: number; tag: string; when: number; hash: string }>;
};

const statements = splitStatements(ROLLBACK)
  .map((s: string) => squash(stripComments(s)))
  .filter((s: string) => s.length > 0);

describe('0089 does what its rollback undoes', () => {
  it('refuses missing, empty or inconsistent history metadata, any other revision, and data it would lose', () => {
    const e0089 = JOURNAL.entries.find((e) => e.tag === '0089_crm_leads_and_lineage')!;
    const guard = statements[2]!;
    expect(guard).toMatch(/^do \$\$/);
    // Every comparison is NULL-safe: a NULL must never let a check pass.
    expect(guard).not.toMatch(/\s<>\s/);
    expect(guard).toContain('v_count is distinct from 89');
    expect(guard).toContain("hash is null or btrim(hash) = '' or created_at is null");
    expect(guard).toContain('v_incomplete is distinct from 0');
    expect(guard).toContain('v_max - v_min + 1 is distinct from v_count');
    // The rollback names the checksum and timing of the 0089 it undoes; they must be the journal's.
    expect(guard).toContain(`v_last_hash is distinct from '${e0089.hash}'`);
    expect(guard).toContain(`v_last_created_at is distinct from ${e0089.when}`);
    expect(guard).toContain(`where created_at >= ${e0089.when}`);
    expect(guard).toContain('v_at_or_after is distinct from 1');
    expect(guard).toContain("where entity_type = 'lead'");
    expect(guard).toContain('where merged_into_contact_id is not null');
  });

  it('drops exactly the tables and functions 0089 creates, without CASCADE, tables first', () => {
    expect([...M0089.matchAll(/^create table (\S+) \(/gm)].map((m) => m[1])).toEqual(TABLES);
    expect([...M0089.matchAll(/^create or replace function (\S+)\(/gm)].map((m) => m[1])).toEqual(
      FUNCTIONS,
    );

    expect(statements[0]).toBe('begin;');
    expect(statements[1]).toBe("set local lock_timeout = '5s';");
    expect(statements[statements.length - 1]).toBe('commit;');

    const droppedTables = statements
      .map((s) => s.match(/^drop table if exists (\S+);$/)?.[1])
      .filter(Boolean);
    expect([...droppedTables].sort()).toEqual([...TABLES].sort());
    expect(statements.filter((s) => /\bcascade\b/i.test(s))).toEqual([]);

    const droppedFunctions = statements
      .map((s) => s.match(/^drop function if exists (\S+)\(/)?.[1])
      .filter(Boolean);
    expect([...droppedFunctions].sort()).toEqual([...FUNCTIONS].sort());

    // Policies and triggers refer to the functions, so every table goes before any function.
    const lastTable = Math.max(
      ...TABLES.map((t) => statements.indexOf(`drop table if exists ${t};`)),
    );
    const firstFunction = statements.findIndex((s) => s.startsWith('drop function if exists'));
    expect(lastTable).toBeLessThan(firstFunction);
  });

  it('removes the three attribution permissions and every grant of them', () => {
    for (const key of PERMISSIONS) {
      expect(M0089).toContain(`'${key}'`);
      expect(ROLLBACK).toContain(`'${key}'`);
    }
    const grants = statements.findIndex((s) => s.startsWith('delete from public.role_permissions'));
    const catalogue = statements.findIndex((s) => s.startsWith('delete from public.permissions'));
    expect(grants).toBeGreaterThan(-1);
    expect(catalogue).toBeGreaterThan(grants);
  });
});
