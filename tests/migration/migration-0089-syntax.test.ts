import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (...p: string[]) =>
  readFileSync(join(process.cwd(), 'packages', 'database', ...p), 'utf8');
const M0089 = read('drizzle', '0089_crm_leads_and_lineage.sql');

describe('PR-P1-01: Migration 0089 Structure & Constraint Invariant Suite', () => {
  it('creates the 6 shared CRM tables (plus the identity pin and the policy ledger), and no product table', () => {
    const createdTables = [...M0089.matchAll(/^create table (\S+) \(/gm)].map((m) => m[1]);
    expect(createdTables).toEqual([
      'public.crm_leads',
      'public.crm_lead_assignment_history',
      'public.crm_assignment_cursors',
      'public.crm_lead_tasks',
      'public.crm_dedup_candidates',
      'public.crm_lead_attribution_corrections',
      'public.crm_statement_identity',
      'public.crm_attribution_policy_changes',
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
    // Plain ADD COLUMN / CREATE INDEX on existing tables: drift must fail, not be adopted.
    expect(M0089).toContain('add column merged_into_contact_id uuid');
    expect(M0089).toContain('add column logged_at timestamptz');
    expect(M0089).not.toMatch(/add column if not exists|create index if not exists/);
    expect(M0089).toContain("check (entity_type in ('company', 'contact', 'deal', 'lead'))");
  });

  it('backfills activities.logged_at without touching updated_at, updated_by or the audit log', () => {
    // The backfill would otherwise fire set_updated_at() and stamp_crm_actor() on every existing
    // row, replacing each row's real last-edit time and editor. The data-level proof is the
    // upgrade rehearsal (0088 with activities -> 0089); this pins the shape.
    const backfill = M0089.match(
      /alter table public\.activities\s+disable trigger[\s\S]*?update public\.activities\s+set logged_at = created_at\s+where logged_at is null;\s+alter table public\.activities\s+enable trigger[\s\S]*?;/,
    );
    expect(backfill).not.toBeNull();
    const block = backfill![0];
    for (const t of [
      'activities_set_updated_at',
      'activities_stamp_actor',
      'activities_audit',
      'activities_link_immutable',
      'activities_enforce_owner_change',
    ]) {
      expect(block, t).toContain(`disable trigger ${t}`);
      expect(block, t).toContain(`enable trigger ${t}`);
    }
    // Exactly one UPDATE of activities in the whole migration, and it is inside that block.
    expect(M0089.match(/update public\.activities/g)).toHaveLength(1);
  });

  it('tells callers apart correctly in every guard', () => {
    // A guard that uses current_user must run with invoker rights: in a SECURITY DEFINER function
    // current_user is the owner (app_owner), so such a guard never fires. A definer guard, and the
    // actor stamp, recognise the owner plane by session_user (the login, which neither a definer
    // nor app_user can change) — never by an empty identity, which a statement could produce
    // itself. The behaviour is proven against the database in crm-leads-integrity.test.ts.
    const fn = (name: string) => {
      const m = M0089.match(
        new RegExp(`create or replace function public\\.${name}\\(\\)[\\s\\S]*?\\$\\$;`),
      );
      expect(m, name).not.toBeNull();
      return m![0];
    };
    for (const name of [
      'guard_crm_lead_attribution',
      'guard_crm_lead_server_fields',
      'crm_stamp_actor',
      'guard_crm_dedup_candidate_identity',
    ]) {
      expect(fn(name), name).toContain('security invoker');
      expect(fn(name), name).not.toContain('security definer');
    }
    expect(fn('guard_crm_lead_attribution')).toContain("and current_user <> 'app_owner' then");
    expect(fn('guard_crm_lead_server_fields')).toContain("if current_user = 'app_owner' then");
    expect(fn('crm_stamp_actor')).toContain("if session_user = 'app_owner' then");
    expect(fn('guard_crm_dedup_candidate_identity')).toContain("if session_user <> 'app_owner'");
    // No guard grants an exemption because the identity is empty.
    for (const name of [
      'guard_crm_lead_attribution',
      'guard_crm_lead_server_fields',
      'guard_crm_lead_owner_change',
      'crm_stamp_actor',
      'guard_crm_dedup_candidate_identity',
    ]) {
      expect(fn(name), name).not.toContain("current_setting('app.person_id', true), '') is");
    }

    // The owner guard needs authz.crm_owner_reachable (not executable by app_user, 0033), so it
    // is a definer — and therefore must not mention current_user at all.
    const owner = fn('guard_crm_lead_owner_change');
    expect(owner).toContain('security definer');
    expect(owner).not.toContain('current_user');
    expect(owner).toContain("if session_user = 'app_owner' then");
    expect(owner).toContain("authz.crm_owner_reachable('leads.assign', new.owner_person_id)");
    expect(owner).toContain("if tg_op = 'INSERT' then");
    expect(M0089).toMatch(
      /create trigger crm_leads_owner_guard\s+before insert or update on public\.crm_leads/,
    );

    for (const t of [
      'crm_leads_attribution_guard',
      'crm_leads_owner_guard',
      'crm_leads_actor_stamp',
      'crm_lead_tasks_actor_stamp',
      'crm_dedup_candidates_identity_guard',
      'crm_leads_server_fields_guard',
      'crm_leads_assignment_ledger_insert',
      'crm_leads_assignment_ledger_update',
    ]) {
      expect(M0089).toContain(`create trigger ${t}`);
    }
  });

  it('pins the caller identity for every statement on every new CRM table', () => {
    for (const t of [
      'crm_leads',
      'crm_lead_assignment_history',
      'crm_assignment_cursors',
      'crm_lead_tasks',
      'crm_dedup_candidates',
      'crm_lead_attribution_corrections',
      'crm_attribution_policy_changes',
    ]) {
      expect(M0089, t).toContain(
        `create trigger ${t}_identity_capture\n  before insert or update or delete on public.${t}\n  for each statement execute function public.crm_capture_statement_identity();`,
      );
      expect(M0089, t).toContain(
        `create trigger ${t}_identity_pin\n  before insert or update or delete on public.${t}\n  for each row execute function public.crm_assert_statement_identity();`,
      );
      // Also after each row, so a change made in RETURNING never reaches an AFTER trigger.
      expect(M0089, t).toContain(
        `create trigger ${t}_identity_pin_after\n  after insert or update or delete on public.${t}\n  for each row execute function public.crm_assert_statement_identity();`,
      );
    }
    // The capture refuses to replace an identity already recorded for the transaction.
    expect(M0089).toContain("raise exception 'The caller identity changed within the transaction'");
    expect(M0089).toMatch(
      /revoke all on public\.crm_statement_identity\s+from public, app_user, app_admin, app_worker, app_auth, app_platform;/,
    );
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
    expect(M0089).toContain(
      "or (status <> 'PENDING' and reviewed_by_person_id = (select authz.person_id()))",
    );
    // The assignment ledger is written by the database from the persisted row; app_user has no
    // INSERT policy and no INSERT privilege on it.
    expect(M0089).not.toMatch(
      /create policy \w+ on public\.crm_lead_assignment_history\s+for insert/,
    );
    expect(M0089).toContain("case when tg_op = 'UPDATE' then old.owner_person_id end");
  });

  it('uses the dedicated attribution permissions and allows only TWO_PERSON or SINGLE_MANAGER', () => {
    for (const [key, action] of [
      ['leads.attribution.request', 'request'],
      ['leads.attribution.approve', 'approve'],
      ['leads.attribution.single_manager', 'single_manager'],
    ]) {
      expect(M0089).toContain(`('${key}', 'leads.attribution', '${action}', 'sales',`);
    }
    expect(M0089).toContain(
      "('settings.manage_attribution_policy', 'settings', 'manage_attribution_policy', 'settings',",
    );
    expect(M0089).toContain("(select authz.has('leads.attribution.request'))");
    expect(M0089).toContain("if not authz.has('leads.attribution.approve') then");
    expect(M0089).toContain(
      "if p_policy is null or p_policy not in ('TWO_PERSON', 'SINGLE_MANAGER') then",
    );
    // F-SEC-13: the policy belongs to its own permission (SUPER_ADMIN, not ADMIN) with step-up MFA,
    // never to the broad settings.manage.
    // F-SEC-22: at GLOBAL scope only.
    expect(M0089).toContain(
      "if authz.scope_for('settings.manage_attribution_policy') is distinct from 'GLOBAL' then",
    );
    expect(M0089).not.toContain("authz.has('settings.manage')");
    // F-SEC-19: step-up MFA is the caller's own aal2 session minted within 5 minutes, bound by its
    // token SHA-256 — for every policy step, every correction approval and every exception use.
    expect(M0089).toContain("and s.created_at > now() - interval '5 minutes'");
    expect(M0089).toContain(
      "and encode(sha256(convert_to(s.token, 'UTF8')), 'hex') = p_session_token_sha256",
    );
    expect(M0089).toContain('perform public.crm_assert_recent_mfa(p_session_token_sha256);');
    expect(M0089).toContain('v_login := public.crm_assert_recent_mfa(p_session_token_sha256);');
    // F-SEC-23: the organization row serialises policy steps and correction decisions.
    expect(M0089).toContain(
      'perform 1 from public.organizations where id = v_org for no key update;',
    );
    expect(M0089).toContain('perform 1 from public.organizations where id = v_org for share;');
    // F-SEC-20: 7-day expiry, and a correction request's time is always the database's.
    expect(M0089.match(/interval '7 days'/g)!.length).toBeGreaterThanOrEqual(3);
    expect(M0089).toMatch(
      /create trigger crm_lead_attribution_corrections_request_time\s+before insert on public\.crm_lead_attribution_corrections/,
    );
    // F-SEC-12: SUPER_ADMIN is never given the exception, at migration time or for a new org.
    expect(M0089).toContain(
      "and p.key not in ('users.impersonate', 'leads.attribution.single_manager')",
    );
    expect(M0089).toContain(
      "and (requested_policy = 'TWO_PERSON' or decided_by_person_id <> requested_by_person_id))",
    );
    expect(M0089).toContain("p_action := 'crm_lead.attribution_single_manager_exception_used'");
    expect(M0089).toContain("p_action := 'crm_lead.attribution_correction_rejected'");
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
      // section 9f, created with its functions
      'public.crm_statement_identity',
      // section 9j, the attribution policy ledger
      'public.crm_attribution_policy_changes',
      // section 10
      'public.crm_leads',
      'public.crm_lead_assignment_history',
      'public.crm_assignment_cursors',
      'public.crm_lead_tasks',
      'public.crm_dedup_candidates',
      'public.crm_lead_attribution_corrections',
    ]);

    // Every new CRM table carries the row audit trigger (the operational identity pin does not).
    expect([...M0089.matchAll(/^create trigger (\w+_audit)$/gm)].map((m) => m[1])).toEqual([
      'crm_attribution_policy_changes_audit',
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
      'revoke insert, update, delete on public.crm_lead_assignment_history from app_user;',
    );
    expect(M0089).toContain('from app_admin, app_worker, app_auth, app_platform;');
  });
});
