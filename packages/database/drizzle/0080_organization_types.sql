-- ═════════════════════════════════════════════════════════════════════════════════
-- PRAVSHI OS — 0080: organization types and versioned organization templates
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS ADDS
--
-- Every organization now has an operating TYPE (Generic CRM, Real Estate CRM, Education
-- CRM, …) chosen from a controlled catalog, and is created from a VERSIONED TEMPLATE of
-- that type. One application and one database serve every industry: a type changes the
-- configuration an organization is born with, never the code path or the data model.
--
--   public.organization_types           the catalog: a stable key, display metadata and
--                                       a status (ACTIVE / DISABLED). Global, not tenant
--                                       data — like public.permissions.
--   public.organization_type_templates  (type, version) → a JSON definition of what an
--                                       organization of that type starts with. DRAFT →
--                                       PUBLISHED → RETIRED; a published version is
--                                       immutable, so an organization's recorded version
--                                       always means the same thing.
--   organizations.type_key, .template_version
--                                       what each organization was created from.
--
-- WHAT A TEMPLATE CONFIGURES (definition schema v1)
--
--   { "pipelines": [ { "name", "description", "is_default",
--                      "stages": [ { "name", "probability", "color", "is_won", "is_lost" } ] } ] }
--
-- Pipelines and their stages are the configuration this schema already models per
-- organization (0037). Modules, fields, dashboards and roles are NOT modelled here: no
-- module or custom-field system exists yet, and the 14 system roles are seeded
-- identically for every organization (0008). Adding them is a later, separately approved
-- schema version — the definition is versioned so that can happen without rewriting.
--
-- WHAT DOES NOT CHANGE
--
--   * Existing organizations become `generic_crm` version 1 (column default; no
--     rewrite). generic_crm v1 is exactly the six legacy stages seed_default_pipeline()
--     has created since 0039, so new organizations without an explicit type are born
--     exactly as before.
--   * Real Estate CRM and Education CRM are catalogued DISABLED, with no template: their
--     pipelines and stages are a product decision. A disabled type cannot be chosen.
--   * Nothing here is reachable by a runtime write: app_user can read the catalog only.
--     Templates are read by SECURITY DEFINER functions owned by the table owner.
--     upgrade_organization_template() is executable by no runtime role yet; the platform
--     provisioning role (separately approved) will be its caller.
--
-- Rollback: scripts/db/rollback/0080_organization_types.down.sql restores 0079 exactly.

set local lock_timeout = '5s';

-- ── 1. The catalog ───────────────────────────────────────────────────────────────

create table public.organization_types (
  key text primary key,
  display_name text not null,
  description text not null default '',
  status text not null default 'DISABLED',
  created_at timestamptz not null default now(),
  constraint organization_types_key_format check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  constraint organization_types_display_name_not_blank check (length(btrim(display_name)) > 0),
  constraint organization_types_status_valid check (status in ('ACTIVE', 'DISABLED'))
);

comment on table public.organization_types is
  'The controlled catalog of organization operating types (0080). Global, not tenant data. '
  'A DISABLED type cannot be chosen for a new organization.';

-- ── 2. Versioned templates ───────────────────────────────────────────────────────

create function public.organization_template_definition_valid(p_definition jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  -- Definition schema v1: a non-empty pipelines array; exactly one default pipeline;
  -- every pipeline named, with at least one stage; every stage named, probability 0–100,
  -- an optional #RRGGBB colour, never both won and lost; stage names unique per pipeline;
  -- pipeline names unique.
  select coalesce(
    jsonb_typeof(p_definition) = 'object'
    and jsonb_typeof(p_definition -> 'pipelines') = 'array'
    and jsonb_array_length(p_definition -> 'pipelines') > 0
    and (select count(*) from jsonb_array_elements(p_definition -> 'pipelines') p
          where (p -> 'is_default') = 'true'::jsonb) = 1
    and (select count(distinct p ->> 'name') = count(*)
           from jsonb_array_elements(p_definition -> 'pipelines') p)
    and not exists (
      select 1 from jsonb_array_elements(p_definition -> 'pipelines') p
       where jsonb_typeof(p -> 'name') <> 'string'
          or length(btrim(p ->> 'name')) = 0
          or jsonb_typeof(p -> 'stages') <> 'array'
          or jsonb_array_length(p -> 'stages') = 0
          or (select count(distinct s ->> 'name') <> count(*)
                from jsonb_array_elements(p -> 'stages') s)
          or exists (
            select 1 from jsonb_array_elements(p -> 'stages') s
             where jsonb_typeof(s -> 'name') <> 'string'
                or length(btrim(s ->> 'name')) = 0
                or jsonb_typeof(s -> 'probability') <> 'number'
                or case when jsonb_typeof(s -> 'probability') = 'number'
                        then (s ->> 'probability')::numeric not between 0 and 100 else true end
                or (s ? 'color' and jsonb_typeof(s -> 'color') <> 'null'
                    and coalesce(s ->> 'color', '') !~ '^#[0-9a-fA-F]{6}$')
                or ((s -> 'is_won') = 'true'::jsonb and (s -> 'is_lost') = 'true'::jsonb))),
    false);
$$;

comment on function public.organization_template_definition_valid(jsonb) is
  'Validates an organization template definition (schema v1, 0080). Used by the '
  'organization_type_templates CHECK for every published or retired version.';

create table public.organization_type_templates (
  type_key text not null references public.organization_types (key),
  version integer not null,
  status text not null default 'DRAFT',
  definition jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  primary key (type_key, version),
  constraint organization_type_templates_version_positive check (version >= 1),
  constraint organization_type_templates_status_valid
    check (status in ('DRAFT', 'PUBLISHED', 'RETIRED')),
  constraint organization_type_templates_published_valid
    check (status = 'DRAFT' or (published_at is not null
                                and public.organization_template_definition_valid(definition)))
);

comment on table public.organization_type_templates is
  'Versioned templates for organization types (0080). DRAFT → PUBLISHED → RETIRED; a '
  'published or retired version is immutable and cannot be deleted.';

create function public.organization_type_templates_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'organization templates cannot be truncated' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'DRAFT' then
      raise exception 'a published or retired organization template cannot be deleted'
        using errcode = '23514';
    end if;
    return old;
  end if;
  -- UPDATE
  if old.status = 'DRAFT' then
    if new.status = 'RETIRED' then
      raise exception 'a draft template is published before it is retired' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.type_key is distinct from old.type_key
     or new.version is distinct from old.version
     or new.definition is distinct from old.definition
     or new.published_at is distinct from old.published_at
     or new.created_at is distinct from old.created_at then
    raise exception 'a published organization template is immutable; publish a new version'
      using errcode = '23514';
  end if;
  if not (old.status = new.status or (old.status = 'PUBLISHED' and new.status = 'RETIRED')) then
    raise exception 'organization template status can only move DRAFT → PUBLISHED → RETIRED'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger organization_type_templates_guard
  before update or delete on public.organization_type_templates
  for each row execute function public.organization_type_templates_guard();
create trigger organization_type_templates_no_truncate
  before truncate on public.organization_type_templates
  for each statement execute function public.organization_type_templates_guard();

-- ── 3. The seed catalog and generic_crm v1 (exactly the 0039 default pipeline) ───

insert into public.organization_types (key, display_name, description, status) values
  ('generic_crm', 'Generic CRM',
   'A general business CRM: one default sales pipeline. Every organization created before '
   'organization types existed is of this type.', 'ACTIVE'),
  ('real_estate_crm', 'Real Estate CRM',
   'Disabled until its template (pipelines and stages) is approved.', 'DISABLED'),
  ('education_crm', 'Education CRM',
   'Disabled until its template (pipelines and stages) is approved.', 'DISABLED');

insert into public.organization_type_templates (type_key, version, status, definition, published_at)
values ('generic_crm', 1, 'PUBLISHED', jsonb_build_object('pipelines', jsonb_build_array(
  jsonb_build_object(
    'name', 'Sales Pipeline',
    'description', 'The default sales pipeline',
    'is_default', true,
    'stages', jsonb_build_array(
      jsonb_build_object('name', 'NEW',         'probability', 10,  'color', '#6B7280', 'is_won', false, 'is_lost', false),
      jsonb_build_object('name', 'QUALIFIED',   'probability', 25,  'color', '#3B82F6', 'is_won', false, 'is_lost', false),
      jsonb_build_object('name', 'PROPOSAL',    'probability', 50,  'color', '#8B5CF6', 'is_won', false, 'is_lost', false),
      jsonb_build_object('name', 'NEGOTIATION', 'probability', 75,  'color', '#F59E0B', 'is_won', false, 'is_lost', false),
      jsonb_build_object('name', 'WON',         'probability', 100, 'color', '#10B981', 'is_won', true,  'is_lost', false),
      jsonb_build_object('name', 'LOST',        'probability', 0,   'color', '#EF4444', 'is_won', false, 'is_lost', true)
    )
  ))), now());

-- ── 4. Organizations record what they were created from ──────────────────────────
--
-- A constant default adds the columns without a table rewrite; every existing row reads
-- generic_crm / 1, which is exactly what those organizations were seeded with.

alter table public.organizations
  add column type_key text not null default 'generic_crm',
  add column template_version integer not null default 1,
  add constraint organizations_type_fk
    foreign key (type_key) references public.organization_types (key),
  add constraint organizations_template_fk
    foreign key (type_key, template_version)
    references public.organization_type_templates (type_key, version);

create index organizations_type_idx on public.organizations (type_key);

create function public.organizations_type_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type_status text;
  v_template_status text;
begin
  if tg_op = 'UPDATE' then
    if new.type_key is distinct from old.type_key then
      raise exception 'an organization''s type is fixed once it is created' using errcode = '23514';
    end if;
    if new.template_version is distinct from old.template_version
       and new.template_version < old.template_version then
      raise exception 'an organization''s template version cannot go backwards'
        using errcode = '23514';
    end if;
    if new.template_version is not distinct from old.template_version then
      return new;
    end if;
  end if;
  select t.status into v_type_status from public.organization_types t where t.key = new.type_key;
  if tg_op = 'INSERT' and v_type_status is distinct from 'ACTIVE' then
    raise exception 'organization type % is not available', new.type_key using errcode = '23514';
  end if;
  select tt.status into v_template_status
    from public.organization_type_templates tt
   where tt.type_key = new.type_key and tt.version = new.template_version;
  if v_template_status is distinct from 'PUBLISHED' then
    raise exception 'organization template % version % is not published',
      new.type_key, new.template_version using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.organizations_type_guard() is
  'An organization is created only from an ACTIVE type and a PUBLISHED template version; '
  'its type never changes and its template version only moves forward to another '
  'published version of the same type (0080).';

revoke all on function public.organizations_type_guard() from public;

create trigger organizations_type_guard
  before insert or update of type_key, template_version on public.organizations
  for each row execute function public.organizations_type_guard();

-- ── 5. Seeding from the template ─────────────────────────────────────────────────
--
-- seed_default_pipeline() keeps its signature, its idempotence and its callers (the 0039
-- backfill path and organizations_seed_system_roles for every new organization). It now
-- builds the organization's pipelines from its recorded template. For generic_crm v1 the
-- result is identical to 0039's: one default 'Sales Pipeline' with the six legacy stages.

create function public.seed_template_pipelines(p_org_id uuid, p_definition jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p jsonb;
  v_pipeline_id uuid;
begin
  -- Additive: a pipeline whose name the organization already has (live) is skipped.
  for p in select value from jsonb_array_elements(p_definition -> 'pipelines') loop
    if exists (select 1 from public.pipelines x
                where x.org_id = p_org_id and x.name = p ->> 'name' and x.deleted_at is null) then
      continue;
    end if;
    if coalesce((p -> 'is_default') = 'true'::jsonb, false)
       and exists (select 1 from public.pipelines x
                    where x.org_id = p_org_id and x.is_default and x.deleted_at is null) then
      continue;
    end if;
    insert into public.pipelines (org_id, name, description, is_default)
    values (p_org_id, p ->> 'name', coalesce(p ->> 'description', ''),
            coalesce((p -> 'is_default') = 'true'::jsonb, false))
    returning id into v_pipeline_id;
    insert into public.pipeline_stages
      (org_id, pipeline_id, name, position, probability, color, is_won, is_lost)
    select p_org_id, v_pipeline_id, s.value ->> 'name', (s.ordinality - 1)::integer,
           (s.value ->> 'probability')::numeric, s.value ->> 'color',
           coalesce((s.value -> 'is_won') = 'true'::jsonb, false),
           coalesce((s.value -> 'is_lost') = 'true'::jsonb, false)
      from jsonb_array_elements(p -> 'stages') with ordinality as s(value, ordinality);
  end loop;
end;
$$;

revoke all on function public.seed_template_pipelines(uuid, jsonb) from public;

create or replace function public.seed_default_pipeline(p_org_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pipeline_id uuid;
  v_definition jsonb;
begin
  -- Idempotent: an org that already has a live default keeps it, untouched.
  select p.id into v_pipeline_id
  from public.pipelines p
  where p.org_id = p_org_id and p.is_default and p.deleted_at is null
  limit 1;
  if v_pipeline_id is not null then
    return v_pipeline_id;
  end if;

  select tt.definition into v_definition
    from public.organizations o
    join public.organization_type_templates tt
      on tt.type_key = o.type_key and tt.version = o.template_version
   where o.id = p_org_id;
  if v_definition is null then
    raise exception 'organization % has no template to seed from', p_org_id using errcode = '23514';
  end if;

  perform public.seed_template_pipelines(p_org_id, v_definition);

  select p.id into v_pipeline_id
  from public.pipelines p
  where p.org_id = p_org_id and p.is_default and p.deleted_at is null
  limit 1;
  return v_pipeline_id;
end;
$$;

comment on function public.seed_default_pipeline(uuid) is
  'Idempotent: seeds an organization''s pipelines from its organization template (0080; '
  'generic_crm v1 = the six legacy stages of 0039) when it lacks a live default; returns '
  'the existing default''s id otherwise.';

revoke all on function public.seed_default_pipeline(uuid) from public;

-- ── 6. Safe template upgrades: additive only ─────────────────────────────────────

create function public.upgrade_organization_template(p_org_id uuid, p_version integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
  v_current integer;
  v_definition jsonb;
begin
  select o.type_key, o.template_version into v_type, v_current
    from public.organizations o where o.id = p_org_id for update;
  if v_type is null then
    raise exception 'organization % not found', p_org_id using errcode = 'P0002';
  end if;
  if p_version <= v_current then
    raise exception 'organization % is already at template version %', p_org_id, v_current
      using errcode = '23514';
  end if;
  select tt.definition into v_definition
    from public.organization_type_templates tt
   where tt.type_key = v_type and tt.version = p_version and tt.status = 'PUBLISHED';
  if v_definition is null then
    raise exception 'template % version % is not published', v_type, p_version
      using errcode = '23514';
  end if;
  -- Adds only what the organization lacks; never changes or removes its data.
  perform public.seed_template_pipelines(p_org_id, v_definition);
  update public.organizations set template_version = p_version where id = p_org_id;
  return p_version;
end;
$$;

comment on function public.upgrade_organization_template(uuid, integer) is
  'Moves one organization to a newer PUBLISHED version of its own type, adding the '
  'template''s missing pipelines and never modifying or removing existing data (0080). '
  'Executable by no runtime role: the platform provisioning role will be its caller.';

revoke all on function public.upgrade_organization_template(uuid, integer) from public;

-- ── 7. Access: forced RLS; app_user reads the catalog and nothing else here ──────

alter table public.organization_types enable row level security;
alter table public.organization_types force row level security;
alter table public.organization_type_templates enable row level security;
alter table public.organization_type_templates force row level security;

create policy organization_types_owner_all on public.organization_types
  for all to app_owner using (true) with check (true);
create policy organization_types_select_all on public.organization_types
  for select to app_user using (true);
create policy organization_type_templates_owner_all on public.organization_type_templates
  for all to app_owner using (true) with check (true);

-- roles.sql's default privileges grant app_user select/insert/update on every new table;
-- take back what it must not hold. (RLS is the durable control — see roles.sql.)
revoke insert, update, delete on public.organization_types from app_user, app_admin;
revoke all on public.organization_type_templates from app_user, app_admin;

-- ── Verification: the migration fails rather than leave a gap ────────────────────

do $$
begin
  if exists (select 1 from public.organizations o
              where not exists (select 1 from public.organization_type_templates tt
                                 where tt.type_key = o.type_key and tt.version = o.template_version
                                   and tt.status = 'PUBLISHED')) then
    raise exception '0080: an organization is not on a published template';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public'
                and c.relname in ('organization_types', 'organization_type_templates')
                and not (c.relrowsecurity and c.relforcerowsecurity)) then
    raise exception '0080: RLS is not forced on the organization type tables';
  end if;
  if has_table_privilege('app_user', 'public.organization_types', 'INSERT')
     or has_table_privilege('app_user', 'public.organization_types', 'UPDATE')
     or has_table_privilege('app_user', 'public.organization_type_templates', 'SELECT') then
    raise exception '0080: app_user holds a privilege it must not hold';
  end if;
  if (select count(*) from public.organization_type_templates
       where status = 'PUBLISHED'
         and not public.organization_template_definition_valid(definition)) > 0 then
    raise exception '0080: a published template definition is invalid';
  end if;
end
$$;
