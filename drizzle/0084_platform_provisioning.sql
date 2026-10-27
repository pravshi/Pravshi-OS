-- ═════════════════════════════════════════════════════════════════════════════
-- 0084_platform_provisioning — organization provisioning and suspend/reactivate (ADR-008)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Package P2 and decision L1 of the platform design
-- (docs/architecture/proposals/2026-10-27-platform-administration-v1-minimum.md). Builds on
-- 0083's platform identity: every function here runs on the app_platform connection, re-derives
-- the acting administrator through platform.require_permission(), and writes exactly one
-- platform audit entry in the same transaction as its change.
--
-- PROVISIONING creates, in one transaction, what the organization bootstrap (0015) creates —
-- the organization (from an ACTIVE type and its latest PUBLISHED template; the existing
-- triggers seed its system roles and its template's pipelines), the Executive department, the
-- first administrator as an ACTIVE person with an ACTIVE engagement and SUPER_ADMIN through the
-- protected-role genesis branch (app_platform is one of its named callers since 0083) — and a
-- setup token for that administrator.
--
-- WHY A SETUP TOKEN, NOT AN INVITATION (design reconciliation, ADR-008 P-1). The design named
-- the invitation machinery (0018), but an invitation's invited_by must be a person of the
-- organization, taken from the transaction identity: a platform administrator is not one. The
-- organization's first SUPER_ADMIN is therefore given exactly what the bootstrapped one gets: a
-- single-use, expiring setup token whose digest alone is stored, completed on the auth plane
-- (app_auth), which creates the person's own login — never adopting an existing one (GOV-02).
--
-- IDEMPOTENCY. A request carries a key. The same key with the same parameters returns the
-- stored organization without writing anything (the raw setup link is never returned again —
-- re-issue it); the same key with other parameters is refused.
--
-- LIFECYCLE (L1). ACTIVE ⇄ SUSPENDED, a reason each way. A suspended organization's members are
-- refused on every request (authz.is_active(), 0002/0017) and its background work is not
-- claimed (0068); both resume on reactivation. Archive and restore are V1.1.
--
--   PART 1  lifecycle columns; provisioning requests; organization administrator setup tokens
--   PART 2  read-only views for the console: organizations, available types
--   PART 3  provisioning
--   PART 4  first-administrator setup re-issue and completion
--   PART 5  suspend and reactivate
--   PART 6  privileges and verification
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — tables
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.organizations
  add column suspended_at timestamptz,
  add column suspended_by uuid references platform.admins (id),
  add column suspension_reason text,
  add constraint organizations_suspension_only_when_suspended
    check (suspended_at is null or status = 'SUSPENDED'),
  add constraint organizations_suspension_reason_valid
    check (suspension_reason is null or length(btrim(suspension_reason)) between 3 and 500);

comment on column public.organizations.suspended_at is
  'When a platform administrator suspended the organization (0084); NULL while ACTIVE.';

create table platform.provisioning_requests (
  idempotency_key text primary key,
  params_digest text not null,
  admin_id uuid not null references platform.admins (id),
  org_id uuid not null references public.organizations (id),
  person_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint provisioning_requests_key_format check (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  constraint provisioning_requests_digest_format check (params_digest ~ '^[0-9a-f]{64}$')
);

-- The provisioned organization's first administrator: one live setup credential per
-- organization, consumed once by platform.complete_org_admin_setup().
create table platform.org_admin_setup (
  org_id uuid primary key references public.organizations (id),
  person_id uuid not null,
  token_hash bytea not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_auth_user_id uuid references auth.auth_users (id),
  constraint org_admin_setup_person_same_org foreign key (person_id, org_id)
    references public.people (id, org_id),
  constraint org_admin_setup_hash_unique unique (token_hash),
  constraint org_admin_setup_hash_is_sha256 check (octet_length(token_hash) = 32),
  constraint org_admin_setup_expiry_after_issue check (expires_at > issued_at),
  constraint org_admin_setup_consumption_complete
    check ((consumed_at is null) = (consumed_auth_user_id is null))
);

alter table platform.provisioning_requests enable row level security;
alter table platform.provisioning_requests force row level security;
alter table platform.org_admin_setup enable row level security;
alter table platform.org_admin_setup force row level security;
create policy provisioning_requests_owner_all on platform.provisioning_requests
  for all to app_owner using (true) with check (true);
create policy org_admin_setup_owner_all on platform.org_admin_setup
  for all to app_owner using (true) with check (true);
revoke all on platform.provisioning_requests, platform.org_admin_setup
  from public, app_user, app_worker, app_auth, app_admin, app_platform;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — read-only views for the console
-- ═════════════════════════════════════════════════════════════════════════════
-- Organization metadata only: never a person, a record or any business row.
create function platform.list_organizations()
returns table (
  org_id uuid,
  name text,
  slug text,
  type_key text,
  template_version integer,
  status text,
  timezone text,
  created_at timestamptz,
  suspended_at timestamptz,
  active_members integer,
  first_admin_setup_pending boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform platform.require_permission('platform.organizations.view');
  return query
  select o.id, o.name, o.slug::text, o.type_key, o.template_version, o.status, o.timezone,
         o.created_at, o.suspended_at,
         (select count(*)::int from public.engagements e
           where e.org_id = o.id and e.status = 'ACTIVE'),
         exists (select 1 from platform.org_admin_setup s
                  where s.org_id = o.id and s.consumed_at is null)
  from public.organizations o
  where o.deleted_at is null
  order by o.created_at, o.id;
end;
$$;

-- The types an organization may be provisioned with: ACTIVE, with a PUBLISHED template.
create function platform.list_organization_types()
returns table (type_key text, display_name text, description text, latest_version integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform platform.require_permission('platform.organizations.view');
  return query
  select t.key, t.display_name, t.description, max(tt.version)
  from public.organization_types t
  join public.organization_type_templates tt on tt.type_key = t.key and tt.status = 'PUBLISHED'
  where t.status = 'ACTIVE'
  group by t.key, t.display_name, t.description
  order by t.key;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — provisioning
-- ═════════════════════════════════════════════════════════════════════════════
create function platform.provision_organization(
  p_idempotency_key text,
  p_name text,
  p_slug text,
  p_timezone text,
  p_type_key text,
  p_admin_full_name text,
  p_admin_email text,
  p_setup_token_hash bytea,
  p_request_id uuid
)
returns table (
  provisioned_org_id uuid,
  admin_person_id uuid,
  setup_expires_at timestamptz,
  replayed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := platform.require_permission('platform.organizations.create');
  v_digest text;
  v_prior platform.provisioning_requests%rowtype;
  v_version integer;
  v_org_id uuid := gen_random_uuid();
  v_department_id uuid := gen_random_uuid();
  v_person_id uuid := gen_random_uuid();
  v_role_id uuid;
  v_code text;
  v_issued_at timestamptz;
begin
  -- Nobody tenant-side is acting: no row written here can be attributed to a person.
  perform set_config('app.person_id', '', true);
  perform set_config('app.org_id', '', true);
  perform set_config('app.aal', '', true);

  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,128}$' then
    raise exception 'provisioning: an idempotency key of 8-128 characters [A-Za-z0-9_-] is required'
      using errcode = '22023';
  end if;
  perform platform.check_setup_token_hash(p_setup_token_hash);

  -- The digest covers every parameter that defines the organization; not the token.
  v_digest := encode(sha256(convert_to(jsonb_build_array(
      p_name, p_slug, p_timezone, p_type_key, p_admin_full_name, lower(p_admin_email))::text, 'UTF8')), 'hex');

  -- One request per key at a time; a retry waits, then reads the committed result.
  perform pg_advisory_xact_lock(hashtext('platform.provision:' || p_idempotency_key));
  select * into v_prior from platform.provisioning_requests r where r.idempotency_key = p_idempotency_key;
  if found then
    if v_prior.params_digest <> v_digest then
      raise exception 'provisioning: this idempotency key was used with different parameters'
        using errcode = '23505';
    end if;
    return query select v_prior.org_id, v_prior.person_id, null::timestamptz, true;
    return;
  end if;

  if p_name is null or length(btrim(p_name)) not between 1 and 200 then
    raise exception 'provisioning: organization name is required (1-200 characters)' using errcode = '22023';
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' or length(p_slug) > 63 then
    raise exception 'provisioning: slug must be lowercase letters, digits and hyphens (max 63)'
      using errcode = '22023';
  end if;
  if p_timezone is null or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone) then
    raise exception 'provisioning: unknown time zone' using errcode = '22023';
  end if;
  if p_admin_full_name is null or length(btrim(p_admin_full_name)) not between 1 and 200 then
    raise exception 'provisioning: administrator full name is required (1-200 characters)'
      using errcode = '22023';
  end if;
  if p_admin_email is null or p_admin_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'provisioning: administrator email is not a valid address' using errcode = '22023';
  end if;

  -- GOV-02: the first administrator gets a login this path creates; an address that already
  -- has one (any organization's person, or a platform administrator) is refused. The message
  -- is platform-only and names no organization.
  if exists (select 1 from auth.auth_users u where u.email operator(public.=) p_admin_email::public.citext)
     or exists (select 1 from platform.admins a where a.email operator(public.=) p_admin_email::public.citext)
     or exists (select 1 from public.people p
                where p.work_email operator(public.=) p_admin_email::public.citext and p.deleted_at is null) then
    raise exception 'provisioning: this email already belongs to a login or a person' using errcode = '55000';
  end if;

  select max(tt.version) into v_version
  from public.organization_types t
  join public.organization_type_templates tt on tt.type_key = t.key and tt.status = 'PUBLISHED'
  where t.key = p_type_key and t.status = 'ACTIVE';
  if v_version is null then
    raise exception 'provisioning: organization type is not available' using errcode = '22023';
  end if;

  if exists (select 1 from public.organizations o where o.slug operator(public.=) p_slug::public.citext and o.deleted_at is null) then
    raise exception 'provisioning: slug is already in use' using errcode = '23505';
  end if;

  -- The existing triggers seed the system roles (organizations_seed_system_roles) and the
  -- template's pipelines (0039/0080), and re-check the type and template (0080).
  insert into public.organizations (id, name, slug, timezone, type_key, template_version)
  values (v_org_id, btrim(p_name), p_slug, p_timezone, p_type_key, v_version);

  insert into public.departments (id, org_id, code, name)
  values (v_department_id, v_org_id, 'EXEC', 'Executive');

  v_code := authz.next_identity_code(v_org_id, 'EMP', to_char(now() at time zone p_timezone, 'YYYY'));
  insert into public.people (id, org_id, code, full_legal_name, work_email, person_status)
  values (v_person_id, v_org_id, v_code, btrim(p_admin_full_name), p_admin_email::public.citext, 'ACTIVE');

  insert into public.engagements
    (org_id, person_id, engagement_type, status, department_id, start_date)
  values
    (v_org_id, v_person_id, 'EMPLOYEE', 'ACTIVE', v_department_id, (now() at time zone p_timezone)::date);

  select r.id into v_role_id
  from public.roles r
  where r.org_id = v_org_id and r.key = 'SUPER_ADMIN' and r.is_system and r.is_protected
    and r.status = 'ACTIVE' and r.deleted_at is null;
  if v_role_id is null then
    raise exception 'provisioning: the organization has no protected system SUPER_ADMIN role'
      using errcode = '55000';
  end if;

  -- Genesis grant (granted_by NULL): this organization has no roles.manage holder yet and
  -- session_user is app_platform, one of the branch's named callers (0083).
  insert into public.person_roles (person_id, role_id, org_id, granted_by, expires_at)
  values (v_person_id, v_role_id, v_org_id, null, null);

  if not exists (
    select 1 from public.person_roles pr
    join public.roles r on r.id = pr.role_id and r.org_id = pr.org_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where pr.person_id = v_person_id and pr.org_id = v_org_id and pr.expires_at is null
      and r.status = 'ACTIVE' and r.deleted_at is null and p.key = 'roles.manage' and rp.scope = 'GLOBAL'
  ) then
    raise exception 'provisioning: the first administrator would not hold roles.manage at GLOBAL scope'
      using errcode = '55000';
  end if;

  v_issued_at := clock_timestamp();
  insert into platform.org_admin_setup (org_id, person_id, token_hash, issued_at, expires_at)
  values (v_org_id, v_person_id, p_setup_token_hash, v_issued_at, v_issued_at + interval '72 hours');

  insert into platform.provisioning_requests (idempotency_key, params_digest, admin_id, org_id, person_id)
  values (p_idempotency_key, v_digest, v_actor, v_org_id, v_person_id);

  perform platform.write_audit('platform_admin', v_actor, 'platform.organization.provisioned', 'SUCCESS',
    null, v_org_id, 'organization', v_org_id, p_request_id, p_idempotency_key,
    jsonb_build_object('type_key', p_type_key, 'template_version', v_version, 'slug', p_slug,
                       'first_admin_person_id', v_person_id));

  return query select v_org_id, v_person_id, v_issued_at + interval '72 hours', false;
end;
$$;

comment on function platform.provision_organization(text, text, text, text, text, text, text, bytea, uuid) is
  'ADR-008 P-1: one transaction — organization (ACTIVE type, latest published template), '
  'Executive department, first administrator (ACTIVE person, engagement, SUPER_ADMIN genesis '
  'grant) and a 72-hour setup token digest; idempotent by key; one platform audit entry.';

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 4 — the first administrator's setup: re-issue and completion
-- ═════════════════════════════════════════════════════════════════════════════
create function platform.reissue_org_admin_setup(p_org_id uuid, p_setup_token_hash bytea, p_request_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := platform.require_permission('platform.organizations.assign_initial_admin');
  v_setup platform.org_admin_setup%rowtype;
  v_issued_at timestamptz := clock_timestamp();
begin
  perform platform.check_setup_token_hash(p_setup_token_hash);
  select * into v_setup from platform.org_admin_setup s where s.org_id = p_org_id for update;
  if not found then
    raise exception 'platform: this organization was not provisioned by the platform' using errcode = 'P0002';
  end if;
  -- Only while the first administrator has no login: once they have one, the organization
  -- administers itself.
  if v_setup.consumed_at is not null
     or exists (select 1 from public.people p where p.id = v_setup.person_id and p.auth_user_id is not null) then
    raise exception 'platform: the first administrator has already completed setup' using errcode = '55000';
  end if;

  update platform.org_admin_setup s
  set token_hash = p_setup_token_hash, issued_at = v_issued_at, expires_at = v_issued_at + interval '72 hours'
  where s.org_id = p_org_id;

  perform platform.write_audit('platform_admin', v_actor, 'platform.organization.admin_setup_reissued',
    'SUCCESS', null, p_org_id, 'person', v_setup.person_id, p_request_id, null, '{}'::jsonb);
  return v_issued_at + interval '72 hours';
end;
$$;

-- Advisory, as for the other setup tokens: lets the runtime skip hashing a password for a
-- dead token. complete_org_admin_setup() decides.
create function platform.org_admin_setup_token_is_valid(p_setup_token_hash bytea) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from platform.org_admin_setup s
    join public.organizations o on o.id = s.org_id
    where s.token_hash = p_setup_token_hash and s.consumed_at is null and s.expires_at > now()
      and o.status = 'ACTIVE' and o.deleted_at is null
  )
$$;

-- Consumes the token and creates the first administrator's login, as complete_bootstrap_setup()
-- does for the bootstrapped one (0015): the caller supplies only the digest and a library
-- password hash; the person, the organization and the email come from the token row. A login
-- that already uses the email is refused, never linked. The tenant audit entry is the
-- person's own act, as in 0015.
create function platform.complete_org_admin_setup(p_setup_token_hash bytea, p_password_hash text)
returns table (linked_person_id uuid, linked_org_id uuid, linked_auth_user_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_setup platform.org_admin_setup%rowtype;
  v_person public.people%rowtype;
  v_auth_user_id uuid;
begin
  perform set_config('app.person_id', '', true);
  perform set_config('app.org_id', '', true);
  perform set_config('app.aal', '', true);

  if p_setup_token_hash is null or octet_length(p_setup_token_hash) <> 32 then
    raise exception 'setup token is invalid, expired or already used' using errcode = '28000';
  end if;

  select * into v_setup from platform.org_admin_setup s where s.token_hash = p_setup_token_hash for update;
  if not found or v_setup.consumed_at is not null or v_setup.expires_at <= v_now then
    raise exception 'setup token is invalid, expired or already used' using errcode = '28000';
  end if;
  if not exists (select 1 from public.organizations o
                  where o.id = v_setup.org_id and o.status = 'ACTIVE' and o.deleted_at is null) then
    raise exception 'setup token is invalid, expired or already used' using errcode = '28000';
  end if;

  if p_password_hash is null or p_password_hash !~ '^[0-9a-f]{32}:[0-9a-f]{128}$' then
    raise exception 'setup: the credential must be a password hash from the authentication library'
      using errcode = '22023';
  end if;

  select * into v_person from public.people p
  where p.id = v_setup.person_id and p.org_id = v_setup.org_id
  for update;
  if not found or v_person.deleted_at is not null or v_person.person_status <> 'ACTIVE'
     or v_person.auth_user_id is not null or v_person.work_email is null then
    raise exception 'setup: the first administrator cannot receive a login' using errcode = '55000';
  end if;
  if exists (select 1 from auth.auth_users u where u.email operator(public.=) v_person.work_email) then
    raise exception 'setup: a login already exists for this email and will not be adopted' using errcode = '55000';
  end if;

  insert into auth.auth_users (name, email, email_verified)
  values (v_person.full_legal_name, v_person.work_email, false)
  returning id into v_auth_user_id;
  insert into auth.auth_accounts (user_id, account_id, provider_id, password)
  values (v_auth_user_id, v_auth_user_id::text, 'credential', p_password_hash);

  perform set_config('app.person_id', v_person.id::text, true);
  perform set_config('app.org_id', v_person.org_id::text, true);

  update public.people p set auth_user_id = v_auth_user_id where p.id = v_person.id;
  update platform.org_admin_setup s set consumed_at = v_now, consumed_auth_user_id = v_auth_user_id
  where s.org_id = v_setup.org_id;

  perform public.write_audit_log(
    p_action := 'organization.first_admin_setup_completed',
    p_entity_type := 'person',
    p_result := 'SUCCESS'::public.audit_result,
    p_entity_id := v_person.id,
    p_severity := 'CRITICAL',
    p_metadata := jsonb_build_object('source', 'platform_provisioning', 'auth_user_id', v_auth_user_id));

  perform set_config('app.person_id', '', true);
  perform set_config('app.org_id', '', true);

  perform platform.write_audit('system', null, 'platform.organization.admin_setup_completed', 'SUCCESS',
    null, v_person.org_id, 'person', v_person.id, null, null, '{}'::jsonb);

  return query select v_person.id, v_person.org_id, v_auth_user_id;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 5 — suspend and reactivate (L1)
-- ═════════════════════════════════════════════════════════════════════════════
create function platform.set_organization_status(
  p_org_id uuid,
  p_to text,
  p_reason text,
  p_request_id uuid
) returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_org public.organizations%rowtype;
begin
  if p_to = 'SUSPENDED' then
    v_actor := platform.require_permission('platform.organizations.suspend');
  elsif p_to = 'ACTIVE' then
    v_actor := platform.require_permission('platform.organizations.reactivate');
  else
    raise exception 'platform: unsupported status transition' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'platform: a reason is required (3-500 characters)' using errcode = '22023';
  end if;

  select * into v_org from public.organizations o where o.id = p_org_id and o.deleted_at is null for update;
  if not found then
    raise exception 'platform: no such organization' using errcode = 'P0002';
  end if;
  if v_org.status = p_to then
    return 'UNCHANGED'; -- already there: no second audit entry
  end if;
  if v_org.status = 'ARCHIVED' then
    raise exception 'platform: an archived organization cannot change state in V1' using errcode = '55000';
  end if;

  if p_to = 'SUSPENDED' then
    update public.organizations o
    set status = 'SUSPENDED', suspended_at = clock_timestamp(), suspended_by = v_actor,
        suspension_reason = btrim(p_reason)
    where o.id = p_org_id;
  else
    update public.organizations o
    set status = 'ACTIVE', suspended_at = null, suspended_by = null, suspension_reason = null
    where o.id = p_org_id;
  end if;

  perform platform.write_audit('platform_admin', v_actor,
    case when p_to = 'SUSPENDED' then 'platform.organization.suspended' else 'platform.organization.reactivated' end,
    'SUCCESS', null, p_org_id, 'organization', p_org_id, p_request_id, null,
    jsonb_build_object('reason', btrim(p_reason), 'from', v_org.status));
  return p_to;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 6 — privileges and verification
-- ═════════════════════════════════════════════════════════════════════════════
revoke all on all functions in schema platform from public;

grant execute on function platform.list_organizations() to app_platform;
grant execute on function platform.list_organization_types() to app_platform;
grant execute on function platform.provision_organization(text, text, text, text, text, text, text, bytea, uuid) to app_platform;
grant execute on function platform.reissue_org_admin_setup(uuid, bytea, uuid) to app_platform;
grant execute on function platform.set_organization_status(uuid, text, text, uuid) to app_platform;

grant execute on function platform.org_admin_setup_token_is_valid(bytea) to app_auth;
grant execute on function platform.complete_org_admin_setup(bytea, text) to app_auth;

do $$
declare
  v_bad text;
begin
  select string_agg(p.proname || ' -> ' || coalesce(r.rolname, 'PUBLIC'), ', ' order by p.proname) into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'platform'
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
  left join pg_roles r on r.oid = x.grantee
  where x.privilege_type = 'EXECUTE'
    and coalesce(r.rolname, 'PUBLIC') <> 'app_owner'
    and (coalesce(r.rolname, 'PUBLIC'), p.proname::text) not in (
      ('app_admin', 'bootstrap_first_admin'), ('app_admin', 'reissue_setup'),
      ('app_admin', 'recover_admin'),
      ('app_auth', 'setup_token_is_valid'), ('app_auth', 'complete_setup'),
      ('app_auth', 'org_admin_setup_token_is_valid'), ('app_auth', 'complete_org_admin_setup'),
      ('app_platform', 'admin_for_login'), ('app_platform', 'whoami'),
      ('app_platform', 'invite_admin'), ('app_platform', 'revoke_admin'),
      ('app_platform', 'record_failure'), ('app_platform', 'list_audit_events'),
      ('app_platform', 'list_organizations'), ('app_platform', 'list_organization_types'),
      ('app_platform', 'provision_organization'), ('app_platform', 'reissue_org_admin_setup'),
      ('app_platform', 'set_organization_status'));
  if v_bad is not null then
    raise exception '0084: unexpected EXECUTE grant: %', v_bad;
  end if;

  select string_agg(c.relname, ', ') into v_bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'platform'
  where c.relkind = 'r' and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception '0084: platform table without forced RLS: %', v_bad;
  end if;

  select string_agg(distinct r.rolname || ' on ' || c.relname, ', ') into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'platform'
  cross join lateral aclexplode(c.relacl) x
  join pg_roles r on r.oid = x.grantee
  where c.relkind in ('r', 'p')
    and r.rolname in ('app_user', 'app_worker', 'app_auth', 'app_admin', 'app_platform');
  if v_bad is not null then
    raise exception '0084: runtime login holds a platform table privilege: %', v_bad;
  end if;

  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'platform'
  where p.proconfig is null or not ('search_path=""' = any(p.proconfig));
  if v_bad is not null then
    raise exception '0084: platform function without search_path='''': %', v_bad;
  end if;
end;
$$;
