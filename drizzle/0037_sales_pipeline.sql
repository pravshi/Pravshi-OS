-- PRAVSHI OS — Phase 3: sales pipeline.
--
-- Pipelines are org-level configuration (not owned records): a pipeline has
-- stages, a deal lives in exactly one pipeline and moves through its stages,
-- and every stage movement is recorded in deal_stage_history.
--
-- Conventions carried over from 0033/0034:
--   Task 1.4 composite-key strategy  pipeline_stages carries (org_id,
--                                    pipeline_id) → pipelines(org_id, id) and
--                                    deal_stage_history carries (org_id,
--                                    deal_id) → deals(org_id, id), so a stage
--                                    and a history row must agree with their
--                                    parent on org_id.
--   Task 1.16 RLS template           org-scoped, deleted_at-excluded (where the
--                                    table has one), is_active()-gated. The
--                                    owner-based scope arms of 0033 do not
--                                    apply here — these tables carry no
--                                    owner_person_id — so each policy gates on
--                                    authz.has('<key>') (the permission at any
--                                    scope) instead. Only SUPER_ADMIN and
--                                    ADMIN hold the pipeline keys, so in
--                                    practice this is admin-only.
--   Task 1.11 audit triggers         audit_row_change() at HIGH, whole-row, on
--                                    all three tables.
--   No DELETE policy                 on any of the three: pipelines soft-delete
--                                    through crm_soft_delete(); stages and
--                                    history are append-mostly and have no
--                                    runtime delete path at all.
--
-- DELIBERATE DEVIATIONS FROM THE 0033 TEMPLATE, and why:
--   * stamp_crm_actor() / enforce_crm_owner_change() are NOT attached. The
--     0033 functions require created_by/updated_by and owner_person_id columns;
--     pipelines, pipeline_stages and deal_stage_history are org-level config
--     and append-only history, not owned records, so they carry neither.
--     Attribution for history rows is the changed_by column, stamped by the
--     recorder trigger from authz.person_id() (NULL for migrations/seeds —
--     the same "no synthetic actor" rule as 0033 F3).
--   * deals.pipeline_id / deals.pipeline_stage_id use single-column FKs to
--     pipelines(id) / pipeline_stages(id) exactly as specified, instead of the
--     composite (org_id, …) form. The tenant-isolation guarantee the composite
--     form would give is provided instead by deals_pipeline_org_guard(), a
--     BEFORE trigger that rejects a pipeline or stage from another org with
--     42501 before any FK check runs.
--   * The immutable-pipeline trigger is created AFTER the backfill section
--     below. Creating it before would reject the backfill's own NULL → value
--     assignment (IS DISTINCT FROM NULL is true), and the one-time backfill
--     is the only legitimate pipeline assignment after the fact.
--   * pipeline_stages has no deleted_at column, so the (pipeline_id,
--     position) uniqueness is an unconditional unique index, not a partial
--     one. Stages are hard-deletable by app_owner only, and then only when no
--     deal references the stage — the FK from deals blocks anything else.
--   * deal_stage_history SELECT is keyed on authz.has('deals.view') rather
--     than per-row owner scoping: history carries no PII beyond stage
--     transitions, and per-deal scoping is enforced at the deals table itself.
--   * crm_soft_delete() (0034) gains the 'pipeline' → 'pipelines' mapping, so
--     the runtime soft-delete path that 0034 built for every CRM table covers
--     pipelines too. Stages and history stay outside the allowlist: no
--     runtime delete path exists for them by design.

-- ═════════════════════════════════════════════════════════════════════════════════
-- pipelines
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.pipelines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),

  name text not null,
  description text,
  is_default boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint pipelines_name_not_blank check (length(btrim(name)) > 0),
  -- Referenced by pipeline_stages(org_id, pipeline_id): the referenced column
  -- list must match this unique definition positionally.
  constraint pipelines_org_id_unique unique (org_id, id)
);

-- Exactly one live default pipeline per org. A soft-deleted default frees the
-- slot, so a replacement default can be promoted later.
create unique index pipelines_one_default_per_org
  on public.pipelines (org_id)
  where is_default and deleted_at is null;

create index pipelines_org_idx on public.pipelines (org_id) where deleted_at is null;

create trigger pipelines_set_updated_at
  before update on public.pipelines
  for each row execute function public.set_updated_at();

comment on table public.pipelines is
  'Sales pipelines: org-level configuration, not owned records. One live '
  'default per org; deals reference exactly one pipeline and never change it.';

-- ═════════════════════════════════════════════════════════════════════════════════
-- pipeline_stages
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  pipeline_id uuid not null,

  name text not null,
  position integer not null,
  probability numeric(5, 2) not null default 0,
  color text,
  is_won boolean not null default false,
  is_lost boolean not null default false,

  created_at timestamptz not null default now(),

  constraint pipeline_stages_name_not_blank check (length(btrim(name)) > 0),
  constraint pipeline_stages_probability check (
    probability >= 0 and probability <= 100
  ),
  constraint pipeline_stages_color check (
    color is null or color ~ '^#[0-9a-fA-F]{6}$'
  ),
  constraint pipeline_stages_terminal check (not (is_won and is_lost)),
  constraint pipeline_stages_position_unique unique (pipeline_id, position)
);

-- Composite FK: the stage's org must agree with its pipeline's org. The
-- pipeline_stage_org_guard() trigger below re-checks this as defense in depth.
alter table public.pipeline_stages
  add constraint pipeline_stages_pipeline_same_org
  foreign key (org_id, pipeline_id) references public.pipelines (org_id, id);

create index pipeline_stages_org_idx on public.pipeline_stages (org_id);
create index pipeline_stages_pipeline_idx
  on public.pipeline_stages (pipeline_id, position);

comment on table public.pipeline_stages is
  'Stages within a pipeline, ordered by position. Stages are append-mostly: no '
  'deleted_at, no runtime delete path; app_owner may hard-delete a stage only '
  'when no deal references it (the deals FK blocks anything else).';

-- ═════════════════════════════════════════════════════════════════════════════════
-- deal_stage_history
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.deal_stage_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  deal_id uuid not null,

  -- NULL from_stage_id marks the deal's creation into the pipeline.
  from_stage_id uuid,
  to_stage_id uuid not null,

  -- NULL when the movement was recorded without an authenticated actor
  -- (migration backfill, seeds) — the 0033 "no synthetic actor" rule.
  changed_by uuid references public.people (id),
  changed_at timestamptz not null default now(),

  -- Composite FK: the history row's org must agree with the deal's org. The
  -- referenced column list mirrors deals_id_org_unique positionally.
  constraint deal_stage_history_deal_same_org
    foreign key (deal_id, org_id) references public.deals (id, org_id),
  -- Single-column stage FKs by design; the recorder trigger validates the org
  -- match (a stage from another org is rejected with 42501).
  constraint deal_stage_history_from_stage
    foreign key (from_stage_id) references public.pipeline_stages (id),
  constraint deal_stage_history_to_stage
    foreign key (to_stage_id) references public.pipeline_stages (id)
);

create index deal_stage_history_deal_idx
  on public.deal_stage_history (org_id, deal_id);
create index deal_stage_history_changed_idx
  on public.deal_stage_history (org_id, changed_at);

comment on table public.deal_stage_history is
  'Append-only record of every deal stage movement, written by the '
  'deals_record_stage_history() trigger. from_stage_id NULL means the deal was '
  'created into to_stage_id. No UPDATE/DELETE path for runtime roles.';

-- ═════════════════════════════════════════════════════════════════════════════════
-- deals: the pipeline linkage
-- ═════════════════════════════════════════════════════════════════════════════════

alter table public.deals
  add column pipeline_id uuid references public.pipelines (id),
  add column pipeline_stage_id uuid references public.pipeline_stages (id);

create index deals_org_pipeline_idx
  on public.deals (org_id, pipeline_id)
  where pipeline_id is not null and deleted_at is null;
create index deals_org_pipeline_stage_idx
  on public.deals (org_id, pipeline_stage_id)
  where pipeline_stage_id is not null and deleted_at is null;

comment on column public.deals.pipeline_id is
  'The pipeline this deal lives in. Immutable after creation: a deal never '
  'changes pipeline (enforced by deals_pipeline_immutable()).';
comment on column public.deals.pipeline_stage_id is
  'The deal''s current stage. Movements are recorded in deal_stage_history by '
  'the deals_record_stage_history() trigger.';

-- ═════════════════════════════════════════════════════════════════════════════════
-- RLS
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The 0033 4.2 template adapted for org-level config tables: org-scoped,
-- deleted_at-excluded (where the table has one), is_active()-gated, and keyed
-- on the pipeline permission catalogue. The owner-based scope CASE has no
-- owner to evaluate against here, so each policy gates on
-- authz.has('<key>') — the permission held at any scope. The matrix below
-- grants the pipeline keys to SUPER_ADMIN and ADMIN only, so in practice
-- these tables are admin-visible. deal_stage_history SELECT additionally
-- requires deals.view, so anyone who can see deals can see their stage
-- movements. No DELETE policy on any of the three tables.

alter table public.pipelines enable row level security;
alter table public.pipelines force row level security;

alter table public.pipeline_stages enable row level security;
alter table public.pipeline_stages force row level security;

alter table public.deal_stage_history enable row level security;
alter table public.deal_stage_history force row level security;

create policy pipelines_owner_all on public.pipelines
  for all to app_owner using (true) with check (true);

create policy pipeline_stages_owner_all on public.pipeline_stages
  for all to app_owner using (true) with check (true);

create policy deal_stage_history_owner_all on public.deal_stage_history
  for all to app_owner using (true) with check (true);

-- ── pipelines ──────────────────────────────────────────────────────────────────

drop policy if exists pipelines_select on public.pipelines;
create policy pipelines_select on public.pipelines
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('pipelines.view'))
  );

drop policy if exists pipelines_insert on public.pipelines;
create policy pipelines_insert on public.pipelines
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('pipelines.create'))
  );

drop policy if exists pipelines_update on public.pipelines;
create policy pipelines_update on public.pipelines
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (select authz.is_active())
    and (select authz.has('pipelines.edit'))
  )
  with check (
    org_id = (select authz.org_id())
  );

-- ── pipeline_stages ────────────────────────────────────────────────────────────
--
-- Reads ride on pipelines.view (viewing a pipeline's configuration includes
-- its stages); writes require the dedicated pipeline_stages.manage key.

drop policy if exists pipeline_stages_select on public.pipeline_stages;
create policy pipeline_stages_select on public.pipeline_stages
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('pipelines.view'))
  );

drop policy if exists pipeline_stages_insert on public.pipeline_stages;
create policy pipeline_stages_insert on public.pipeline_stages
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('pipeline_stages.manage'))
  );

drop policy if exists pipeline_stages_update on public.pipeline_stages;
create policy pipeline_stages_update on public.pipeline_stages
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('pipeline_stages.manage'))
  )
  with check (
    org_id = (select authz.org_id())
  );

-- ── deal_stage_history ─────────────────────────────────────────────────────────
--
-- Append-only: INSERT is trigger-driven (the recorder is SECURITY DEFINER and
-- bypasses RLS); the INSERT policy exists so the table is not silently
-- unwritable outside the trigger path, gated on deals.edit. UPDATE is
-- org-immutable; the application never updates history rows.

drop policy if exists deal_stage_history_select on public.deal_stage_history;
create policy deal_stage_history_select on public.deal_stage_history
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('deals.view'))
  );

drop policy if exists deal_stage_history_insert on public.deal_stage_history;
create policy deal_stage_history_insert on public.deal_stage_history
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.has('deals.edit'))
  );

-- F3 (LOW, Phase 3 security review): the UPDATE policy below was dropped.
-- The migration header documents "no UPDATE/DELETE path for runtime roles"
-- and the application never updates history rows, so the policy was broader
-- than the stated tamper-evident-history invariant. SELECT + INSERT remain;
-- the recorder trigger is SECURITY DEFINER and does not need the UPDATE path.
drop policy if exists deal_stage_history_update on public.deal_stage_history;

-- The DELETE half of the for-all contract is revoked explicitly: nothing here
-- may be hard-deleted by the runtime roles. Pipelines soft-delete through
-- crm_soft_delete(); stages and history have no runtime delete path at all.
revoke delete on public.pipelines, public.pipeline_stages, public.deal_stage_history
  from app_user, app_admin;

-- The new deals columns ride on the existing deals policies — no new policies
-- are needed: INSERT/UPDATE already pin org_id = authz.org_id(), and the
-- deals_pipeline_org_guard() trigger below pins the referenced pipeline and
-- stage to the deal's org.

-- ═════════════════════════════════════════════════════════════════════════════════
-- pipeline_stage_org_guard() — the stage's org must match its pipeline's org
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Defense in depth beyond the composite FK: rejects the write with 42501
-- before constraint checks run.

create or replace function public.pipeline_stage_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pipeline_org uuid;
begin
  select p.org_id into v_pipeline_org
  from public.pipelines p
  where p.id = new.pipeline_id;
  if v_pipeline_org is distinct from new.org_id then
    raise exception 'pipeline stage must belong to the same organization as its pipeline'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.pipeline_stage_org_guard() is
  'BEFORE INSERT/UPDATE on pipeline_stages: the referenced pipeline must belong '
  'to NEW.org_id. Defense in depth beyond the composite FK; raises 42501.';

revoke all on function public.pipeline_stage_org_guard() from public;

drop trigger if exists pipeline_stages_org_guard on public.pipeline_stages;
create trigger pipeline_stages_org_guard
  before insert or update on public.pipeline_stages
  for each row execute function public.pipeline_stage_org_guard();

-- ═════════════════════════════════════════════════════════════════════════════════
-- deals_pipeline_org_guard() — the deal's pipeline and stage must be its org's
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- deals.pipeline_id / deals.pipeline_stage_id are single-column FKs, so without
-- this a deal could reference another org's pipeline or stage. The trigger
-- closes that tenant-isolation hole with 42501 before any FK check runs.

create or replace function public.deals_pipeline_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pipeline_org uuid;
  v_stage_org uuid;
begin
  if new.pipeline_id is not null then
    select p.org_id into v_pipeline_org
    from public.pipelines p
    where p.id = new.pipeline_id;
    if v_pipeline_org is distinct from new.org_id then
      raise exception 'pipeline_id must belong to the deal''s organization'
        using errcode = '42501';
    end if;
  end if;
  if new.pipeline_stage_id is not null then
    select s.org_id into v_stage_org
    from public.pipeline_stages s
    where s.id = new.pipeline_stage_id;
    if v_stage_org is distinct from new.org_id then
      raise exception 'pipeline_stage_id must belong to the deal''s organization'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.deals_pipeline_org_guard() is
  'BEFORE INSERT/UPDATE on deals: pipeline_id and pipeline_stage_id must belong '
  'to NEW.org_id. Closes the cross-org reference hole the single-column FKs '
  'leave open; raises 42501.';

revoke all on function public.deals_pipeline_org_guard() from public;

drop trigger if exists deals_pipeline_org_guard on public.deals;
create trigger deals_pipeline_org_guard
  before insert or update on public.deals
  for each row execute function public.deals_pipeline_org_guard();

-- ═════════════════════════════════════════════════════════════════════════════════
-- deals_record_stage_history() — every stage movement is recorded
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- AFTER INSERT (WHEN pipeline_stage_id IS NOT NULL) records the deal's
-- creation into the pipeline with from_stage_id NULL. AFTER UPDATE OF
-- pipeline_stage_id records each movement; the WHEN clause plus the
-- IS DISTINCT FROM check mean a no-op UPDATE that merely mentions the column
-- writes no history row. The target stage's org is re-validated here even
-- though deals_pipeline_org_guard() already checked it — the history row
-- must never point at another org's stage even if the guard is ever bypassed.
-- changed_by is stamped from authz.person_id(), NULL when there is no
-- authenticated actor (migration backfill, seeds).

create or replace function public.deals_record_stage_history() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from_stage uuid;
  v_to_stage uuid;
  v_stage_org uuid;
begin
  if tg_op = 'INSERT' then
    v_from_stage := null;
    v_to_stage := new.pipeline_stage_id;
  else
    v_from_stage := old.pipeline_stage_id;
    v_to_stage := new.pipeline_stage_id;
    if v_to_stage is not distinct from v_from_stage then
      return new;
    end if;
  end if;
  if v_to_stage is null then
    return new;
  end if;
  select s.org_id into v_stage_org
  from public.pipeline_stages s
  where s.id = v_to_stage;
  if v_stage_org is distinct from new.org_id then
    raise exception 'pipeline stage does not belong to the deal''s organization'
      using errcode = '42501';
  end if;
  insert into public.deal_stage_history
    (org_id, deal_id, from_stage_id, to_stage_id, changed_by)
  values
    (new.org_id, new.id, v_from_stage, v_to_stage, authz.person_id());
  return new;
end;
$$;

comment on function public.deals_record_stage_history() is
  'AFTER INSERT / AFTER UPDATE OF pipeline_stage_id on deals: appends a '
  'deal_stage_history row (from_stage_id NULL on creation). The target stage '
  'is org-validated; changed_by is stamped from authz.person_id().';

revoke all on function public.deals_record_stage_history() from public;

drop trigger if exists deals_record_stage_history_on_insert on public.deals;
create trigger deals_record_stage_history_on_insert
  after insert on public.deals
  for each row
  when (new.pipeline_stage_id is not null)
  execute function public.deals_record_stage_history();

drop trigger if exists deals_record_stage_history_on_update on public.deals;
create trigger deals_record_stage_history_on_update
  after update of pipeline_stage_id on public.deals
  for each row
  when (old.pipeline_stage_id is distinct from new.pipeline_stage_id
        and new.pipeline_stage_id is not null)
  execute function public.deals_record_stage_history();

-- ═════════════════════════════════════════════════════════════════════════════════
-- audit — HIGH, whole-row (F2)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The same compensating control 0033 attached to companies/contacts/deals:
-- pipeline configuration changes who can move deals where, which is
-- access-affecting, like the role changes Task 1.11 marks HIGH. The history
-- table's own rows are the movement record; the audit trigger gives the
-- tamper-evident copy.

drop trigger if exists pipelines_audit on public.pipelines;
create trigger pipelines_audit
  after insert or update or delete on public.pipelines
  for each row execute function public.audit_row_change('pipeline', 'HIGH', 'id');

drop trigger if exists pipeline_stages_audit on public.pipeline_stages;
create trigger pipeline_stages_audit
  after insert or update or delete on public.pipeline_stages
  for each row execute function public.audit_row_change('pipeline_stage', 'HIGH', 'id');

drop trigger if exists deal_stage_history_audit on public.deal_stage_history;
create trigger deal_stage_history_audit
  after insert or update or delete on public.deal_stage_history
  for each row execute function public.audit_row_change('deal_stage_history', 'HIGH', 'id');

-- ═════════════════════════════════════════════════════════════════════════════════
-- Seed: one default pipeline per org, mirroring the six legacy deal stages
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Idempotent: orgs that already have a live default pipeline are skipped, and
-- stages are only inserted for default pipelines that have none yet, so a
-- re-run after a partial seed completes the work instead of duplicating it.

insert into public.pipelines (org_id, name, description, is_default)
select o.id, 'Sales Pipeline', 'The default sales pipeline', true
from public.organizations o
where not exists (
  select 1
  from public.pipelines p
  where p.org_id = o.id
    and p.is_default
    and p.deleted_at is null
);

insert into public.pipeline_stages
  (org_id, pipeline_id, name, position, probability, color, is_won, is_lost)
select p.org_id, p.id, s.name, s.position, s.probability, s.color, s.is_won, s.is_lost
from public.pipelines p
cross join (values
  ('NEW',         0,  10, '#6B7280', false, false),
  ('QUALIFIED',   1,  25, '#3B82F6', false, false),
  ('PROPOSAL',    2,  50, '#8B5CF6', false, false),
  ('NEGOTIATION', 3,  75, '#F59E0B', false, false),
  ('WON',         4, 100, '#10B981', true,  false),
  ('LOST',        5,   0, '#EF4444', false, true)
) as s(name, position, probability, color, is_won, is_lost)
where p.is_default
  and p.deleted_at is null
  and not exists (
    select 1
    from public.pipeline_stages ps
    where ps.pipeline_id = p.id
  );

-- ═════════════════════════════════════════════════════════════════════════════════
-- Backfill: every existing deal joins its org's default pipeline
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The legacy text stage names match the seeded stage names exactly, so the
-- join is exact. This fires deals_record_stage_history_on_update once per
-- deal, writing the creation row (from_stage_id NULL, changed_by NULL — the
-- migration runs without an authenticated actor). Rows already backfilled
-- (pipeline_id NOT NULL) are left alone: re-runnable.

update public.deals d
set pipeline_id = p.id,
    pipeline_stage_id = s.id
from public.pipelines p
join public.pipeline_stages s
  on s.pipeline_id = p.id
 and s.name = d.stage
where d.org_id = p.org_id
  and p.is_default
  and p.deleted_at is null
  and d.pipeline_id is null;

-- ═════════════════════════════════════════════════════════════════════════════════
-- deals_pipeline_immutable() — a deal never changes pipeline
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Created AFTER the backfill deliberately: the backfill's NULL → value
-- assignment IS DISTINCT FROM NULL and would be rejected by this trigger.
-- From here on, any attempt to move a deal to another pipeline raises 42501.
-- (Moving between STAGES within the pipeline stays legal — that is what
-- pipeline_stage_id and deal_stage_history are for.)

create or replace function public.deals_pipeline_immutable() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.pipeline_id is distinct from old.pipeline_id then
    raise exception 'pipeline_id is immutable: a deal never changes pipeline'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.deals_pipeline_immutable() is
  'BEFORE UPDATE on deals: pipeline_id may never change once set. Stage '
  'movement within the pipeline is pipeline_stage_id''s job. Raises 42501.';

revoke all on function public.deals_pipeline_immutable() from public;

drop trigger if exists deals_pipeline_immutable on public.deals;
create trigger deals_pipeline_immutable
  before update on public.deals
  for each row execute function public.deals_pipeline_immutable();

-- ═════════════════════════════════════════════════════════════════════════════════
-- crm_soft_delete(): the runtime soft-delete path gains pipelines
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The 0034 function, unchanged except for the one new allowlist mapping.
-- Stages and history stay outside the allowlist deliberately: no runtime
-- delete path exists for them (see the header note).
--
-- M1 (MEDIUM, Phase 2 security review): the function verifies the caller
-- holds the delete permission for the entity INSIDE the function, not just
-- via the service layer's probe. The 0036 header claimed this but the check
-- was reverted before merge (it broke direct-call tests); it is implemented
-- here, in the final definition, covering all 8 allowlisted entities
-- including 'pipeline'.
create or replace function public.crm_soft_delete(p_entity text, p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_perm text;
  v_n bigint;
begin
  v_table := case p_entity
    when 'company' then 'companies'
    when 'contact' then 'contacts'
    when 'deal' then 'deals'
    when 'activity' then 'activities'
    when 'company_contact' then 'company_contacts'
    when 'company_link' then 'company_links'
    when 'contact_link' then 'contact_links'
    when 'pipeline' then 'pipelines'
  end;
  v_perm := case p_entity
    when 'company' then 'companies.delete'
    when 'contact' then 'contacts.delete'
    when 'deal' then 'deals.delete'
    when 'activity' then 'activities.delete'
    when 'company_contact' then 'company_contacts.delete'
    when 'company_link' then 'company_links.delete'
    when 'contact_link' then 'contact_links.delete'
    when 'pipeline' then 'pipelines.delete'
  end;
  if v_table is null then
    raise exception 'unknown soft-delete entity: %', p_entity using errcode = '42501';
  end if;
  -- M1: fail closed unless the caller holds the delete permission. This is
  -- defense-in-depth: the service layer already probes edit rights, but a
  -- SECURITY DEFINER function granted to app_user must not rely on callers
  -- to enforce the permission.
  if not (select authz.has(v_perm)) then
    raise exception 'missing delete permission for %', p_entity using errcode = '42501';
  end if;
  execute format(
    'update public.%I set deleted_at = now(), updated_at = now() '
    'where id = $1 and org_id = authz.org_id() and deleted_at is null',
    v_table
  ) using p_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    -- The service already proved edit rights on this row in this transaction;
    -- reaching here means the row vanished or left the caller's org.
    raise exception 'soft delete affected no rows' using errcode = '02000';
  end if;
end;
$$;

revoke all on function public.crm_soft_delete(text, uuid) from public;
grant execute on function public.crm_soft_delete(text, uuid) to app_user;

-- ═════════════════════════════════════════════════════════════════════════════════
-- permission catalogue — the pipeline keys
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Five keys, resource/action derived from the key exactly as the Task 1.7 seed
-- does. Reads ride on pipelines.view; stage writes need the dedicated
-- pipeline_stages.manage key; pipeline lifecycle is the pipelines.* quartet.

insert into public.permissions (key, resource, action, module, description, is_sensitive)
select
  c.key,
  substring(c.key from '^(.*)\.[^.]+$'),
  substring(c.key from '\.([^.]+)$'),
  c.module,
  c.description,
  c.is_sensitive
from (values
  ('pipelines.view',        'crm', false, 'See pipelines'),
  ('pipelines.create',      'crm', false, 'Create a pipeline'),
  ('pipelines.edit',        'crm', false, 'Change a pipeline'),
  ('pipelines.delete',      'crm', false, 'Delete a pipeline'),
  ('pipeline_stages.manage','crm', false, 'Manage pipeline stages')
) as c(key, module, is_sensitive, description)
on conflict do nothing;

-- ═════════════════════════════════════════════════════════════════════════════════
-- Role-grant matrix fix — the pipeline keys reach SUPER_ADMIN and ADMIN
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The 0033/0034 comment applies verbatim: the catalogue seeds above are not
-- enough on their own — seed_system_roles() grants from a hardcoded VALUES
-- matrix, so the function body below is the 0034 body with the pipeline rows
-- added. SUPER_ADMIN needs no explicit rows: the cross join below grants it
-- every catalogue key except users.impersonate, so the five pipeline keys
-- land automatically for organizations created from here on. ADMIN gets the
-- five keys at GLOBAL explicitly. No other role receives pipeline keys:
-- pipeline configuration is an admin surface. Migration 0034 itself is never
-- edited; it is already applied.

create or replace function public.seed_system_roles(p_org_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.roles (org_id, key, name, description, is_system, is_protected)
  values
    -- is_protected is true for SUPER_ADMIN alone, and it is not a judgement about
    -- seniority: it is the mechanical consequence of blueprint 6.2, which defines a
    -- protected role as one carrying roles.manage or permissions.manage. The matrix
    -- grants those to SUPER_ADMIN and to nobody else.
    (p_org_id, 'SUPER_ADMIN',     'Super Administrator', 'Full access, including role and permission management and security settings', true, true),
    (p_org_id, 'ADMIN',           'Administrator',       'Operational administration. Deliberately NOT a superset of HR: no identity documents, no compensation', true, false),
    (p_org_id, 'HR_ADMIN',        'HR Administrator',    'Full people, HR and hiring administration. No sales pipeline and no audit log', true, false),
    (p_org_id, 'HR_MANAGER',      'HR Manager',          'People and HR administration within their own departments', true, false),
    (p_org_id, 'MANAGER',         'Manager',             'Line management. No permissions are seeded: the architecture defines no matrix column for this role', true, false),
    (p_org_id, 'SALES_MANAGER',   'Sales Manager',       'Sales and delivery leadership across their departments', true, false),
    (p_org_id, 'SALES',           'Sales',               'Own leads, own clients, own tasks', true, false),
    (p_org_id, 'PROJECT_MANAGER', 'Project Manager',     'Projects, tasks and delivery within their departments', true, false),
    (p_org_id, 'DEVELOPER',       'Developer',           'The projects they are assigned to, and their own profile', true, false),
    (p_org_id, 'VIBECODER',       'Vibecoder',           'The projects they are assigned to, and nothing wider', true, false),
    (p_org_id, 'FINANCE',         'Finance',             'Commercial and compensation data. A separate boundary from HR, not a subset of it', true, false),
    (p_org_id, 'MARKETING',       'Marketing',           'No permissions are seeded: the architecture defines no matrix column for this role', true, false),
    (p_org_id, 'INTERN',          'Intern',              'Self and assigned projects only. The legal classification lives on the engagement, never here', true, false),
    (p_org_id, 'EMPLOYEE',        'Employee',            'The baseline every active engagement receives. Self-service only', true, false)
  on conflict do nothing;

  -- SUPER_ADMIN: the whole catalogue at GLOBAL, minus the one permission V1 does not
  -- implement.
  insert into public.role_permissions (role_id, permission_id, scope)
  select r.id, p.id, 'GLOBAL'::public.access_scope
  from public.roles r
  cross join public.permissions p
  where r.org_id = p_org_id
    and r.key = 'SUPER_ADMIN'
    and p.key <> 'users.impersonate'
  on conflict do nothing;

  insert into public.role_permissions (role_id, permission_id, scope)
  select r.id, p.id, m.scope::public.access_scope
  from (values
    -- ADMIN
    ('ADMIN','users.view','GLOBAL'),('ADMIN','users.create','GLOBAL'),
    ('ADMIN','users.suspend','GLOBAL'),('ADMIN','sessions.revoke','GLOBAL'),
    ('ADMIN','departments.manage','GLOBAL'),
    ('ADMIN','people.view','GLOBAL'),('ADMIN','people.edit','GLOBAL'),('ADMIN','people.export','GLOBAL'),
    ('ADMIN','engagements.transition','GLOBAL'),
    ('ADMIN','candidates.view','GLOBAL'),('ADMIN','offers.approve','GLOBAL'),
    ('ADMIN','onboarding.manage','GLOBAL'),('ADMIN','offboarding.initiate','GLOBAL'),
    ('ADMIN','projects.view','GLOBAL'),('ADMIN','projects.create','GLOBAL'),
    ('ADMIN','projects.edit','GLOBAL'),('ADMIN','projects.manage_members','GLOBAL'),
    ('ADMIN','tasks.view','GLOBAL'),('ADMIN','tasks.edit','GLOBAL'),('ADMIN','tasks.assign','GLOBAL'),
    ('ADMIN','documents.view','GLOBAL'),('ADMIN','documents.upload','GLOBAL'),('ADMIN','documents.download','GLOBAL'),
    ('ADMIN','policies.manage','GLOBAL'),('ADMIN','policies.acknowledge','SELF'),
    ('ADMIN','policies.view_compliance','GLOBAL'),
    ('ADMIN','reports.view','GLOBAL'),('ADMIN','audit_logs.view','GLOBAL'),('ADMIN','settings.manage','GLOBAL'),

    -- HR_ADMIN
    ('HR_ADMIN','users.view','GLOBAL'),('HR_ADMIN','users.create','GLOBAL'),
    ('HR_ADMIN','users.suspend','DEPARTMENT'),('HR_ADMIN','sessions.revoke','DEPARTMENT'),
    ('HR_ADMIN','departments.manage','GLOBAL'),
    ('HR_ADMIN','people.view','GLOBAL'),('HR_ADMIN','people.edit','GLOBAL'),('HR_ADMIN','people.export','GLOBAL'),
    ('HR_ADMIN','hr.sensitive.view','GLOBAL'),('HR_ADMIN','compensation.view','GLOBAL'),
    ('HR_ADMIN','engagements.transition','GLOBAL'),
    ('HR_ADMIN','candidates.view','GLOBAL'),('HR_ADMIN','scorecards.view_all','GLOBAL'),
    ('HR_ADMIN','offers.approve','GLOBAL'),
    ('HR_ADMIN','onboarding.manage','GLOBAL'),('HR_ADMIN','offboarding.initiate','GLOBAL'),
    ('HR_ADMIN','documents.view','GLOBAL'),('HR_ADMIN','documents.upload','GLOBAL'),
    ('HR_ADMIN','documents.download','GLOBAL'),('HR_ADMIN','documents.verify','GLOBAL'),
    ('HR_ADMIN','policies.manage','GLOBAL'),('HR_ADMIN','policies.acknowledge','SELF'),
    ('HR_ADMIN','policies.view_compliance','GLOBAL'),('HR_ADMIN','reports.view','GLOBAL'),

    -- HR_MANAGER
    ('HR_MANAGER','users.view','DEPARTMENT'),
    ('HR_MANAGER','people.view','DEPARTMENT'),('HR_MANAGER','people.edit','DEPARTMENT'),
    ('HR_MANAGER','hr.sensitive.view','DEPARTMENT'),
    ('HR_MANAGER','engagements.transition','DEPARTMENT'),
    ('HR_MANAGER','candidates.view','GLOBAL'),('HR_MANAGER','scorecards.view_all','GLOBAL'),
    ('HR_MANAGER','onboarding.manage','DEPARTMENT'),('HR_MANAGER','offboarding.initiate','DEPARTMENT'),
    ('HR_MANAGER','documents.view','DEPARTMENT'),('HR_MANAGER','documents.upload','DEPARTMENT'),
    ('HR_MANAGER','documents.download','DEPARTMENT'),('HR_MANAGER','documents.verify','DEPARTMENT'),
    ('HR_MANAGER','policies.acknowledge','SELF'),('HR_MANAGER','policies.view_compliance','DEPARTMENT'),
    ('HR_MANAGER','reports.view','DEPARTMENT'),

    -- SALES_MANAGER
    ('SALES_MANAGER','people.view','DEPARTMENT'),
    ('SALES_MANAGER','candidates.view','DEPARTMENT'),('SALES_MANAGER','scorecards.view_all','DEPARTMENT'),
    ('SALES_MANAGER','onboarding.manage','DEPARTMENT'),('SALES_MANAGER','offboarding.initiate','DEPARTMENT'),
    ('SALES_MANAGER','projects.view','DEPARTMENT'),('SALES_MANAGER','projects.create','DEPARTMENT'),
    ('SALES_MANAGER','projects.edit','DEPARTMENT'),('SALES_MANAGER','projects.manage_members','DEPARTMENT'),
    ('SALES_MANAGER','tasks.view','DEPARTMENT'),('SALES_MANAGER','tasks.edit','DEPARTMENT'),
    ('SALES_MANAGER','tasks.assign','DEPARTMENT'),
    ('SALES_MANAGER','documents.view','DEPARTMENT'),('SALES_MANAGER','documents.upload','DEPARTMENT'),
    ('SALES_MANAGER','documents.download','DEPARTMENT'),
    ('SALES_MANAGER','policies.acknowledge','SELF'),('SALES_MANAGER','policies.view_compliance','DEPARTMENT'),
    ('SALES_MANAGER','reports.view','DEPARTMENT'),

    -- SALES. tasks.view / tasks.edit are the matrix S+P cells; see the note above.
    ('SALES','people.view','SELF'),('SALES','people.edit','SELF'),
    ('SALES','projects.view','SELF'),
    ('SALES','tasks.view','SELF'),('SALES','tasks.edit','SELF'),
    ('SALES','documents.view','SELF'),('SALES','documents.upload','SELF'),('SALES','documents.download','SELF'),
    ('SALES','policies.acknowledge','SELF'),('SALES','reports.view','SELF'),

    -- PROJECT_MANAGER
    ('PROJECT_MANAGER','people.view','DEPARTMENT'),
    ('PROJECT_MANAGER','candidates.view','DEPARTMENT'),('PROJECT_MANAGER','scorecards.view_all','DEPARTMENT'),
    ('PROJECT_MANAGER','onboarding.manage','DEPARTMENT'),('PROJECT_MANAGER','offboarding.initiate','DEPARTMENT'),
    ('PROJECT_MANAGER','clients.view','DEPARTMENT'),('PROJECT_MANAGER','clients.edit','DEPARTMENT'),
    ('PROJECT_MANAGER','projects.view','DEPARTMENT'),('PROJECT_MANAGER','projects.create','DEPARTMENT'),
    ('PROJECT_MANAGER','projects.edit','DEPARTMENT'),('PROJECT_MANAGER','projects.manage_members','DEPARTMENT'),
    ('PROJECT_MANAGER','tasks.view','DEPARTMENT'),('PROJECT_MANAGER','tasks.edit','DEPARTMENT'),
    ('PROJECT_MANAGER','tasks.assign','DEPARTMENT'),
    ('PROJECT_MANAGER','documents.view','DEPARTMENT'),('PROJECT_MANAGER','documents.upload','DEPARTMENT'),
    ('PROJECT_MANAGER','documents.download','DEPARTMENT'),
    ('PROJECT_MANAGER','policies.acknowledge','SELF'),('PROJECT_MANAGER','policies.view_compliance','DEPARTMENT'),
    ('PROJECT_MANAGER','reports.view','DEPARTMENT'),

    -- DEVELOPER
    ('DEVELOPER','people.view','SELF'),('DEVELOPER','people.edit','SELF'),
    ('DEVELOPER','clients.view','PROJECT'),
    ('DEVELOPER','projects.view','PROJECT'),('DEVELOPER','projects.edit','PROJECT'),
    ('DEVELOPER','tasks.view','PROJECT'),('DEVELOPER','tasks.edit','PROJECT'),('DEVELOPER','tasks.assign','PROJECT'),
    ('DEVELOPER','documents.view','SELF'),('DEVELOPER','documents.upload','SELF'),('DEVELOPER','documents.download','SELF'),
    ('DEVELOPER','policies.acknowledge','SELF'),('DEVELOPER','reports.view','PROJECT'),

    -- VIBECODER
    ('VIBECODER','people.view','SELF'),('VIBECODER','people.edit','SELF'),
    ('VIBECODER','clients.view','PROJECT'),('VIBECODER','projects.view','PROJECT'),
    ('VIBECODER','tasks.view','PROJECT'),('VIBECODER','tasks.edit','PROJECT'),
    ('VIBECODER','documents.view','SELF'),('VIBECODER','documents.upload','SELF'),('VIBECODER','documents.download','SELF'),
    ('VIBECODER','policies.acknowledge','SELF'),

    -- INTERN
    ('INTERN','people.view','SELF'),('INTERN','people.edit','SELF'),
    ('INTERN','hr.sensitive.view','SELF'),
    ('INTERN','clients.view','PROJECT'),('INTERN','projects.view','PROJECT'),
    ('INTERN','tasks.view','SELF'),('INTERN','tasks.edit','SELF'),
    ('INTERN','documents.view','SELF'),('INTERN','documents.upload','SELF'),('INTERN','documents.download','SELF'),
    ('INTERN','policies.acknowledge','SELF'),

    -- FINANCE
    ('FINANCE','people.view','SELF'),('FINANCE','people.edit','SELF'),
    ('FINANCE','compensation.view','GLOBAL'),
    ('FINANCE','clients.view','GLOBAL'),('FINANCE','projects.view','GLOBAL'),
    ('FINANCE','documents.view','GLOBAL'),('FINANCE','documents.upload','GLOBAL'),('FINANCE','documents.download','GLOBAL'),
    ('FINANCE','policies.acknowledge','SELF'),('FINANCE','reports.view','GLOBAL'),

    -- EMPLOYEE
    ('EMPLOYEE','people.view','SELF'),('EMPLOYEE','people.edit','SELF'),
    ('EMPLOYEE','hr.sensitive.view','SELF'),('EMPLOYEE','compensation.view','SELF'),
    ('EMPLOYEE','tasks.view','SELF'),('EMPLOYEE','tasks.edit','SELF'),
    ('EMPLOYEE','documents.view','SELF'),('EMPLOYEE','documents.upload','SELF'),('EMPLOYEE','documents.download','SELF'),
    ('EMPLOYEE','policies.acknowledge','SELF'),

    -- ── Phase 2 CRM Core (migration 0033): the crm module replaces the legacy
    -- sales vocabulary. ADMIN/SALES_MANAGER/SALES get the new keys at the same
    -- scopes the matrix already uses for leads.* / clients.*.
    -- ADMIN
    ('ADMIN','companies.view','GLOBAL'),('ADMIN','companies.create','GLOBAL'),
    ('ADMIN','companies.edit','GLOBAL'),('ADMIN','companies.delete','GLOBAL'),
    ('ADMIN','contacts.view','GLOBAL'),('ADMIN','contacts.create','GLOBAL'),
    ('ADMIN','contacts.edit','GLOBAL'),('ADMIN','contacts.delete','GLOBAL'),
    ('ADMIN','contacts.export','GLOBAL'),
    ('ADMIN','deals.view','GLOBAL'),('ADMIN','deals.create','GLOBAL'),
    ('ADMIN','deals.edit','GLOBAL'),('ADMIN','deals.delete','GLOBAL'),
    ('ADMIN','deals.export','GLOBAL'),
    -- SALES_MANAGER
    ('SALES_MANAGER','companies.view','DEPARTMENT'),('SALES_MANAGER','companies.create','DEPARTMENT'),
    ('SALES_MANAGER','companies.edit','DEPARTMENT'),('SALES_MANAGER','companies.delete','DEPARTMENT'),
    ('SALES_MANAGER','contacts.view','DEPARTMENT'),('SALES_MANAGER','contacts.create','DEPARTMENT'),
    ('SALES_MANAGER','contacts.edit','DEPARTMENT'),('SALES_MANAGER','contacts.delete','DEPARTMENT'),
    ('SALES_MANAGER','contacts.export','DEPARTMENT'),
    ('SALES_MANAGER','deals.view','DEPARTMENT'),('SALES_MANAGER','deals.create','DEPARTMENT'),
    ('SALES_MANAGER','deals.edit','DEPARTMENT'),('SALES_MANAGER','deals.delete','DEPARTMENT'),
    ('SALES_MANAGER','deals.export','DEPARTMENT'),
    -- SALES (SELF on view/create/edit only — mirrors the leads.* SELF column:
    -- no delete, no export, no assign)
    ('SALES','companies.view','SELF'),('SALES','companies.create','SELF'),
    ('SALES','companies.edit','SELF'),
    ('SALES','contacts.view','SELF'),('SALES','contacts.create','SELF'),
    ('SALES','contacts.edit','SELF'),
    ('SALES','deals.view','SELF'),('SALES','deals.create','SELF'),
    ('SALES','deals.edit','SELF'),
    -- ── Track B: activities + relationships (migration 0034). The catalogue keys are
    -- seeded above; the matrix below grants them at the same scopes as the CRM
    -- Core rows: ADMIN at GLOBAL, SALES_MANAGER at DEPARTMENT, SALES at SELF on
    -- view/create/edit only (mirroring the leads.* SELF column: no delete).
    -- ADMIN
    ('ADMIN','activities.view','GLOBAL'),('ADMIN','activities.create','GLOBAL'),
    ('ADMIN','activities.edit','GLOBAL'),('ADMIN','activities.delete','GLOBAL'),
    ('ADMIN','relationships.view','GLOBAL'),('ADMIN','relationships.create','GLOBAL'),
    ('ADMIN','relationships.edit','GLOBAL'),('ADMIN','relationships.delete','GLOBAL'),
    -- SALES_MANAGER
    ('SALES_MANAGER','activities.view','DEPARTMENT'),('SALES_MANAGER','activities.create','DEPARTMENT'),
    ('SALES_MANAGER','activities.edit','DEPARTMENT'),('SALES_MANAGER','activities.delete','DEPARTMENT'),
    ('SALES_MANAGER','relationships.view','DEPARTMENT'),('SALES_MANAGER','relationships.create','DEPARTMENT'),
    ('SALES_MANAGER','relationships.edit','DEPARTMENT'),('SALES_MANAGER','relationships.delete','DEPARTMENT'),
    -- SALES (SELF on view/create/edit only — mirrors the leads.* SELF column)
    ('SALES','activities.view','SELF'),('SALES','activities.create','SELF'),
    ('SALES','activities.edit','SELF'),
    ('SALES','relationships.view','SELF'),('SALES','relationships.create','SELF'),
    ('SALES','relationships.edit','SELF'),
    -- ── Phase 3 sales pipeline (migration 0037): pipeline configuration is an
    -- admin surface. ADMIN holds the five keys at GLOBAL; SUPER_ADMIN gets them
    -- through the whole-catalogue cross join above. No other role is granted
    -- pipeline keys.
    -- ADMIN
    ('ADMIN','pipelines.view','GLOBAL'),('ADMIN','pipelines.create','GLOBAL'),
    ('ADMIN','pipelines.edit','GLOBAL'),('ADMIN','pipelines.delete','GLOBAL'),
    ('ADMIN','pipeline_stages.manage','GLOBAL')
  ) as m(role_key, permission_key, scope)
  join public.roles r on r.org_id = p_org_id and r.key = m.role_key
  join public.permissions p on p.key = m.permission_key
  on conflict do nothing;
end;
$$;

-- ── Backfill: existing organizations ──────────────────────────────────────────
--
-- The protection trigger guards runtime changes to the authorization model, which
-- a migration is not, so it is disabled for the insert and re-enabled immediately
-- — the same pattern migrations 0010, 0033 and 0034 used.
--
-- 10 grants per org: SUPER_ADMIN 5 + ADMIN 5, all at GLOBAL. Only the five new
-- keys' grants are inserted — no legacy cleanup, no re-seeding of existing
-- grants (on conflict do nothing).

alter table public.role_permissions disable trigger role_permissions_enforce_protection;

insert into public.role_permissions (role_id, permission_id, scope)
select r.id, p.id, m.scope::public.access_scope
from public.roles r
cross join public.permissions p
join (values
  ('SUPER_ADMIN','pipelines.view','GLOBAL'),('SUPER_ADMIN','pipelines.create','GLOBAL'),
  ('SUPER_ADMIN','pipelines.edit','GLOBAL'),('SUPER_ADMIN','pipelines.delete','GLOBAL'),
  ('SUPER_ADMIN','pipeline_stages.manage','GLOBAL'),
  ('ADMIN','pipelines.view','GLOBAL'),('ADMIN','pipelines.create','GLOBAL'),
  ('ADMIN','pipelines.edit','GLOBAL'),('ADMIN','pipelines.delete','GLOBAL'),
  ('ADMIN','pipeline_stages.manage','GLOBAL')
) as m(role_key, permission_key, scope)
  on r.key = m.role_key and p.key = m.permission_key
on conflict do nothing;

alter table public.role_permissions enable trigger role_permissions_enforce_protection;

-- ── Verification ──────────────────────────────────────────────────────────────
--
-- Fail the migration rather than leave a half-seeded authorization model: all
-- five catalogue keys must exist, and every org's SUPER_ADMIN and ADMIN system
-- roles must hold all five grants. (Future orgs are covered by the cross join
-- in seed_system_roles(); this checks the orgs that already exist.)

do $$
declare
  v_missing_keys int;
  v_missing_grants int;
begin
  select count(*) into v_missing_keys
  from (values
    ('pipelines.view'),
    ('pipelines.create'),
    ('pipelines.edit'),
    ('pipelines.delete'),
    ('pipeline_stages.manage')
  ) as k(key)
  where not exists (
    select 1 from public.permissions p where p.key = k.key
  );
  if v_missing_keys > 0 then
    raise exception 'pipeline permission catalogue incomplete: % of 5 keys missing',
      v_missing_keys;
  end if;

  select count(*) into v_missing_grants
  from public.roles r
  cross join (values
    ('pipelines.view'),
    ('pipelines.create'),
    ('pipelines.edit'),
    ('pipelines.delete'),
    ('pipeline_stages.manage')
  ) as k(key)
  where r.key in ('SUPER_ADMIN', 'ADMIN')
    and r.is_system
    and not exists (
      select 1
      from public.role_permissions rp
      join public.permissions p on p.id = rp.permission_id
      where rp.role_id = r.id
        and p.key = k.key
    );
  if v_missing_grants > 0 then
    raise exception 'pipeline role grants incomplete: % role/key pairs missing',
      v_missing_grants;
  end if;
end
$$;
