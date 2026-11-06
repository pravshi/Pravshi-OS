-- ————————————————————————————————————————————————————————————————————————————
-- 0089_crm_leads_and_lineage — Phase 1 Core CRM Lineage & Foundations
-- ————————————————————————————————————————————————————————————————————————————
--
-- Implements Phase 1 (Core CRM Lineage) foundational database architecture:
--   - public.crm_leads (inbound prospect lifecycle, dual SLA timestamps, immutable attribution)
--   - public.crm_lead_assignment_history (immutable append-only audit trail)
--   - public.crm_assignment_cursors (deterministic round-robin assignment routing state)
--   - public.crm_lead_tasks (follow-up worklist with polymorphic XOR target constraint)
--   - public.crm_dedup_candidates (duplicate entity pairs awaiting human resolution)
--   - public.crm_lead_attribution_corrections (governed two-person correction requests)
--   - public.contacts alteration (multi-hop merge pointers and lineage)
--   - public.activities alteration (logged_at timestamp backfill; polymorphic 'lead' support)
--   - Attribution trigger defense (guard_crm_lead_attribution against table-level roles.sql re-grant)
--   - Owner-change guard, actor stamping and the lead edit-scope helper
--   - Privileged attribution mutator procedure (apply_lead_attribution_correction)
--   - Row audit triggers on every new table
--
-- Shared CRM only: the Real Estate extension table (re_lead_preferences) is NOT here. It belongs
-- to the first Real Estate migration, under that stage's ADR (founder decision AD-6, 2026-11-06).
--
-- Conforms to ADR-006, ADR-007, ADR-008 and P1 Specification Freeze.
-- ————————————————————————————————————————————————————————————————————————————

set local lock_timeout = '5s';

-- 1. Table: public.crm_leads
create table public.crm_leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),

  full_name text not null,
  primary_phone text not null,
  email citext,

  source text not null,
  source_subcategory text,
  campaign_id text,

  owner_person_id uuid,
  team_id uuid,

  stage text not null default 'new',
  sla_due_at timestamptz not null,
  first_contacted_at timestamptz,
  first_successful_contact_at timestamptz,
  escalated_at timestamptz,

  import_batch_id uuid,
  import_row_number integer,

  converted_contact_id uuid,
  converted_at timestamptz,

  merged_into_lead_id uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Stamped from the transaction identity by crm_stamp_actor() (section 10); never trusted
  -- from input. Composite foreign keys below keep them inside the row's organization.
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  constraint crm_leads_id_org_unique unique (id, org_id),
  constraint crm_leads_full_name_not_blank check (length(btrim(full_name)) > 0),
  constraint crm_leads_primary_phone_e164 check (primary_phone ~ '^\+[1-9]\d{1,14}$'),
  constraint crm_leads_source_check check (
    source in (
      'website', 'webhook', 'whatsapp', 'portal_99acres', 'portal_housing',
      'portal_magicbricks', 'referral', 'walk_in', 'campaign', 'manual'
    )
  ),
  constraint crm_leads_stage_check check (
    stage in ('new', 'contacted', 'qualified', 'nurturing', 'unqualified', 'converted')
  ),
  constraint crm_leads_no_self_merge check (
    merged_into_lead_id is null or merged_into_lead_id <> id
  )
);

alter table public.crm_leads
  add constraint crm_leads_owner_same_org
  foreign key (owner_person_id, org_id) references public.people (id, org_id);

alter table public.crm_leads
  add constraint crm_leads_team_same_org
  foreign key (team_id, org_id) references public.teams (id, org_id);

alter table public.crm_leads
  add constraint crm_leads_converted_contact_same_org
  foreign key (converted_contact_id, org_id) references public.contacts (id, org_id);

alter table public.crm_leads
  add constraint crm_leads_merged_into_same_org
  foreign key (merged_into_lead_id, org_id) references public.crm_leads (id, org_id);

alter table public.crm_leads
  add constraint crm_leads_import_batch_same_org
  foreign key (import_batch_id, org_id) references public.crm_imports (id, org_id) on delete restrict;

alter table public.crm_leads
  add constraint crm_leads_created_by_same_org
  foreign key (created_by, org_id) references public.people (id, org_id);

alter table public.crm_leads
  add constraint crm_leads_updated_by_same_org
  foreign key (updated_by, org_id) references public.people (id, org_id);

create index crm_leads_org_stage_idx on public.crm_leads (org_id, stage) where deleted_at is null;
create index crm_leads_org_owner_idx on public.crm_leads (org_id, owner_person_id) where deleted_at is null;
create index crm_leads_org_team_pond_idx on public.crm_leads (org_id, team_id) where owner_person_id is null and deleted_at is null;
create index crm_leads_org_sla_idx on public.crm_leads (org_id, sla_due_at) where owner_person_id is null and escalated_at is null and deleted_at is null;
create index crm_leads_org_phone_idx on public.crm_leads (org_id, primary_phone) where deleted_at is null;
create index crm_leads_org_merge_idx on public.crm_leads (org_id, merged_into_lead_id) where merged_into_lead_id is not null;

comment on table public.crm_leads is
  'Inbound CRM prospects (0089). Tracks lifecycle stage, immutable attribution, owner, and server-trusted SLA clocks.';


-- 2. Table: public.crm_lead_assignment_history
create table public.crm_lead_assignment_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  lead_id uuid not null,
  from_person_id uuid,
  to_person_id uuid,
  reassigned_by_person_id uuid,
  reason text not null,
  created_at timestamptz not null default now(),

  constraint crm_lead_assign_hist_id_org_unique unique (id, org_id),
  constraint crm_lead_assign_hist_reason_not_blank check (length(btrim(reason)) > 0)
);

alter table public.crm_lead_assignment_history
  add constraint crm_lead_assign_hist_lead_same_org
  foreign key (lead_id, org_id) references public.crm_leads (id, org_id) on delete cascade;

alter table public.crm_lead_assignment_history
  add constraint crm_lead_assign_hist_from_same_org
  foreign key (from_person_id, org_id) references public.people (id, org_id);

alter table public.crm_lead_assignment_history
  add constraint crm_lead_assign_hist_to_same_org
  foreign key (to_person_id, org_id) references public.people (id, org_id);

alter table public.crm_lead_assignment_history
  add constraint crm_lead_assign_hist_reassigner_same_org
  foreign key (reassigned_by_person_id, org_id) references public.people (id, org_id);

create index crm_lead_assign_hist_lead_idx on public.crm_lead_assignment_history (org_id, lead_id, created_at desc);

comment on table public.crm_lead_assignment_history is
  'Append-only assignment and reassignment ledger (0089). Tracks sales ownership transitions with cryptographic audit trail.';

create or replace function public.guard_crm_lead_assignment_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'crm_lead_assignment_history: records are immutable and append-only'
    using errcode = '42501';
end;
$$;

revoke all on function public.guard_crm_lead_assignment_history() from public;

create trigger crm_lead_assignment_history_guard
  before update or delete on public.crm_lead_assignment_history
  for each row execute function public.guard_crm_lead_assignment_history();


-- 3. Table: public.crm_assignment_cursors
create table public.crm_assignment_cursors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  team_id uuid not null,
  last_assigned_person_id uuid,
  updated_at timestamptz not null default now(),

  constraint crm_assignment_cursors_id_org_unique unique (id, org_id),
  constraint crm_assignment_cursors_team_unique unique (org_id, team_id)
);

alter table public.crm_assignment_cursors
  add constraint crm_assignment_cursors_team_same_org
  foreign key (team_id, org_id) references public.teams (id, org_id) on delete cascade;

alter table public.crm_assignment_cursors
  add constraint crm_assignment_cursors_last_assigned_same_org
  foreign key (last_assigned_person_id, org_id) references public.people (id, org_id);

comment on table public.crm_assignment_cursors is
  'Round-robin assignment cursor per sales team (0089). State machine ensuring balanced lead distribution.';


-- 4. Table: public.crm_lead_tasks
create table public.crm_lead_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),

  lead_id uuid,
  contact_id uuid,

  title text not null,
  description text,
  task_type text not null,
  priority text not null default 'MEDIUM',
  status text not null default 'PENDING',

  due_at timestamptz not null,
  completed_at timestamptz,
  reminder_sent_at timestamptz,

  assignee_person_id uuid not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Stamped by crm_stamp_actor() (section 10); composite foreign keys below.
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz,

  constraint crm_lead_tasks_id_org_unique unique (id, org_id),
  constraint crm_lead_tasks_target_xor check (
    (lead_id is not null and contact_id is null) or
    (lead_id is null and contact_id is not null)
  ),
  constraint crm_lead_tasks_title_not_blank check (length(btrim(title)) > 0),
  constraint crm_lead_tasks_type_check check (
    task_type in ('FOLLOW_UP', 'SITE_VISIT', 'DOCUMENT_COLLECTION', 'CALL_BACK', 'GENERAL')
  ),
  constraint crm_lead_tasks_priority_check check (
    priority in ('LOW', 'MEDIUM', 'HIGH', 'URGENT')
  ),
  constraint crm_lead_tasks_status_check check (
    status in ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'OVERDUE')
  )
);

alter table public.crm_lead_tasks
  add constraint crm_lead_tasks_lead_same_org
  foreign key (lead_id, org_id) references public.crm_leads (id, org_id) on delete cascade;

alter table public.crm_lead_tasks
  add constraint crm_lead_tasks_contact_same_org
  foreign key (contact_id, org_id) references public.contacts (id, org_id) on delete cascade;

alter table public.crm_lead_tasks
  add constraint crm_lead_tasks_assignee_same_org
  foreign key (assignee_person_id, org_id) references public.people (id, org_id);

alter table public.crm_lead_tasks
  add constraint crm_lead_tasks_created_by_same_org
  foreign key (created_by, org_id) references public.people (id, org_id);

alter table public.crm_lead_tasks
  add constraint crm_lead_tasks_updated_by_same_org
  foreign key (updated_by, org_id) references public.people (id, org_id);

create index crm_lead_tasks_org_assignee_idx on public.crm_lead_tasks (org_id, assignee_person_id, due_at)
  where deleted_at is null and status in ('PENDING', 'IN_PROGRESS');
create index crm_lead_tasks_org_lead_idx on public.crm_lead_tasks (org_id, lead_id)
  where lead_id is not null;
create index crm_lead_tasks_org_contact_idx on public.crm_lead_tasks (org_id, contact_id)
  where contact_id is not null;
create index crm_lead_tasks_org_reminder_idx on public.crm_lead_tasks (org_id, due_at)
  where deleted_at is null and reminder_sent_at is null and status in ('PENDING', 'IN_PROGRESS');

comment on table public.crm_lead_tasks is
  'Follow-up tasks and daily worklist actions (0089). Strictly references exactly one of lead_id or contact_id via XOR constraint.';


-- 5. Table: public.crm_dedup_candidates
create table public.crm_dedup_candidates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),

  entity_type text not null,
  primary_entity_id uuid not null,
  duplicate_entity_id uuid not null,

  confidence_score numeric(3, 2) not null,
  match_reasons jsonb not null default '[]'::jsonb,
  status text not null default 'PENDING',

  reviewed_by_person_id uuid,
  reviewed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint crm_dedup_candidates_id_org_unique unique (id, org_id),
  constraint crm_dedup_candidates_entity_type check (entity_type in ('lead', 'contact')),
  constraint crm_dedup_candidates_score_range check (confidence_score >= 0.00 and confidence_score <= 1.00),
  constraint crm_dedup_candidates_status check (status in ('PENDING', 'MERGED', 'DISMISSED')),
  constraint crm_dedup_candidates_no_self_pair check (primary_entity_id <> duplicate_entity_id),
  constraint crm_dedup_candidates_pair_unique unique (org_id, entity_type, primary_entity_id, duplicate_entity_id)
);

alter table public.crm_dedup_candidates
  add constraint crm_dedup_candidates_reviewer_same_org
  foreign key (reviewed_by_person_id, org_id) references public.people (id, org_id);

create index crm_dedup_candidates_org_status_idx on public.crm_dedup_candidates (org_id, status)
  where status = 'PENDING';

comment on table public.crm_dedup_candidates is
  'Duplicate entity candidates generated by exact and fuzzy identity matching (0089). Requires human-controlled review.';


-- 6. Table: public.crm_lead_attribution_corrections
create table public.crm_lead_attribution_corrections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  lead_id uuid not null,

  field_name text not null,
  old_value text,
  new_value text not null,
  reason text not null,

  status text not null default 'PENDING',
  requested_by_person_id uuid not null,
  approved_by_person_id uuid,
  -- Who decided the request, whether APPROVED or REJECTED (approved_by_person_id is set only on
  -- approval and then equals it).
  decided_by_person_id uuid,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  rejection_reason text,
  metadata jsonb not null default '{}'::jsonb,

  constraint crm_lead_attr_corr_id_org_unique unique (id, org_id),
  constraint crm_lead_attr_corr_field check (field_name in ('source', 'source_subcategory', 'campaign_id')),
  constraint crm_lead_attr_corr_reason_len check (length(btrim(reason)) >= 10),
  constraint crm_lead_attr_corr_status check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  -- The decision fields always agree with the status: a request is undecided until a single
  -- decision records who decided it and when; a rejection always carries its reason and never an
  -- approver; an approval never carries a rejection reason.
  constraint crm_lead_attr_corr_decision_consistent check (
    (status = 'PENDING'
       and decided_by_person_id is null and approved_by_person_id is null
       and decided_at is null and rejection_reason is null)
    or (status = 'APPROVED'
       and decided_by_person_id is not null and approved_by_person_id = decided_by_person_id
       and decided_at is not null and rejection_reason is null)
    or (status = 'REJECTED'
       and decided_by_person_id is not null and approved_by_person_id is null
       and decided_at is not null and length(btrim(rejection_reason)) >= 5)
  )
);

alter table public.crm_lead_attribution_corrections
  add constraint crm_lead_attr_corr_lead_same_org
  foreign key (lead_id, org_id) references public.crm_leads (id, org_id) on delete cascade;

alter table public.crm_lead_attribution_corrections
  add constraint crm_lead_attr_corr_requester_same_org
  foreign key (requested_by_person_id, org_id) references public.people (id, org_id);

alter table public.crm_lead_attribution_corrections
  add constraint crm_lead_attr_corr_approver_same_org
  foreign key (approved_by_person_id, org_id) references public.people (id, org_id);

alter table public.crm_lead_attribution_corrections
  add constraint crm_lead_attr_corr_decider_same_org
  foreign key (decided_by_person_id, org_id) references public.people (id, org_id);

create index crm_lead_attr_corr_lead_idx on public.crm_lead_attribution_corrections (org_id, lead_id, status);

comment on table public.crm_lead_attribution_corrections is
  'Governed attribution correction ledger (0089). Tracks two-person approval workflows before marketing origin data can be mutated.';


-- 7. Alter public.contacts
--
-- Plain ADD COLUMN / CREATE INDEX on purpose (no IF NOT EXISTS): on a database that has drifted,
-- a pre-existing column of the same name must stop the migration, not be silently adopted.
alter table public.contacts
  add column merged_into_contact_id uuid,
  add column merged_at timestamptz,
  add column merge_reason text;

alter table public.contacts
  add constraint contacts_no_self_merge
  check (merged_into_contact_id is null or merged_into_contact_id <> id);

alter table public.contacts
  add constraint contacts_merged_into_same_org
  foreign key (merged_into_contact_id, org_id) references public.contacts (id, org_id);

create index contacts_org_merge_idx
  on public.contacts (org_id, merged_into_contact_id)
  where merged_into_contact_id is not null;


-- 8. Alter public.activities
alter table public.activities
  add column logged_at timestamptz;

-- The backfill is a schema change, not an edit. Without this, every existing row's BEFORE UPDATE
-- triggers would run: set_updated_at() would set updated_at to the migration time and
-- stamp_crm_actor() would set updated_by to NULL (a migration has no identity) — erasing the real
-- last-edit time and editor of every activity, unrecoverably and with no audit entry
-- (audit_row_change skips actorless writes). The triggers are disabled for this one statement
-- only (the table is already held ACCESS EXCLUSIVE by the ADD COLUMN above, and the whole
-- migration is one transaction, so no other session can write in between) and re-enabled at
-- once. The audit and link/owner guards are disabled too: they would do nothing for an actorless
-- update of a column they do not read, and skipping them keeps the locked window short.
alter table public.activities
  disable trigger activities_set_updated_at,
  disable trigger activities_stamp_actor,
  disable trigger activities_audit,
  disable trigger activities_link_immutable,
  disable trigger activities_enforce_owner_change;

update public.activities
  set logged_at = created_at
  where logged_at is null;

alter table public.activities
  enable trigger activities_set_updated_at,
  enable trigger activities_stamp_actor,
  enable trigger activities_audit,
  enable trigger activities_link_immutable,
  enable trigger activities_enforce_owner_change;

alter table public.activities
  alter column logged_at set default now(),
  alter column logged_at set not null;

alter table public.activities
  drop constraint activities_entity_type;

alter table public.activities
  add constraint activities_entity_type
  check (entity_type in ('company', 'contact', 'deal', 'lead'));

create index activities_org_lead_timeline_idx
  on public.activities (org_id, entity_id, logged_at desc)
  where entity_type = 'lead' and deleted_at is null;


-- 9. Integrity, scope and attribution functions and triggers
-- 9a. Attribution guard.
--
-- SECURITY INVOKER on purpose. Inside a SECURITY DEFINER function current_user is the
-- function's OWNER — app_owner, which runs the migrations — so a definer guard testing
-- current_user can never fire. As an invoker trigger, current_user is the role whose statement
-- fired it: app_user for a direct UPDATE (refused), app_owner only inside the definer path
-- apply_lead_attribution_correction() (allowed). app_user holds table-level UPDATE on
-- crm_leads (roles.sql default privileges), so this trigger is the control, not a backstop.
create or replace function public.guard_crm_lead_attribution()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (old.source is distinct from new.source or
      old.source_subcategory is distinct from new.source_subcategory or
      old.campaign_id is distinct from new.campaign_id)
     and current_user <> 'app_owner' then
    raise exception 'Direct modification of lead attribution is prohibited. Mutations must execute via apply_lead_attribution_correction().'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_crm_lead_attribution() from public;

create trigger crm_leads_attribution_guard
  before update on public.crm_leads
  for each row execute function public.guard_crm_lead_attribution();

comment on function public.guard_crm_lead_attribution() is
  'BEFORE UPDATE on crm_leads (0089). SECURITY INVOKER: refuses a change to source, source_subcategory or campaign_id unless the statement runs as app_owner, which at runtime only the definer crm_decide_lead_attribution_correction() (behind apply_lead_attribution_correction) does. Holds even if roles.sql re-grants table-level UPDATE.';

-- How these functions tell callers apart. Three facts, none of which depends on trigger order:
--   * current_user  — the role whose privileges a statement runs with. It is app_owner only in a
--                     migration/maintenance session or inside a SECURITY DEFINER function owned by
--                     app_owner; app_user cannot change it. Used by the INVOKER guards (9a, 9b).
--   * session_user  — the login of the connection. A SECURITY DEFINER function does not change it
--                     and app_user cannot change it. Used by the DEFINER guard (9c) and the actor
--                     stamp (9d) to recognise the owner/maintenance plane (session_user = app_owner).
--   * app.person_id / app.org_id — the caller's identity, set transaction-locally by
--                     withAuthorizedDb(). It IS writable by app_user (set_config), so it is pinned
--                     for the duration of each statement (9f): any change between the start of a
--                     statement and any row it writes aborts the statement. No guard grants an
--                     exemption merely because the identity is empty.

-- 9b. Server-owned lead fields.
--
-- created_at and the SLA clock fields belong to the server and the worker, never to a client
-- (founder decision, 2026-11-06; P1 spec §4.1: the SLA is measured from the server insertion time,
-- never from a client payload). For any statement not running as app_owner:
--   INSERT: created_at/updated_at are the transaction time; sla_due_at is created_at + 15 minutes
--           (the spec's in-working-hours rule); first_contacted_at, first_successful_contact_at and
--           escalated_at start NULL — whatever the statement supplied.
--   UPDATE: none of created_at, sla_due_at, first_contacted_at, first_successful_contact_at,
--           escalated_at may change.
-- The working-hours adjustment of sla_due_at, first-contact qualification and escalation are
-- PR-P1-02 / worker scope: they will set these fields through SECURITY DEFINER functions owned by
-- app_owner (current_user = app_owner), the only path this guard admits.
create or replace function public.guard_crm_lead_server_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user = 'app_owner' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.sla_due_at := now() + interval '15 minutes';
    new.first_contacted_at := null;
    new.first_successful_contact_at := null;
    new.escalated_at := null;
  else
    if new.created_at is distinct from old.created_at
       or new.sla_due_at is distinct from old.sla_due_at
       or new.first_contacted_at is distinct from old.first_contacted_at
       or new.first_successful_contact_at is distinct from old.first_successful_contact_at
       or new.escalated_at is distinct from old.escalated_at then
      raise exception 'created_at and the SLA fields of a lead are server-owned'
        using errcode = '42501';
    end if;
    -- The last-change time is the server's too.
    new.updated_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.guard_crm_lead_server_fields() from public;

create trigger crm_leads_server_fields_guard
  before insert or update on public.crm_leads
  for each row execute function public.guard_crm_lead_server_fields();

comment on function public.guard_crm_lead_server_fields() is
  'BEFORE INSERT OR UPDATE on crm_leads (0089). created_at and the SLA fields are set by the server: forced on INSERT, immutable on UPDATE, except as app_owner (migrations and the future SLA/worker definer functions).';

-- 9c. Assignment guard (owner and team), on creation and on every change.
--
-- Placing a lead with someone — an owner other than the caller, or a team — is an assignment:
--   owner: an owner other than the caller needs leads.assign, and the owner must be inside the
--          caller's leads.assign reach (authz.crm_owner_reachable, the 0033 convention; raising
--          before the FK check also closes the person-existence oracle). Taking a lead for
--          oneself at creation is creation, already scoped by crm_leads_insert.
--   team:  the team must be in one of the caller's departments unless the caller's scope for the
--          relevant permission is GLOBAL (leads.create on INSERT, leads.assign on UPDATE); moving a
--          lead to another team on UPDATE also needs leads.assign.
-- A policy cannot compare NEW with the stored row (a crm_leads subquery inside a crm_leads policy
-- is rejected with 42P17), so this is a trigger. SECURITY DEFINER because crm_owner_reachable is
-- not executable by app_user (0033: it would be a scope-membership oracle); therefore it uses
-- session_user, not current_user, to recognise the owner plane.
create or replace function public.guard_crm_lead_owner_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_changed boolean;
  v_team_changed boolean;
  v_team_scope_permission text;
begin
  if session_user = 'app_owner' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_owner_changed := new.owner_person_id is not null
                       and new.owner_person_id is distinct from authz.person_id();
    v_team_changed := new.team_id is not null;
    v_team_scope_permission := 'leads.create';
  else
    v_owner_changed := new.owner_person_id is distinct from old.owner_person_id;
    v_team_changed := new.team_id is distinct from old.team_id;
    v_team_scope_permission := 'leads.assign';
  end if;

  if v_owner_changed then
    if not coalesce(authz.has('leads.assign'), false) then
      raise exception 'Assigning a lead to someone requires leads.assign'
        using errcode = '42501';
    end if;
    if new.owner_person_id is not null
       and not authz.crm_owner_reachable('leads.assign', new.owner_person_id) then
      raise exception 'owner_person_id may only be someone within your leads.assign scope'
        using errcode = '42501';
    end if;
  end if;

  if v_team_changed then
    if tg_op = 'UPDATE' and not coalesce(authz.has('leads.assign'), false) then
      raise exception 'Moving a lead to another team requires leads.assign'
        using errcode = '42501';
    end if;
    if new.team_id is not null
       and authz.scope_for(v_team_scope_permission) is distinct from 'GLOBAL'
       and not exists (
         select 1 from public.teams t
         where t.id = new.team_id
           and t.org_id = authz.org_id()
           and t.deleted_at is null
           and t.department_id = any (authz.my_departments()::uuid[])
       ) then
      raise exception 'team_id may only be a team in your departments'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.guard_crm_lead_owner_change() from public;

create trigger crm_leads_owner_guard
  before insert or update on public.crm_leads
  for each row execute function public.guard_crm_lead_owner_change();

comment on function public.guard_crm_lead_owner_change() is
  'BEFORE INSERT OR UPDATE on crm_leads (0089). Assigning a lead (owner other than the caller, or a team) needs the caller''s reach: leads.assign plus crm_owner_reachable for owners, a team in the caller''s departments unless GLOBAL. Exempt only when the login is app_owner.';

-- 9d. Actor stamping.
--
-- created_by / updated_by name the person who made the change, taken from the transaction
-- identity and never from the statement: on INSERT both are stamped, on UPDATE created_by keeps
-- its stored value and updated_by is stamped. Only the owner login (migrations, seeds) writes them
-- as given. For every other login the stamp is authz.person_id() — NULL when the identity is
-- missing, unparseable or not an active person — so a caller-supplied value never survives.
-- session_user, not current_user: inside apply_lead_attribution_correction (a definer owned by
-- app_owner) current_user is app_owner, yet the change is the approver's and must say so.
create or replace function public.crm_stamp_actor()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_person uuid;
begin
  if session_user = 'app_owner' then
    return new;
  end if;
  begin
    v_person := authz.person_id();
  exception when invalid_text_representation then
    v_person := null;
  end;
  if tg_op = 'INSERT' then
    new.created_by := v_person;
    new.updated_by := v_person;
  else
    new.created_by := old.created_by;
    new.updated_by := v_person;
  end if;
  return new;
end;
$$;

revoke all on function public.crm_stamp_actor() from public;

create trigger crm_leads_actor_stamp
  before insert or update on public.crm_leads
  for each row execute function public.crm_stamp_actor();

create trigger crm_lead_tasks_actor_stamp
  before insert or update on public.crm_lead_tasks
  for each row execute function public.crm_stamp_actor();

comment on function public.crm_stamp_actor() is
  'BEFORE INSERT OR UPDATE on crm_leads and crm_lead_tasks (0089). Stamps created_by/updated_by from the transaction identity for every login but app_owner; a value supplied by the caller never survives.';

-- 9e. Dedup candidate identity.
--
-- A candidate is evidence that two records may be the same; a review decides it, nothing rewrites
-- it. Once inserted, which records it pairs (and the score and reasons that justify it) cannot
-- change for any login but app_owner. Only status and review fields move.
create or replace function public.guard_crm_dedup_candidate_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if session_user <> 'app_owner'
     and (new.org_id is distinct from old.org_id
          or new.entity_type is distinct from old.entity_type
          or new.primary_entity_id is distinct from old.primary_entity_id
          or new.duplicate_entity_id is distinct from old.duplicate_entity_id
          or new.confidence_score is distinct from old.confidence_score
          or new.match_reasons is distinct from old.match_reasons
          or new.created_at is distinct from old.created_at) then
    raise exception 'A dedup candidate''s pair and evidence are immutable; only its review may change'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_crm_dedup_candidate_identity() from public;

create trigger crm_dedup_candidates_identity_guard
  before update on public.crm_dedup_candidates
  for each row execute function public.guard_crm_dedup_candidate_identity();

comment on function public.guard_crm_dedup_candidate_identity() is
  'BEFORE UPDATE on crm_dedup_candidates (0089). The paired records, score and reasons are immutable after insert for every login but app_owner; only status and review fields change.';

-- 9f. Statement identity pin.
--
-- The caller's identity (app.person_id, app.org_id) is set by withAuthorizedDb() once per
-- transaction, and every RLS policy, guard and audit entry reads it. Because set_config() can be
-- called from inside an expression, a statement could otherwise change the identity part-way:
-- after RLS admitted a row under one identity, the triggers, the WITH CHECK, the RETURNING list or
-- the AFTER triggers (audit, assignment ledger) could read another. So, on every one of these
-- tables:
--   * BEFORE ... FOR EACH STATEMENT captures the identity before any expression of the statement
--     is evaluated — and, the identity being constant for a transaction, aborts if the transaction
--     already recorded a different one (an earlier step of the same statement, such as a
--     data-modifying CTE, cannot re-capture a changed identity);
--   * BEFORE ... FOR EACH ROW checks each row after its own expressions (VALUES, SET, ON CONFLICT);
--   * AFTER ... FOR EACH ROW checks again after the RETURNING list, before the statement ends, so
--     an AFTER trigger never acts — and the statement never commits — under a changed identity.
-- Any difference aborts the statement with 42501. The other triggers may fire in any order: an
-- abort rolls back whatever they did.
--
-- What this does not do: it does not authenticate the identity itself — that is
-- withAuthorizedDb()'s (the only database path, ADR-010 single-db-path guard) together with the
-- confinement of the app_user credential to the server. It protects the identity a transaction
-- started with from being changed while statements on these tables run.
--
-- The capture lives in a table only app_owner (the owner of the two definer functions) can write;
-- one row per backend, keyed to the transaction.
create table public.crm_statement_identity (
  backend_pid integer primary key,
  xact xid8 not null,
  person_id text,
  org_id text
);

alter table public.crm_statement_identity enable row level security;
alter table public.crm_statement_identity force row level security;

create policy crm_statement_identity_owner_all on public.crm_statement_identity
  for all to app_owner using (true) with check (true);

revoke all on public.crm_statement_identity
  from public, app_user, app_admin, app_worker, app_auth, app_platform;

comment on table public.crm_statement_identity is
  'Operational (0089): the caller identity captured at the start of the current statement on a CRM leads table, per backend. Written and read only by crm_capture_statement_identity() / crm_assert_statement_identity().';

create or replace function public.crm_capture_statement_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pin public.crm_statement_identity;
begin
  -- withAuthorizedDb() sets the identity once per transaction. A capture that would REPLACE an
  -- identity already recorded for this transaction means it was changed part-way — possibly in
  -- an earlier step of the same statement (a data-modifying CTE) — so it aborts instead of
  -- overwriting the pin.
  select * into v_pin from public.crm_statement_identity where backend_pid = pg_backend_pid();
  if found and v_pin.xact = pg_current_xact_id()
     and (v_pin.person_id is distinct from current_setting('app.person_id', true)
          or v_pin.org_id is distinct from current_setting('app.org_id', true)) then
    raise exception 'The caller identity changed within the transaction'
      using errcode = '42501';
  end if;
  insert into public.crm_statement_identity (backend_pid, xact, person_id, org_id)
  values (pg_backend_pid(), pg_current_xact_id(),
          current_setting('app.person_id', true), current_setting('app.org_id', true))
  on conflict (backend_pid) do update
    set xact = excluded.xact, person_id = excluded.person_id, org_id = excluded.org_id;
  return null;
end;
$$;

create or replace function public.crm_assert_statement_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pin public.crm_statement_identity;
begin
  select * into v_pin from public.crm_statement_identity where backend_pid = pg_backend_pid();
  if not found
     or v_pin.xact is distinct from pg_current_xact_id()
     or v_pin.person_id is distinct from current_setting('app.person_id', true)
     or v_pin.org_id is distinct from current_setting('app.org_id', true) then
    raise exception 'The caller identity changed during the statement'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.crm_capture_statement_identity() from public;
revoke all on function public.crm_assert_statement_identity() from public;

comment on function public.crm_capture_statement_identity() is
  'BEFORE ... FOR EACH STATEMENT on the 0089 CRM tables: records the caller identity at the start of the statement; aborts (42501) if the transaction already recorded a different one.';
comment on function public.crm_assert_statement_identity() is
  'BEFORE and AFTER ... FOR EACH ROW on the 0089 CRM tables: aborts (42501) when the caller identity differs from the one captured for the statement.';

create trigger crm_leads_identity_capture
  before insert or update or delete on public.crm_leads
  for each statement execute function public.crm_capture_statement_identity();
create trigger crm_leads_identity_pin
  before insert or update or delete on public.crm_leads
  for each row execute function public.crm_assert_statement_identity();
create trigger crm_leads_identity_pin_after
  after insert or update or delete on public.crm_leads
  for each row execute function public.crm_assert_statement_identity();

create trigger crm_lead_assignment_history_identity_capture
  before insert or update or delete on public.crm_lead_assignment_history
  for each statement execute function public.crm_capture_statement_identity();
create trigger crm_lead_assignment_history_identity_pin
  before insert or update or delete on public.crm_lead_assignment_history
  for each row execute function public.crm_assert_statement_identity();
create trigger crm_lead_assignment_history_identity_pin_after
  after insert or update or delete on public.crm_lead_assignment_history
  for each row execute function public.crm_assert_statement_identity();

create trigger crm_assignment_cursors_identity_capture
  before insert or update or delete on public.crm_assignment_cursors
  for each statement execute function public.crm_capture_statement_identity();
create trigger crm_assignment_cursors_identity_pin
  before insert or update or delete on public.crm_assignment_cursors
  for each row execute function public.crm_assert_statement_identity();
create trigger crm_assignment_cursors_identity_pin_after
  after insert or update or delete on public.crm_assignment_cursors
  for each row execute function public.crm_assert_statement_identity();

create trigger crm_lead_tasks_identity_capture
  before insert or update or delete on public.crm_lead_tasks
  for each statement execute function public.crm_capture_statement_identity();
create trigger crm_lead_tasks_identity_pin
  before insert or update or delete on public.crm_lead_tasks
  for each row execute function public.crm_assert_statement_identity();
create trigger crm_lead_tasks_identity_pin_after
  after insert or update or delete on public.crm_lead_tasks
  for each row execute function public.crm_assert_statement_identity();

create trigger crm_dedup_candidates_identity_capture
  before insert or update or delete on public.crm_dedup_candidates
  for each statement execute function public.crm_capture_statement_identity();
create trigger crm_dedup_candidates_identity_pin
  before insert or update or delete on public.crm_dedup_candidates
  for each row execute function public.crm_assert_statement_identity();
create trigger crm_dedup_candidates_identity_pin_after
  after insert or update or delete on public.crm_dedup_candidates
  for each row execute function public.crm_assert_statement_identity();

create trigger crm_lead_attribution_corrections_identity_capture
  before insert or update or delete on public.crm_lead_attribution_corrections
  for each statement execute function public.crm_capture_statement_identity();
create trigger crm_lead_attribution_corrections_identity_pin
  before insert or update or delete on public.crm_lead_attribution_corrections
  for each row execute function public.crm_assert_statement_identity();
create trigger crm_lead_attribution_corrections_identity_pin_after
  after insert or update or delete on public.crm_lead_attribution_corrections
  for each row execute function public.crm_assert_statement_identity();

-- 9g. Assignment ledger, written from the persisted row.
--
-- The assignment history is append-only, so an entry must be true when written and cannot be
-- corrected later. It is therefore written by the database, not by a caller: when a lead is
-- created with an owner, or its owner changes, this AFTER trigger records from = the stored
-- previous owner (OLD, inside the same transaction), to = the new owner, reassigned_by = the
-- caller, created_at = the transaction time. app_user cannot insert history rows at all.
-- The reason is the caller's free text, read from the transaction-local setting
-- app.reassignment_reason when the server provides one.
create or replace function public.crm_record_lead_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(current_setting('app.reassignment_reason', true)), '');
  v_by uuid;
begin
  begin
    v_by := authz.person_id();
  exception when invalid_text_representation then
    v_by := null;
  end;
  insert into public.crm_lead_assignment_history
    (org_id, lead_id, from_person_id, to_person_id, reassigned_by_person_id, reason)
  values (
    new.org_id,
    new.id,
    case when tg_op = 'UPDATE' then old.owner_person_id end,
    new.owner_person_id,
    v_by,
    coalesce(v_reason, case when tg_op = 'INSERT' then 'Initial assignment' else 'Reassignment' end)
  );
  return null;
end;
$$;

revoke all on function public.crm_record_lead_assignment() from public;

create trigger crm_leads_assignment_ledger_insert
  after insert on public.crm_leads
  for each row when (new.owner_person_id is not null)
  execute function public.crm_record_lead_assignment();

create trigger crm_leads_assignment_ledger_update
  after update of owner_person_id on public.crm_leads
  for each row when (new.owner_person_id is distinct from old.owner_person_id)
  execute function public.crm_record_lead_assignment();

comment on function public.crm_record_lead_assignment() is
  'AFTER INSERT/UPDATE OF owner_person_id on crm_leads (0089): appends the assignment-history entry from the persisted previous owner; the only writer of crm_lead_assignment_history at runtime.';

-- 9h. Lead scope for a permission.
--
-- True when the caller's scope for p_permission covers a lead with this owner and team — the
-- same answer as the USING clause of crm_leads_update gives for leads.edit, written so it gives
-- that answer in BOTH contexts it is used in: as app_user (the corrections policies) and inside
-- the definer functions below, where current_user is app_owner and table RLS would otherwise admit
-- every team. The pond (no owner) DEPARTMENT case therefore spells out what app_user can see of
-- teams (teams_select_member: a team the caller is an active member of, in the caller's org).
-- Every input is a stored value the caller already holds or a permission key.
create or replace function public.crm_lead_in_scope(
  p_permission text, p_owner_person_id uuid, p_team_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    case authz.scope_for(p_permission)
      when 'GLOBAL' then true
      when 'DEPARTMENT' then
        case
          when p_owner_person_id is null then
            p_team_id is not null and exists (
              select 1
              from public.teams t
              join public.team_members tm on tm.team_id = t.id
              where t.id = p_team_id
                and t.org_id = authz.org_id()
                and t.deleted_at is null
                and tm.person_id = authz.person_id()
                and tm.deleted_at is null
                and t.department_id = any (authz.my_departments()::uuid[])
            )
          else
            authz.in_my_departments(p_owner_person_id) or authz.reports_to_me(p_owner_person_id)
        end
      when 'TEAM' then
        p_owner_person_id is not null
        and (p_owner_person_id = authz.person_id() or authz.reports_to_me(p_owner_person_id))
      when 'SELF' then p_owner_person_id = authz.person_id()
      else false
    end,
    false);
$$;

revoke all on function public.crm_lead_in_scope(text, uuid, uuid) from public;
grant execute on function public.crm_lead_in_scope(text, uuid, uuid) to app_user;

comment on function public.crm_lead_in_scope(text, uuid, uuid) is
  'Is a lead with this owner/team inside the caller''s scope for the permission? For leads.edit it mirrors crm_leads_update USING; identical for app_user and inside definer functions (0089).';

-- 9i. Attribution correction permissions (founder decision, 2026-11-06).
--
--   leads.attribution.request          ask for a correction of a lead's source/campaign
--   leads.attribution.approve          decide (approve or reject) a correction request
--   leads.attribution.single_manager   use the SINGLE_MANAGER exception: decide one's own request,
--                                      only where the organization has enabled that policy
-- SUPER_ADMIN holds the whole catalogue (seed_system_roles, 0081 cross join), so new organizations
-- receive these through it; existing organizations' SUPER_ADMIN roles are backfilled below (the
-- 0081 PART 8 pattern). No other role is granted them here: which roles hold them is the
-- organization administrator's decision.
insert into public.permissions (key, resource, action, module, description, is_sensitive)
values
  ('leads.attribution.request', 'leads.attribution', 'request', 'sales',
   'Request a correction of a lead''s attribution (source, sub-category, campaign)', false),
  ('leads.attribution.approve', 'leads.attribution', 'approve', 'sales',
   'Approve or reject a lead attribution correction requested by someone else', true),
  ('leads.attribution.single_manager', 'leads.attribution', 'single_manager', 'sales',
   'Decide one''s own attribution correction where the organization enabled SINGLE_MANAGER', true);

do $$
begin
  if exists (
    select 1 from pg_trigger
    where tgname = 'role_permissions_enforce_protection'
      and tgrelid = 'public.role_permissions'::regclass
  ) then
    alter table public.role_permissions disable trigger role_permissions_enforce_protection;
  end if;
end
$$;

insert into public.role_permissions (role_id, permission_id, scope)
select r.id, p.id, 'GLOBAL'::public.access_scope
from public.roles r
cross join public.permissions p
where r.key = 'SUPER_ADMIN'
  and p.key in ('leads.attribution.request', 'leads.attribution.approve',
                'leads.attribution.single_manager')
on conflict do nothing;

do $$
begin
  if exists (
    select 1 from pg_trigger
    where tgname = 'role_permissions_enforce_protection'
      and tgrelid = 'public.role_permissions'::regclass
  ) then
    alter table public.role_permissions enable trigger role_permissions_enforce_protection;
  end if;
end
$$;

-- 9j. The organization's attribution policy.
--
-- settings.attribution.policy is TWO_PERSON (the default, also when absent) or SINGLE_MANAGER
-- (an explicit organization-level exception). There is no OFF value: any other stored value is
-- read as TWO_PERSON. app_user has no UPDATE on organizations; this function is the only tenant
-- path that changes the policy. It needs settings.manage, records the change in the audit log, and
-- accepts only the two values.
create or replace function public.crm_attribution_policy()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case o.settings->'attribution'->>'policy'
           when 'SINGLE_MANAGER' then 'SINGLE_MANAGER'
           else 'TWO_PERSON'
         end
  from public.organizations o
  where o.id = authz.org_id();
$$;

revoke all on function public.crm_attribution_policy() from public;
grant execute on function public.crm_attribution_policy() to app_user;

comment on function public.crm_attribution_policy() is
  'The caller organization''s attribution policy: SINGLE_MANAGER when explicitly enabled, otherwise TWO_PERSON (absent or unknown values never disable the two-person rule) (0089).';

create or replace function public.set_lead_attribution_policy(p_policy text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := authz.person_id();
  v_org uuid := authz.org_id();
  v_before text;
begin
  if v_person is null or v_org is null or not authz.is_active() then
    raise exception 'Unauthenticated caller' using errcode = '42501';
  end if;
  if not authz.has('settings.manage') then
    raise exception 'Changing the attribution policy requires settings.manage' using errcode = '42501';
  end if;
  if p_policy is null or p_policy not in ('TWO_PERSON', 'SINGLE_MANAGER') then
    raise exception 'Attribution policy must be TWO_PERSON or SINGLE_MANAGER' using errcode = '22023';
  end if;

  select public.crm_attribution_policy() into v_before;

  update public.organizations
  set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{attribution}',
                           coalesce(settings->'attribution', '{}'::jsonb)
                             || jsonb_build_object('policy', p_policy), true),
      updated_at = clock_timestamp()
  where id = v_org;

  perform public.write_audit_log(
    p_action := 'organization.attribution_policy_changed',
    p_entity_type := 'organization',
    p_entity_id := v_org,
    p_severity := 'HIGH',
    p_before := jsonb_build_object('policy', v_before),
    p_after := jsonb_build_object('policy', p_policy)
  );
end;
$$;

revoke all on function public.set_lead_attribution_policy(text) from public;
grant execute on function public.set_lead_attribution_policy(text) to app_user;

comment on function public.set_lead_attribution_policy(text) is
  'Sets the caller organization''s attribution policy to TWO_PERSON or SINGLE_MANAGER. Needs settings.manage; audited (0089).';

-- 9k. Governed attribution correction: approve or reject.
--
-- Both decisions need leads.attribution.approve and the lead inside the decider's scope for it
-- (a correction outside that scope is reported exactly like a missing one — no existence or
-- status leak). Under TWO_PERSON the decider must not be the requester. Under SINGLE_MANAGER the
-- requester may decide their own request only with leads.attribution.single_manager (and the lead
-- inside its scope); every such use writes its own CRITICAL audit entry. Approval re-checks the
-- current value (a stale request would record a falsehood) and changes the lead; rejection needs a
-- reason and never touches the lead.
create or replace function public.crm_decide_lead_attribution_correction(
  p_correction_id uuid, p_approve boolean, p_rejection_reason text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := authz.person_id();
  v_org uuid := authz.org_id();
  v_corr public.crm_lead_attribution_corrections;
  v_owner uuid;
  v_team uuid;
  v_source text;
  v_source_subcategory text;
  v_campaign_id text;
  v_current text;
  v_policy text;
  v_exception boolean := false;
  v_reason text := nullif(btrim(p_rejection_reason), '');
begin
  if v_person is null or v_org is null then
    raise exception 'Unauthenticated caller' using errcode = '42501';
  end if;
  if not authz.is_active() then
    raise exception 'Inactive user' using errcode = '42501';
  end if;
  if not authz.has('leads.attribution.approve') then
    raise exception 'Deciding an attribution correction requires leads.attribution.approve'
      using errcode = '42501';
  end if;

  select * into v_corr
  from public.crm_lead_attribution_corrections
  where id = p_correction_id and org_id = v_org
  for update;
  if not found then
    raise exception 'Attribution correction request not found' using errcode = 'P0002';
  end if;

  select l.owner_person_id, l.team_id, l.source, l.source_subcategory, l.campaign_id
    into v_owner, v_team, v_source, v_source_subcategory, v_campaign_id
  from public.crm_leads l
  where l.id = v_corr.lead_id and l.org_id = v_org and l.deleted_at is null
  for update;
  if not found
     or not public.crm_lead_in_scope('leads.attribution.approve', v_owner, v_team) then
    raise exception 'Attribution correction request not found' using errcode = 'P0002';
  end if;

  if v_corr.status <> 'PENDING' then
    raise exception 'Correction request is already decided' using errcode = '23514';
  end if;

  v_policy := coalesce(public.crm_attribution_policy(), 'TWO_PERSON');
  if v_corr.requested_by_person_id = v_person then
    if v_policy <> 'SINGLE_MANAGER'
       or not authz.has('leads.attribution.single_manager')
       or not public.crm_lead_in_scope('leads.attribution.single_manager', v_owner, v_team) then
      raise exception 'Two-person policy violation: the requester cannot decide their own correction'
        using errcode = '42501';
    end if;
    v_exception := true;
  end if;

  if p_approve then
    v_current := case v_corr.field_name
      when 'source' then v_source
      when 'source_subcategory' then v_source_subcategory
      when 'campaign_id' then v_campaign_id
    end;
    if v_corr.old_value is distinct from v_current then
      raise exception 'Attribution correction is stale: the lead''s % changed after the request', v_corr.field_name
        using errcode = '23514';
    end if;

    if v_corr.field_name = 'source' then
      update public.crm_leads set source = v_corr.new_value, updated_at = clock_timestamp()
      where id = v_corr.lead_id and org_id = v_org;
    elsif v_corr.field_name = 'source_subcategory' then
      update public.crm_leads set source_subcategory = v_corr.new_value, updated_at = clock_timestamp()
      where id = v_corr.lead_id and org_id = v_org;
    elsif v_corr.field_name = 'campaign_id' then
      update public.crm_leads set campaign_id = v_corr.new_value, updated_at = clock_timestamp()
      where id = v_corr.lead_id and org_id = v_org;
    else
      raise exception 'Invalid attribution field: %', v_corr.field_name using errcode = '23514';
    end if;

    update public.crm_lead_attribution_corrections
    set status = 'APPROVED',
        approved_by_person_id = v_person,
        decided_by_person_id = v_person,
        decided_at = clock_timestamp()
    where id = p_correction_id and org_id = v_org;

    perform public.write_audit_log(
      p_action := 'crm_lead.attribution_corrected',
      p_entity_type := 'crm_lead',
      p_entity_id := v_corr.lead_id,
      p_severity := 'HIGH',
      p_before := jsonb_build_object(v_corr.field_name, v_corr.old_value),
      p_after := jsonb_build_object(v_corr.field_name, v_corr.new_value),
      p_metadata := jsonb_build_object(
        'correction_id', v_corr.id,
        'requested_by_person_id', v_corr.requested_by_person_id,
        'reason', v_corr.reason,
        'policy', v_policy,
        'single_manager_exception', v_exception
      )
    );
  else
    if v_reason is null or length(v_reason) < 5 then
      raise exception 'Rejecting an attribution correction requires a reason (at least 5 characters)'
        using errcode = '23514';
    end if;

    update public.crm_lead_attribution_corrections
    set status = 'REJECTED',
        decided_by_person_id = v_person,
        decided_at = clock_timestamp(),
        rejection_reason = v_reason
    where id = p_correction_id and org_id = v_org;

    perform public.write_audit_log(
      p_action := 'crm_lead.attribution_correction_rejected',
      p_entity_type := 'crm_lead',
      p_entity_id := v_corr.lead_id,
      p_severity := 'MEDIUM',
      p_metadata := jsonb_build_object(
        'correction_id', v_corr.id,
        'field', v_corr.field_name,
        'requested_by_person_id', v_corr.requested_by_person_id,
        'rejection_reason', v_reason,
        'policy', v_policy,
        'single_manager_exception', v_exception
      )
    );
  end if;

  if v_exception then
    perform public.write_audit_log(
      p_action := 'crm_lead.attribution_single_manager_exception_used',
      p_entity_type := 'crm_lead',
      p_entity_id := v_corr.lead_id,
      p_severity := 'CRITICAL',
      p_metadata := jsonb_build_object(
        'correction_id', v_corr.id,
        'decision', case when p_approve then 'APPROVED' else 'REJECTED' end
      )
    );
  end if;
end;
$$;

revoke all on function public.crm_decide_lead_attribution_correction(uuid, boolean, text) from public;

comment on function public.crm_decide_lead_attribution_correction(uuid, boolean, text) is
  'Internal (0089): decides an attribution correction. Not executable by app_user; called by apply_lead_attribution_correction / reject_lead_attribution_correction.';

create or replace function public.apply_lead_attribution_correction(p_correction_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select public.crm_decide_lead_attribution_correction(p_correction_id, true, null);
$$;

create or replace function public.reject_lead_attribution_correction(
  p_correction_id uuid, p_reason text
) returns void
language sql
security definer
set search_path = ''
as $$
  select public.crm_decide_lead_attribution_correction(p_correction_id, false, p_reason);
$$;

revoke all on function public.apply_lead_attribution_correction(uuid) from public;
grant execute on function public.apply_lead_attribution_correction(uuid) to app_user;
revoke all on function public.reject_lead_attribution_correction(uuid, text) from public;
grant execute on function public.reject_lead_attribution_correction(uuid, text) to app_user;

comment on function public.apply_lead_attribution_correction(uuid) is
  'Approves an attribution correction and applies it to the lead (0089). Needs leads.attribution.approve and the lead in scope; two-person rule or the audited SINGLE_MANAGER exception; refuses stale requests; audited in the same transaction.';
comment on function public.reject_lead_attribution_correction(uuid, text) is
  'Rejects an attribution correction with a reason, leaving the lead unchanged (0089). Same authority rules as approval; audited in the same transaction.';


-- 10. Row-Level Security Configuration

alter table public.crm_leads enable row level security;
alter table public.crm_leads force row level security;

create policy crm_leads_owner_all on public.crm_leads
  for all to app_owner using (true) with check (true);

create policy crm_leads_select on public.crm_leads
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and deleted_at is null
    and (
      (owner_person_id is null and (
        case (select authz.scope_for('leads.view'))
          when 'GLOBAL' then true
          when 'DEPARTMENT' then (
            team_id is not null and exists (
              select 1 from public.teams t
              where t.id = crm_leads.team_id
                and t.department_id = any ((select authz.my_departments())::uuid[])
            )
          )
          else false
        end
      ))
      or
      (owner_person_id is not null and (
        case (select authz.scope_for('leads.view'))
          when 'GLOBAL' then true
          when 'DEPARTMENT' then (
            (select authz.in_my_departments(owner_person_id))
            or (select authz.reports_to_me(owner_person_id))
          )
          when 'TEAM' then (
            owner_person_id = (select authz.person_id())
            or (select authz.reports_to_me(owner_person_id))
          )
          when 'SELF' then owner_person_id = (select authz.person_id())
          else false
        end
      ))
    )
  );

create policy crm_leads_insert on public.crm_leads
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.create'))
    and (
      case (select authz.scope_for('leads.create'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (
          owner_person_id is null
          or (select authz.in_my_departments(owner_person_id))
          or (select authz.reports_to_me(owner_person_id))
        )
        when 'TEAM' then (
          owner_person_id is null
          or owner_person_id = (select authz.person_id())
          or (select authz.reports_to_me(owner_person_id))
        )
        when 'SELF' then (
          owner_person_id is null
          or owner_person_id = (select authz.person_id())
        )
        else false
      end
    )
  );

create policy crm_leads_update on public.crm_leads
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and deleted_at is null
    and (
      case (select authz.scope_for('leads.edit'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (
          (owner_person_id is null and (
            team_id is not null and exists (
              select 1 from public.teams t
              where t.id = crm_leads.team_id
                and t.department_id = any ((select authz.my_departments())::uuid[])
            )
          ))
          or (owner_person_id is not null and (
            (select authz.in_my_departments(owner_person_id))
            or (select authz.reports_to_me(owner_person_id))
          ))
        )
        when 'TEAM' then (
          owner_person_id is not null and (
            owner_person_id = (select authz.person_id())
            or (select authz.reports_to_me(owner_person_id))
          )
        )
        when 'SELF' then owner_person_id = (select authz.person_id())
        else false
      end
    )
  )
  -- An owner change additionally needs leads.assign: enforced by guard_crm_lead_owner_change()
  -- (section 9b), because a crm_leads policy may not query crm_leads (42P17).
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.edit'))
  );

-- Lead assignment history RLS
alter table public.crm_lead_assignment_history enable row level security;
alter table public.crm_lead_assignment_history force row level security;

create policy crm_lead_assign_hist_owner_all on public.crm_lead_assignment_history
  for all to app_owner using (true) with check (true);

create policy crm_lead_assign_hist_select on public.crm_lead_assignment_history
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and exists (
      select 1 from public.crm_leads l
      where l.id = crm_lead_assignment_history.lead_id
        and l.org_id = crm_lead_assignment_history.org_id
    )
  );

-- No INSERT policy for app_user, and INSERT is revoked below: the ledger is written only by
-- crm_record_lead_assignment() (section 9g) from the persisted previous owner, so no caller can
-- add, fabricate or backdate an entry.

-- Assignment cursors RLS
alter table public.crm_assignment_cursors enable row level security;
alter table public.crm_assignment_cursors force row level security;

create policy crm_assignment_cursors_owner_all on public.crm_assignment_cursors
  for all to app_owner using (true) with check (true);

-- A team's round-robin state belongs to whoever may assign within that team: GLOBAL assigners
-- anywhere, everyone else only for teams of their own departments (the teams subquery also runs
-- under teams RLS, so a non-member sees no team at all — fail closed).
create policy crm_assignment_cursors_select on public.crm_assignment_cursors
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.assign'))
    and (
      (select authz.scope_for('leads.assign')) = 'GLOBAL'
      or exists (
        select 1 from public.teams t
        where t.id = crm_assignment_cursors.team_id
          and t.department_id = any ((select authz.my_departments())::uuid[])
      )
    )
  );

create policy crm_assignment_cursors_insert on public.crm_assignment_cursors
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.assign'))
    and (
      (select authz.scope_for('leads.assign')) = 'GLOBAL'
      or exists (
        select 1 from public.teams t
        where t.id = crm_assignment_cursors.team_id
          and t.department_id = any ((select authz.my_departments())::uuid[])
      )
    )
  );

create policy crm_assignment_cursors_update on public.crm_assignment_cursors
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.assign'))
    and (
      (select authz.scope_for('leads.assign')) = 'GLOBAL'
      or exists (
        select 1 from public.teams t
        where t.id = crm_assignment_cursors.team_id
          and t.department_id = any ((select authz.my_departments())::uuid[])
      )
    )
  );

-- Tasks RLS
alter table public.crm_lead_tasks enable row level security;
alter table public.crm_lead_tasks force row level security;

create policy crm_lead_tasks_owner_all on public.crm_lead_tasks
  for all to app_owner using (true) with check (true);

create policy crm_lead_tasks_select on public.crm_lead_tasks
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and deleted_at is null
    and (
      case (select authz.scope_for('leads.view'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (
          (select authz.in_my_departments(assignee_person_id))
          or (select authz.reports_to_me(assignee_person_id))
        )
        when 'TEAM' then (
          assignee_person_id = (select authz.person_id())
          or (select authz.reports_to_me(assignee_person_id))
        )
        when 'SELF' then assignee_person_id = (select authz.person_id())
        else false
      end
    )
  );

-- On INSERT and on every UPDATE (an explicit WITH CHECK, so re-pointing an existing task is held
-- to the same rule): a task may only be attached to a lead or contact the caller can see (each
-- subquery runs under that table's own RLS), so it cannot be planted on another agent's lead;
-- and its assignee must be someone the caller may give work to under leads.edit — themselves,
-- or within their department / reporting line / organization per their scope — so it cannot be
-- pushed onto any colleague's worklist.
create policy crm_lead_tasks_insert on public.crm_lead_tasks
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.edit'))
    and (
      crm_lead_tasks.lead_id is null or exists (
        select 1 from public.crm_leads l
        where l.id = crm_lead_tasks.lead_id
          and l.org_id = crm_lead_tasks.org_id
      )
    )
    and (
      crm_lead_tasks.contact_id is null or exists (
        select 1 from public.contacts c
        where c.id = crm_lead_tasks.contact_id
          and c.org_id = crm_lead_tasks.org_id
      )
    )
    and (
      assignee_person_id = (select authz.person_id())
      or case (select authz.scope_for('leads.edit'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (
          (select authz.in_my_departments(assignee_person_id))
          or (select authz.reports_to_me(assignee_person_id))
        )
        when 'TEAM' then (select authz.reports_to_me(assignee_person_id))
        else false
      end
    )
  );

create policy crm_lead_tasks_update on public.crm_lead_tasks
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and deleted_at is null
    and (
      case (select authz.scope_for('leads.edit'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (
          (select authz.in_my_departments(assignee_person_id))
          or (select authz.reports_to_me(assignee_person_id))
        )
        when 'TEAM' then (
          assignee_person_id = (select authz.person_id())
          or (select authz.reports_to_me(assignee_person_id))
        )
        when 'SELF' then assignee_person_id = (select authz.person_id())
        else false
      end
    )
  )
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.edit'))
    and (
      crm_lead_tasks.lead_id is null or exists (
        select 1 from public.crm_leads l
        where l.id = crm_lead_tasks.lead_id
          and l.org_id = crm_lead_tasks.org_id
      )
    )
    and (
      crm_lead_tasks.contact_id is null or exists (
        select 1 from public.contacts c
        where c.id = crm_lead_tasks.contact_id
          and c.org_id = crm_lead_tasks.org_id
      )
    )
    and (
      assignee_person_id = (select authz.person_id())
      or case (select authz.scope_for('leads.edit'))
        when 'GLOBAL' then true
        when 'DEPARTMENT' then (
          (select authz.in_my_departments(assignee_person_id))
          or (select authz.reports_to_me(assignee_person_id))
        )
        when 'TEAM' then (select authz.reports_to_me(assignee_person_id))
        else false
      end
    )
  );

-- Dedup candidates RLS
alter table public.crm_dedup_candidates enable row level security;
alter table public.crm_dedup_candidates force row level security;

create policy crm_dedup_candidates_owner_all on public.crm_dedup_candidates
  for all to app_owner using (true) with check (true);

-- A candidate exposes the two records it pairs (and the evidence in match_reasons), so it is
-- visible, and can be created or reviewed, only when the caller can see BOTH records — each
-- subquery runs under crm_leads / contacts RLS. A candidate starts PENDING and unreviewed; a
-- decided candidate names the caller as its reviewer. Which records it pairs never changes after
-- insert (guard_crm_dedup_candidate_identity).
create policy crm_dedup_candidates_select on public.crm_dedup_candidates
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.view'))
    and case crm_dedup_candidates.entity_type
      when 'lead' then
        exists (select 1 from public.crm_leads l
                where l.id = crm_dedup_candidates.primary_entity_id and l.org_id = crm_dedup_candidates.org_id)
        and exists (select 1 from public.crm_leads l
                    where l.id = crm_dedup_candidates.duplicate_entity_id and l.org_id = crm_dedup_candidates.org_id)
      when 'contact' then
        exists (select 1 from public.contacts c
                where c.id = crm_dedup_candidates.primary_entity_id and c.org_id = crm_dedup_candidates.org_id)
        and exists (select 1 from public.contacts c
                    where c.id = crm_dedup_candidates.duplicate_entity_id and c.org_id = crm_dedup_candidates.org_id)
      else false
    end
  );

create policy crm_dedup_candidates_insert on public.crm_dedup_candidates
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.edit'))
    and status = 'PENDING'
    and reviewed_by_person_id is null
    and reviewed_at is null
    and case crm_dedup_candidates.entity_type
      when 'lead' then
        exists (select 1 from public.crm_leads l
                where l.id = crm_dedup_candidates.primary_entity_id and l.org_id = crm_dedup_candidates.org_id)
        and exists (select 1 from public.crm_leads l
                    where l.id = crm_dedup_candidates.duplicate_entity_id and l.org_id = crm_dedup_candidates.org_id)
      when 'contact' then
        exists (select 1 from public.contacts c
                where c.id = crm_dedup_candidates.primary_entity_id and c.org_id = crm_dedup_candidates.org_id)
        and exists (select 1 from public.contacts c
                    where c.id = crm_dedup_candidates.duplicate_entity_id and c.org_id = crm_dedup_candidates.org_id)
      else false
    end
  );

-- The USING clause repeats the both-records visibility: Postgres applies SELECT policies to an
-- UPDATE only when the statement reads a column, so an UPDATE without a WHERE clause would
-- otherwise reach every candidate of the organization, including pairs the caller cannot see.
create policy crm_dedup_candidates_update on public.crm_dedup_candidates
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.edit'))
    and case crm_dedup_candidates.entity_type
      when 'lead' then
        exists (select 1 from public.crm_leads l
                where l.id = crm_dedup_candidates.primary_entity_id and l.org_id = crm_dedup_candidates.org_id)
        and exists (select 1 from public.crm_leads l
                    where l.id = crm_dedup_candidates.duplicate_entity_id and l.org_id = crm_dedup_candidates.org_id)
      when 'contact' then
        exists (select 1 from public.contacts c
                where c.id = crm_dedup_candidates.primary_entity_id and c.org_id = crm_dedup_candidates.org_id)
        and exists (select 1 from public.contacts c
                    where c.id = crm_dedup_candidates.duplicate_entity_id and c.org_id = crm_dedup_candidates.org_id)
      else false
    end
  )
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.edit'))
    and (
      (status = 'PENDING' and reviewed_by_person_id is null)
      or (status <> 'PENDING' and reviewed_by_person_id = (select authz.person_id()))
    )
  );

-- Attribution corrections RLS
alter table public.crm_lead_attribution_corrections enable row level security;
alter table public.crm_lead_attribution_corrections force row level security;

create policy crm_lead_attr_corr_owner_all on public.crm_lead_attribution_corrections
  for all to app_owner using (true) with check (true);

-- A correction is visible only with its lead: the subquery runs under crm_leads RLS, so an
-- agent scoped to their own leads does not read the attribution history of anyone else's.
create policy crm_lead_attr_corr_select on public.crm_lead_attribution_corrections
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.view'))
    and exists (
      select 1 from public.crm_leads l
      where l.id = crm_lead_attribution_corrections.lead_id
        and l.org_id = crm_lead_attribution_corrections.org_id
    )
  );

-- A request needs the dedicated leads.attribution.request permission (founder decision,
-- 2026-11-06) and may only name a lead inside the caller's scope for that permission. The
-- requester is the caller (the two-person rule compares it with the decider, so it must be a
-- verified identity), and a request starts PENDING with no decision recorded.
create policy crm_lead_attr_corr_insert on public.crm_lead_attribution_corrections
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.attribution.request'))
    and requested_by_person_id = (select authz.person_id())
    and status = 'PENDING'
    and approved_by_person_id is null
    and decided_by_person_id is null
    and decided_at is null
    and rejection_reason is null
    and exists (
      select 1 from public.crm_leads l
      where l.id = crm_lead_attribution_corrections.lead_id
        and l.org_id = crm_lead_attribution_corrections.org_id
        and public.crm_lead_in_scope('leads.attribution.request', l.owner_person_id, l.team_id)
    )
  );

-- Revoke dangerous table privileges from runtime roles
revoke delete on public.crm_leads from app_user;
revoke delete on public.crm_lead_tasks from app_user;
revoke delete on public.crm_assignment_cursors from app_user;
revoke delete on public.crm_dedup_candidates from app_user;
revoke update, delete on public.crm_lead_attribution_corrections from app_user;
revoke insert, update, delete on public.crm_lead_assignment_history from app_user;

revoke all on public.crm_leads, public.crm_lead_assignment_history,
  public.crm_assignment_cursors, public.crm_lead_tasks, public.crm_dedup_candidates,
  public.crm_lead_attribution_corrections
  from app_admin, app_worker, app_auth, app_platform;


-- 11. Row audit
--
-- Every new table records its changes in audit_logs through the same trigger as the CRM core
-- tables (0012/0033): AFTER INSERT OR UPDATE OR DELETE, actor and organization derived from the
-- transaction identity, skipped silently when there is none (migrations, seeds).
create trigger crm_leads_audit
  after insert or update or delete on public.crm_leads
  for each row execute function public.audit_row_change('crm_lead', 'HIGH', 'id');

create trigger crm_lead_assignment_history_audit
  after insert or update or delete on public.crm_lead_assignment_history
  for each row execute function public.audit_row_change('crm_lead_assignment', 'HIGH', 'id');

create trigger crm_assignment_cursors_audit
  after insert or update or delete on public.crm_assignment_cursors
  for each row execute function public.audit_row_change('crm_assignment_cursor', 'MEDIUM', 'id');

create trigger crm_lead_tasks_audit
  after insert or update or delete on public.crm_lead_tasks
  for each row execute function public.audit_row_change('crm_lead_task', 'MEDIUM', 'id');

create trigger crm_dedup_candidates_audit
  after insert or update or delete on public.crm_dedup_candidates
  for each row execute function public.audit_row_change('crm_dedup_candidate', 'MEDIUM', 'id');

create trigger crm_lead_attribution_corrections_audit
  after insert or update or delete on public.crm_lead_attribution_corrections
  for each row execute function public.audit_row_change('crm_lead_attribution_correction', 'HIGH', 'id');

