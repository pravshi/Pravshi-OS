-- ═════════════════════════════════════════════════════════════════════════════
-- 0088_crm_import_decisions — duplicate decisions for a Sales Sheet import
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A possible duplicate (0081: a company matched by name only, a contact by name under the same
-- company, a deal by title + company + contact) is decided once per ENTITY, not per row:
--
--   COMPANY / CONTACT  LINK_EXISTING | CREATE_NEW | SKIP
--   DEAL               CREATE_NEW | SKIP
--
-- Every row naming the entity follows its decision; the preview is recomputed from the recorded
-- rows and the decisions (src/lib/import/sales-sheet/preview.ts planPreview). An undecided
-- possible duplicate is skipped at commit: nothing is created as a duplicate without a decision.
--
-- Decisions are made by the importer, while the import is PREVIEWED, and are frozen from
-- confirmation on. The confirmation also records the plan the user confirmed, row by row
-- (crm_import_row_plans): skip, or link to the existing company / contact a "use the existing"
-- decision resolved to — by id, resolved at confirmation. The commit applies exactly that plan
-- (the batch path included), so a commit retry, or records the import itself created, never
-- change what a row does. Additive: no change to 0081's tables; crm_import_rows' recorded plan
-- stays immutable.
-- ═════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';

create table public.crm_import_decisions (
  org_id uuid not null,
  import_id uuid not null,
  kind text not null,
  entity_key text not null,
  decision text not null,
  decided_by uuid not null,
  decided_at timestamptz not null default now(),
  primary key (import_id, kind, entity_key),
  constraint crm_import_decisions_import_fk foreign key (import_id, org_id)
    references public.crm_imports (id, org_id),
  constraint crm_import_decisions_decider_fk foreign key (decided_by, org_id)
    references public.people (id, org_id),
  constraint crm_import_decisions_kind_valid check (kind in ('COMPANY', 'CONTACT', 'DEAL')),
  constraint crm_import_decisions_decision_valid check (
    decision in ('LINK_EXISTING', 'CREATE_NEW', 'SKIP')
    and (kind <> 'DEAL' or decision <> 'LINK_EXISTING')),
  constraint crm_import_decisions_key_format check (
    length(entity_key) between 3 and 1200 and entity_key !~ '[[:cntrl:]]')
);

comment on table public.crm_import_decisions is
  'Duplicate decisions of a Sales Sheet import (0088): one per company, contact or deal key; '
  'made by the importer while PREVIEWED, frozen from confirmation.';

create function public.crm_import_decisions_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := authz.person_id();
  v_row public.crm_import_decisions;
  v_status text;
  v_creator uuid;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  -- One refusal for every reason, as for the import rows (0081).
  if v_person is null or v_row.org_id is distinct from authz.org_id() then
    raise exception 'crm_import_decisions: not permitted' using errcode = '42501';
  end if;
  select i.status, i.created_by into v_status, v_creator
  from public.crm_imports i
  where i.id = v_row.import_id and i.org_id = v_row.org_id
  for share;
  if not found or v_person is distinct from v_creator then
    raise exception 'crm_import_decisions: not permitted' using errcode = '42501';
  end if;
  if v_status <> 'PREVIEWED' then
    raise exception 'crm_import_decisions: decisions are made before the import is confirmed'
      using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.org_id is distinct from old.org_id
     or new.import_id is distinct from old.import_id or new.kind is distinct from old.kind
     or new.entity_key is distinct from old.entity_key) then
    raise exception 'crm_import_decisions: only the decision itself changes' using errcode = '23514';
  end if;
  new.decided_by := v_person;
  new.decided_at := now();
  return new;
end;
$$;

comment on function public.crm_import_decisions_guard() is
  'BEFORE INSERT/UPDATE/DELETE on crm_import_decisions (0088): only the importer, only while '
  'the import is PREVIEWED; the decider and time are stamped, never supplied.';

revoke all on function public.crm_import_decisions_guard() from public;

create trigger crm_import_decisions_guard
  before insert or update or delete on public.crm_import_decisions
  for each row execute function public.crm_import_decisions_guard();

create table public.crm_import_row_plans (
  org_id uuid not null,
  import_id uuid not null,
  row_number integer not null,
  skip boolean not null,
  company_existing_id uuid,
  contact_existing_id uuid,
  primary key (import_id, row_number),
  constraint crm_import_row_plans_import_fk foreign key (import_id, org_id)
    references public.crm_imports (id, org_id),
  constraint crm_import_row_plans_row_fk foreign key (import_id, row_number)
    references public.crm_import_rows (import_id, row_number),
  constraint crm_import_row_plans_company_fk foreign key (company_existing_id, org_id)
    references public.companies (id, org_id),
  constraint crm_import_row_plans_contact_fk foreign key (contact_existing_id, org_id)
    references public.contacts (id, org_id),
  constraint crm_import_row_plans_skip_alone
    check (not skip or (company_existing_id is null and contact_existing_id is null))
);

comment on table public.crm_import_row_plans is
  'The confirmed plan of a decided Sales Sheet import (0088): per row, skip, or the existing '
  'company/contact a decision chose (by id). Written once by the confirmation; immutable.';

create function public.crm_import_row_plans_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := authz.person_id();
  v_status text;
  v_creator uuid;
begin
  if tg_op <> 'INSERT' then
    raise exception 'crm_import_row_plans: a confirmed plan is immutable' using errcode = '23514';
  end if;
  if v_person is null or new.org_id is distinct from authz.org_id() then
    raise exception 'crm_import_row_plans: not permitted' using errcode = '42501';
  end if;
  select i.status, i.created_by into v_status, v_creator
  from public.crm_imports i
  where i.id = new.import_id and i.org_id = new.org_id
  for share;
  if not found or v_person is distinct from v_creator then
    raise exception 'crm_import_row_plans: not permitted' using errcode = '42501';
  end if;
  if v_status <> 'PREVIEWED' then
    raise exception 'crm_import_row_plans: the plan is recorded by the confirmation'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.crm_import_row_plans_guard() is
  'BEFORE INSERT/UPDATE/DELETE on crm_import_row_plans (0088): only the importer inserts, only '
  'while the import is PREVIEWED (the confirmation); never updated or deleted.';

revoke all on function public.crm_import_row_plans_guard() from public;

create trigger crm_import_row_plans_guard
  before insert or update or delete on public.crm_import_row_plans
  for each row execute function public.crm_import_row_plans_guard();

alter table public.crm_import_row_plans enable row level security;
alter table public.crm_import_row_plans force row level security;

create policy crm_import_row_plans_owner_all on public.crm_import_row_plans
  for all to app_owner using (true) with check (true);
create policy crm_import_row_plans_select on public.crm_import_row_plans
  for select to app_user
  using (org_id = (select authz.org_id()) and (select authz.is_active())
         and (select authz.has('crm.import'))
         and ((select authz.scope_for('crm.import')) = 'GLOBAL'
              or exists (select 1 from public.crm_imports i
                          where i.id = crm_import_row_plans.import_id
                            and i.created_by = (select authz.person_id()))));
create policy crm_import_row_plans_insert on public.crm_import_row_plans
  for insert to app_user
  with check (org_id = (select authz.org_id()) and (select authz.is_active())
              and (select authz.has('crm.import')));

revoke update, delete, truncate on public.crm_import_row_plans from app_user;
revoke all on public.crm_import_row_plans from app_admin, app_worker, app_auth, app_platform;

alter table public.crm_import_decisions enable row level security;
alter table public.crm_import_decisions force row level security;

create policy crm_import_decisions_owner_all on public.crm_import_decisions
  for all to app_owner using (true) with check (true);

-- The same reach as the import's rows (0081): a GLOBAL holder of crm.import, or the importer.
create policy crm_import_decisions_select on public.crm_import_decisions
  for select to app_user
  using (org_id = (select authz.org_id()) and (select authz.is_active())
         and (select authz.has('crm.import'))
         and ((select authz.scope_for('crm.import')) = 'GLOBAL'
              or exists (select 1 from public.crm_imports i
                          where i.id = crm_import_decisions.import_id
                            and i.created_by = (select authz.person_id()))));
create policy crm_import_decisions_insert on public.crm_import_decisions
  for insert to app_user
  with check (org_id = (select authz.org_id()) and (select authz.is_active())
              and (select authz.has('crm.import')));
create policy crm_import_decisions_update on public.crm_import_decisions
  for update to app_user
  using (org_id = (select authz.org_id()) and (select authz.is_active())
         and (select authz.has('crm.import')))
  with check (org_id = (select authz.org_id()));
create policy crm_import_decisions_delete on public.crm_import_decisions
  for delete to app_user
  using (org_id = (select authz.org_id()) and (select authz.is_active())
         and (select authz.has('crm.import')));

-- roles.sql's default privileges give app_user select, insert and update; clearing a decision
-- is a DELETE, bounded by the guard (importer, PREVIEWED) and the policy above.
grant delete on public.crm_import_decisions to app_user;
revoke truncate on public.crm_import_decisions from app_user;
revoke all on public.crm_import_decisions from app_admin, app_worker, app_auth, app_platform;

do $$
begin
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('crm_import_decisions', 'crm_import_row_plans')
        and c.relrowsecurity and c.relforcerowsecurity) <> 2 then
    raise exception '0088: an import decision table without forced RLS';
  end if;
  if exists (select 1 from information_schema.role_table_grants g
             where g.table_schema = 'public'
               and g.table_name in ('crm_import_decisions', 'crm_import_row_plans')
               and g.grantee in ('app_admin', 'app_worker', 'app_auth', 'app_platform', 'PUBLIC')) then
    raise exception '0088: an import decision table is reachable beyond app_user';
  end if;
  -- app_user: decisions select/insert/update/delete; plans select/insert only; never truncate.
  if (select string_agg(privilege_type, ',' order by privilege_type)
      from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'crm_import_decisions'
        and grantee = 'app_user') is distinct from 'DELETE,INSERT,SELECT,UPDATE'
     or (select string_agg(privilege_type, ',' order by privilege_type)
         from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'crm_import_row_plans'
           and grantee = 'app_user') is distinct from 'INSERT,SELECT' then
    raise exception '0088: app_user privileges on the import decision tables are not as designed';
  end if;
end;
$$;
