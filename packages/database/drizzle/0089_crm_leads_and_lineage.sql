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
--   - public.re_lead_preferences (Real Estate property vertical extension)
--   - public.contacts alteration (multi-hop merge pointers and lineage)
--   - public.activities alteration (logged_at timestamp backfill; polymorphic 'lead' support)
--   - Attribution trigger defense (guard_crm_lead_attribution against table-level roles.sql re-grant)
--   - Privileged attribution mutator procedure (apply_lead_attribution_correction)
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
  created_by uuid references public.people (id),
  updated_by uuid references public.people (id),
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
  created_by uuid references public.people (id),
  updated_by uuid references public.people (id),
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
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  rejection_reason text,
  metadata jsonb not null default '{}'::jsonb,

  constraint crm_lead_attr_corr_id_org_unique unique (id, org_id),
  constraint crm_lead_attr_corr_field check (field_name in ('source', 'source_subcategory', 'campaign_id')),
  constraint crm_lead_attr_corr_reason_len check (length(btrim(reason)) >= 10),
  constraint crm_lead_attr_corr_status check (status in ('PENDING', 'APPROVED', 'REJECTED'))
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

create index crm_lead_attr_corr_lead_idx on public.crm_lead_attribution_corrections (org_id, lead_id, status);

comment on table public.crm_lead_attribution_corrections is
  'Governed attribution correction ledger (0089). Tracks two-person approval workflows before marketing origin data can be mutated.';


-- 7. Table: public.re_lead_preferences
create table public.re_lead_preferences (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  lead_id uuid not null,

  property_types text[] not null default '{}',
  budget_min_paise bigint,
  budget_max_paise bigint,
  preferred_localities text[] not null default '{}',
  possession_timeline text,
  bhk_preferences text[] not null default '{}',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint re_lead_pref_id_org_unique unique (id, org_id),
  constraint re_lead_pref_lead_unique unique (org_id, lead_id),
  constraint re_lead_pref_budget_order check (
    budget_min_paise is null or budget_max_paise is null or budget_min_paise <= budget_max_paise
  ),
  constraint re_lead_pref_budget_positive check (
    (budget_min_paise is null or budget_min_paise >= 0) and
    (budget_max_paise is null or budget_max_paise >= 0)
  )
);

alter table public.re_lead_preferences
  add constraint re_lead_pref_lead_same_org
  foreign key (lead_id, org_id) references public.crm_leads (id, org_id) on delete cascade;

create index re_lead_pref_budget_idx on public.re_lead_preferences (org_id, budget_min_paise, budget_max_paise);

comment on table public.re_lead_preferences is
  'Real Estate property vertical preferences (0089). Extends generic lead identity with localized real estate parameters.';


-- 8. Alter public.contacts
alter table public.contacts
  add column if not exists merged_into_contact_id uuid,
  add column if not exists merged_at timestamptz,
  add column if not exists merge_reason text;

alter table public.contacts
  add constraint contacts_no_self_merge
  check (merged_into_contact_id is null or merged_into_contact_id <> id);

alter table public.contacts
  add constraint contacts_merged_into_same_org
  foreign key (merged_into_contact_id, org_id) references public.contacts (id, org_id);

create index if not exists contacts_org_merge_idx
  on public.contacts (org_id, merged_into_contact_id)
  where merged_into_contact_id is not null;


-- 9. Alter public.activities
alter table public.activities
  add column if not exists logged_at timestamptz;

update public.activities
  set logged_at = created_at
  where logged_at is null;

alter table public.activities
  alter column logged_at set default now(),
  alter column logged_at set not null;

alter table public.activities
  drop constraint if exists activities_entity_type;

alter table public.activities
  add constraint activities_entity_type
  check (entity_type in ('company', 'contact', 'deal', 'lead'));

create index if not exists activities_org_lead_timeline_idx
  on public.activities (org_id, entity_id, logged_at desc)
  where entity_type = 'lead' and deleted_at is null;


-- 10. Attribution Security Functions & Triggers
create or replace function public.guard_crm_lead_attribution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (old.source is distinct from new.source or
      old.source_subcategory is distinct from new.source_subcategory or
      old.campaign_id is distinct from new.campaign_id) then
    if current_user <> 'app_owner' then
      raise exception 'Direct modification of lead attribution is prohibited. Mutations must execute via apply_lead_attribution_correction().'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_crm_lead_attribution() from public;

create trigger crm_leads_attribution_guard
  before update on public.crm_leads
  for each row execute function public.guard_crm_lead_attribution();

comment on function public.guard_crm_lead_attribution() is
  'BEFORE UPDATE on crm_leads (0089). Durably prevents direct modification of attribution columns by app_user, even if roles.sql re-grants table-level UPDATE.';

create or replace function public.apply_lead_attribution_correction(
  p_correction_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := authz.person_id();
  v_org uuid := authz.org_id();
  v_corr public.crm_lead_attribution_corrections;
  v_policy text;
  v_org_settings jsonb;
begin
  if v_person is null or v_org is null then
    raise exception 'Unauthenticated caller' using errcode = '42501';
  end if;

  if not authz.is_active() then
    raise exception 'Inactive user' using errcode = '42501';
  end if;

  if not (authz.has('leads.assign') or authz.has('leads.edit')) then
    raise exception 'Insufficient permissions to apply attribution correction' using errcode = '42501';
  end if;

  select * into v_corr
  from public.crm_lead_attribution_corrections
  where id = p_correction_id and org_id = v_org
  for update;

  if not found then
    raise exception 'Correction request not found' using errcode = '02000';
  end if;

  if v_corr.status <> 'PENDING' then
    raise exception 'Correction request is already decided' using errcode = '23514';
  end if;

  select settings into v_org_settings
  from public.organizations
  where id = v_org;

  v_policy := coalesce(v_org_settings->'attribution'->>'policy', 'TWO_PERSON');

  if v_policy = 'TWO_PERSON' and v_corr.requested_by_person_id = v_person then
    raise exception 'Two-person policy violation: requester cannot approve their own correction'
      using errcode = '42501';
  end if;

  if v_corr.field_name = 'source' then
    update public.crm_leads
    set source = v_corr.new_value,
        updated_at = clock_timestamp(),
        updated_by = v_person
    where id = v_corr.lead_id and org_id = v_org;
  elsif v_corr.field_name = 'source_subcategory' then
    update public.crm_leads
    set source_subcategory = v_corr.new_value,
        updated_at = clock_timestamp(),
        updated_by = v_person
    where id = v_corr.lead_id and org_id = v_org;
  elsif v_corr.field_name = 'campaign_id' then
    update public.crm_leads
    set campaign_id = v_corr.new_value,
        updated_at = clock_timestamp(),
        updated_by = v_person
    where id = v_corr.lead_id and org_id = v_org;
  else
    raise exception 'Invalid attribution field: %', v_corr.field_name using errcode = '23514';
  end if;

  update public.crm_lead_attribution_corrections
  set status = 'APPROVED',
      approved_by_person_id = v_person,
      decided_at = clock_timestamp()
  where id = p_correction_id and org_id = v_org;

  perform public.write_audit_log(
    'crm_leads',
    v_corr.lead_id,
    'UPDATE',
    jsonb_build_object(
      'field', v_corr.field_name,
      'old_value', v_corr.old_value,
      'new_value', v_corr.new_value,
      'reason', v_corr.reason,
      'correction_id', v_corr.id,
      'policy', v_policy
    ),
    'HIGH'
  );
end;
$$;

revoke all on function public.apply_lead_attribution_correction(uuid) from public;
grant execute on function public.apply_lead_attribution_correction(uuid) to app_user;

comment on function public.apply_lead_attribution_correction(uuid) is
  'Privileged mutator executing governed lead attribution corrections (0089). Enforces two-person approval and writes atomic audit logs.';


-- 11. Row-Level Security Configuration

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
            authz.in_my_department(owner_person_id)
            or authz.is_my_report(owner_person_id)
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
          or authz.in_my_department(owner_person_id)
          or authz.is_my_report(owner_person_id)
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
            team_id is null or exists (
              select 1 from public.teams t
              where t.id = crm_leads.team_id
                and t.department_id = any ((select authz.my_departments())::uuid[])
            )
          ))
          or (owner_person_id is not null and (
            authz.in_my_department(owner_person_id)
            or authz.is_my_report(owner_person_id)
          ))
        )
        when 'SELF' then owner_person_id = (select authz.person_id())
        else false
      end
    )
  )
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.edit'))
    and (
      (owner_person_id is not distinct from (
        select l.owner_person_id from public.crm_leads l where l.id = crm_leads.id and l.org_id = crm_leads.org_id
      ))
      or (select authz.has('leads.assign'))
    )
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

create policy crm_lead_assign_hist_insert on public.crm_lead_assignment_history
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (
      (select authz.has('leads.create'))
      or (select authz.has('leads.assign'))
      or (select authz.has('leads.edit'))
    )
  );

-- Assignment cursors RLS
alter table public.crm_assignment_cursors enable row level security;
alter table public.crm_assignment_cursors force row level security;

create policy crm_assignment_cursors_owner_all on public.crm_assignment_cursors
  for all to app_owner using (true) with check (true);

create policy crm_assignment_cursors_select on public.crm_assignment_cursors
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.assign'))
  );

create policy crm_assignment_cursors_insert on public.crm_assignment_cursors
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.assign'))
  );

create policy crm_assignment_cursors_update on public.crm_assignment_cursors
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.assign'))
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
          authz.in_my_department(assignee_person_id)
          or authz.is_my_report(assignee_person_id)
        )
        when 'SELF' then assignee_person_id = (select authz.person_id())
        else false
      end
    )
  );

create policy crm_lead_tasks_insert on public.crm_lead_tasks
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.edit'))
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
          authz.in_my_department(assignee_person_id)
          or authz.is_my_report(assignee_person_id)
        )
        when 'SELF' then assignee_person_id = (select authz.person_id())
        else false
      end
    )
  );

-- Dedup candidates RLS
alter table public.crm_dedup_candidates enable row level security;
alter table public.crm_dedup_candidates force row level security;

create policy crm_dedup_candidates_owner_all on public.crm_dedup_candidates
  for all to app_owner using (true) with check (true);

create policy crm_dedup_candidates_select on public.crm_dedup_candidates
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.view'))
  );

create policy crm_dedup_candidates_insert on public.crm_dedup_candidates
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.edit'))
  );

create policy crm_dedup_candidates_update on public.crm_dedup_candidates
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.edit'))
  );

-- Attribution corrections RLS
alter table public.crm_lead_attribution_corrections enable row level security;
alter table public.crm_lead_attribution_corrections force row level security;

create policy crm_lead_attr_corr_owner_all on public.crm_lead_attribution_corrections
  for all to app_owner using (true) with check (true);

create policy crm_lead_attr_corr_select on public.crm_lead_attribution_corrections
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.view'))
  );

create policy crm_lead_attr_corr_insert on public.crm_lead_attribution_corrections
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.edit'))
  );

-- Real Estate preferences RLS
alter table public.re_lead_preferences enable row level security;
alter table public.re_lead_preferences force row level security;

create policy re_lead_pref_owner_all on public.re_lead_preferences
  for all to app_owner using (true) with check (true);

create policy re_lead_pref_select on public.re_lead_preferences
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and exists (
      select 1 from public.crm_leads l
      where l.id = re_lead_preferences.lead_id
        and l.org_id = re_lead_preferences.org_id
    )
  );

create policy re_lead_pref_insert on public.re_lead_preferences
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.create'))
  );

create policy re_lead_pref_update on public.re_lead_preferences
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('leads.edit'))
  );

-- Revoke dangerous table privileges from runtime roles
revoke delete on public.crm_leads from app_user;
revoke delete on public.crm_lead_tasks from app_user;
revoke delete on public.crm_assignment_cursors from app_user;
revoke delete on public.crm_dedup_candidates from app_user;
revoke update, delete on public.crm_lead_attribution_corrections from app_user;
revoke update, delete on public.crm_lead_assignment_history from app_user;

revoke all on public.crm_leads, public.crm_lead_assignment_history,
  public.crm_assignment_cursors, public.crm_lead_tasks, public.crm_dedup_candidates,
  public.crm_lead_attribution_corrections, public.re_lead_preferences
  from app_admin, app_worker, app_auth, app_platform;
