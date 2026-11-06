import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (...p: string[]) =>
  readFileSync(join(process.cwd(), 'packages', 'database', ...p), 'utf8');
const M0089 = read('drizzle', '0089_crm_leads_and_lineage.sql');

describe('PR-P1-01: Migration 0089 Structure & Constraint Invariant Suite', () => {
  it('creates the 6 shared CRM tables with composite organization constraints, and no product table', () => {
    const createdTables = [...M0089.matchAll(/^create table (\S+) \(/gm)].map((m) => m[1]);
    expect(createdTables).toEqual([
      'public.crm_leads',
      'public.crm_lead_assignment_history',
      'public.crm_assignment_cursors',
      'public.crm_lead_tasks',
      'public.crm_dedup_candidates',
      'public.crm_lead_attribution_corrections',
    ]);
    // Founder decision AD-6: the Real Estate extension belongs to the Real Estate stage.
    expect(M0089).not.toMatch(/create table public\.re_/);

    // Verify composite unique (id, org_id) constraints on all applicable tables
    expect(M0089).toContain('constraint crm_leads_id_org_unique unique (id, org_id)');
    expect(M0089).toContain('constraint crm_lead_assign_hist_id_org_unique unique (id, org_id)');
    expect(M0089).toContain('constraint crm_assignment_cursors_id_org_unique unique (id, org_id)');
    expect(M0089).toContain('constraint crm_lead_tasks_id_org_unique unique (id, org_id)');
    expect(M0089).toContain('constraint crm_dedup_candidates_id_org_unique unique (id, org_id)');
    expect(M0089).toContain('constraint crm_lead_attr_corr_id_org_unique unique (id, org_id)');

    // Actor columns: no single-column reference to people (it could name another org's person).
    expect(M0089).not.toMatch(/(created_by|updated_by) uuid references public\.people \(id\)/);
    for (const c of [
      'crm_leads_created_by_same_org',
      'crm_leads_updated_by_same_org',
      'crm_lead_tasks_created_by_same_org',
      'crm_lead_tasks_updated_by_same_org',
    ]) {
      expect(M0089).toContain(`add constraint ${c}`);
    }
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

  it('implements the attribution and owner guards as SECURITY INVOKER triggers', () => {
    // A SECURITY DEFINER trigger sees current_user = its owner (app_owner), so a definer guard
    // testing current_user never fires. The behaviour is proven against the database in
    // tests/tenant-isolation/crm-leads-integrity.test.ts; this pins the text.
    const fn = (name: string) => {
      const m = M0089.match(
        new RegExp(`create or replace function public\\.${name}\\(\\)[\\s\\S]*?\\$\\$;`),
      );
      expect(m, name).not.toBeNull();
      return m![0];
    };
    for (const name of [
      'guard_crm_lead_attribution',
      'guard_crm_lead_owner_change',
      'crm_stamp_actor',
    ]) {
      expect(fn(name), name).toContain('security invoker');
      expect(fn(name), name).not.toContain('security definer');
    }
    expect(fn('guard_crm_lead_attribution')).toContain("and current_user <> 'app_owner' then");
    expect(M0089).toContain('create trigger crm_leads_attribution_guard');
    expect(M0089).toContain('create trigger crm_leads_owner_guard');
    expect(M0089).toContain('create trigger crm_leads_actor_stamp');
    expect(M0089).toContain('create trigger crm_lead_tasks_actor_stamp');
  });

  it('never queries crm_leads from a crm_leads policy (Postgres rejects it with 42P17)', () => {
    const leadPolicies = [
      ...M0089.matchAll(/create policy (crm_leads_\w+) on public\.crm_leads\b[\s\S]*?\);\n/g),
    ];
    expect(leadPolicies.map((m) => m[1])).toEqual([
      'crm_leads_owner_all',
      'crm_leads_select',
      'crm_leads_insert',
      'crm_leads_update',
    ]);
    for (const m of leadPolicies) expect(m[0], m[1]).not.toMatch(/from public\.crm_leads/);
  });

  it('binds every caller-supplied principal column to authz.person_id()', () => {
    expect(M0089).toContain('and requested_by_person_id = (select authz.person_id())');
    expect(M0089).toContain('and reassigned_by_person_id = (select authz.person_id())');
    expect(M0089).toContain('or reviewed_by_person_id = (select authz.person_id())');
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
    ]);

    // Every new table carries the row audit trigger.
    expect([...M0089.matchAll(/^create trigger (\w+_audit)$/gm)].map((m) => m[1])).toEqual([
      'crm_leads_audit',
      'crm_lead_assignment_history_audit',
      'crm_assignment_cursors_audit',
      'crm_lead_tasks_audit',
      'crm_dedup_candidates_audit',
      'crm_lead_attribution_corrections_audit',
    ]);

    // Verify Unassigned Pond scoping in crm_leads policy
    expect(M0089).toContain("case (select authz.scope_for('leads.view'))");
    expect(M0089).toContain("when 'GLOBAL' then true");
    expect(M0089).toContain("when 'DEPARTMENT' then (");
    expect(M0089).toContain("when 'SELF' then owner_person_id = (select authz.person_id())");
    expect(M0089).toContain('(select authz.in_my_departments(owner_person_id))');
    expect(M0089).toContain('(select authz.reports_to_me(owner_person_id))');
    expect(M0089).not.toContain('authz.in_my_department(');
    expect(M0089).not.toContain('authz.is_my_report(');
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
