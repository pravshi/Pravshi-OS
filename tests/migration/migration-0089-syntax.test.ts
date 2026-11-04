import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (...p: string[]) =>
  readFileSync(join(process.cwd(), 'packages', 'database', ...p), 'utf8');
const M0089 = read('drizzle', '0089_crm_leads_and_lineage.sql');

describe('PR-P1-01: Migration 0089 Structure & Constraint Invariant Suite', () => {
  it('creates all 7 canonical P1 tables with composite organization constraints', () => {
    const createdTables = [...M0089.matchAll(/^create table (\S+) \(/gm)].map((m) => m[1]);
    expect(createdTables).toEqual([
      'public.crm_leads',
      'public.crm_lead_assignment_history',
      'public.crm_assignment_cursors',
      'public.crm_lead_tasks',
      'public.crm_dedup_candidates',
      'public.crm_lead_attribution_corrections',
      'public.re_lead_preferences',
    ]);

    // Verify composite unique (id, org_id) constraints on all applicable tables
    expect(M0089).toContain('constraint crm_leads_id_org_unique unique (id, org_id)');
    expect(M0089).toContain('constraint crm_lead_assign_hist_id_org_unique unique (id, org_id)');
    expect(M0089).toContain('constraint crm_assignment_cursors_id_org_unique unique (id, org_id)');
    expect(M0089).toContain('constraint crm_lead_tasks_id_org_unique unique (id, org_id)');
    expect(M0089).toContain('constraint crm_dedup_candidates_id_org_unique unique (id, org_id)');
    expect(M0089).toContain('constraint crm_lead_attr_corr_id_org_unique unique (id, org_id)');
    expect(M0089).toContain('constraint re_lead_pref_id_org_unique unique (id, org_id)');
  });

  it('enforces task polymorphic XOR constraint in DDL', () => {
    expect(M0089).toContain('constraint crm_lead_tasks_target_xor check');
    expect(M0089).toMatch(
      /\(lead_id is not null and contact_id is null\)\s*or\s*\(lead_id is null and contact_id is not null\)/,
    );
  });

  it('enforces E.164 phone regex check on crm_leads', () => {
    expect(M0089).toContain("primary_phone ~ '^\\+[1-9]\\d{1,14}$'");
  });

  it('alters contacts and activities with backfilled timestamps and foreign keys', () => {
    expect(M0089).toContain('add column if not exists merged_into_contact_id uuid');
    expect(M0089).toContain('add column if not exists logged_at timestamptz');
    expect(M0089).toMatch(
      /update public\.activities\s+set logged_at = created_at\s+where logged_at is null;/,
    );
    expect(M0089).toContain("check (entity_type in ('company', 'contact', 'deal', 'lead'))");
  });

  it('implements attribution trigger defense asserting CURRENT_USER = app_owner', () => {
    expect(M0089).toContain('create or replace function public.guard_crm_lead_attribution()');
    expect(M0089).toContain("if current_user <> 'app_owner' then");
    expect(M0089).toContain('create trigger crm_leads_attribution_guard');
  });

  it('implements security definer attribution mutator with empty search_path and in-transaction audit log', () => {
    expect(M0089).toContain('create or replace function public.apply_lead_attribution_correction(');
    expect(M0089).toContain('security definer');
    expect(M0089).toContain("set search_path = ''");
    expect(M0089).toContain('perform public.write_audit_log(');
  });

  it('forces row level security and defines owner and scoped policies on all new tables', () => {
    const forcedTables = [...M0089.matchAll(/alter table (\S+) force row level security;/g)].map(
      (m) => m[1],
    );
    expect(forcedTables).toEqual([
      'public.crm_leads',
      'public.crm_lead_assignment_history',
      'public.crm_assignment_cursors',
      'public.crm_lead_tasks',
      'public.crm_dedup_candidates',
      'public.crm_lead_attribution_corrections',
      'public.re_lead_preferences',
    ]);

    // Verify Unassigned Pond scoping in crm_leads policy
    expect(M0089).toContain("case (select authz.scope_for('leads.view'))");
    expect(M0089).toContain("when 'GLOBAL' then true");
    expect(M0089).toContain("when 'DEPARTMENT' then (");
    expect(M0089).toContain("when 'SELF' then owner_person_id = (select authz.person_id())");
  });

  it('revokes unpermitted table operations from app_user and runtime roles', () => {
    expect(M0089).toContain('revoke delete on public.crm_leads from app_user;');
    expect(M0089).toContain('revoke delete on public.crm_lead_tasks from app_user;');
    expect(M0089).toContain('revoke delete on public.crm_assignment_cursors from app_user;');
    expect(M0089).toContain(
      'revoke update, delete on public.crm_lead_attribution_corrections from app_user;',
    );
    expect(M0089).toContain(
      'revoke update, delete on public.crm_lead_assignment_history from app_user;',
    );
    expect(M0089).toContain('from app_admin, app_worker, app_auth, app_platform;');
  });
});
