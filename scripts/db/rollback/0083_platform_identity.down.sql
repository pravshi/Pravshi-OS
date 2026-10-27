-- Rollback for 0083_platform_identity — restores the 0082 state.
--
-- Prepared in advance. Run as the migration owner, in one transaction, only with the founder's
-- approval for the named database. It does NOT remove 0083's row from the history, and it does
-- not drop the app_platform login (roles belong to scripts/db/roles.sql).
--
-- It refuses unless the database is exactly at 0083 (a later migration, 0084 onwards, builds on
-- the platform schema, and DROP SCHEMA ... CASCADE would take its objects too: roll those back
-- first), and while the platform holds any administrator or any audit event: dropping the
-- schema would destroy the platform audit trail, which nothing may remove (ADR-008). The
-- platform tables are locked first, so nothing can be written between the check and the drop.
--
-- What this re-opens: the organization bootstrap is no longer closed by a platform bootstrap,
-- the protected-role genesis branch again admits any session_user but app_user, and the web
-- password reset again reaches a platform administrator's login (there are none: see above).

begin;

set local lock_timeout = '5s';

lock table platform.admins, platform.audit_events, platform.setup_tokens, platform.bootstrap_state
  in access exclusive mode;

do $$
begin
  if (select count(*) from drizzle.__drizzle_migrations) <> 83 then
    raise exception '0083 rollback refused: the database is not at 0083 (roll back later migrations first)';
  end if;
  if exists (select 1 from platform.admins) or exists (select 1 from platform.audit_events) then
    raise exception '0083 rollback refused: the platform holds administrators or audit history';
  end if;
end;
$$;

-- 0015's function, verbatim.
create or replace function public.bootstrap_organization(
  p_org_name text,
  p_org_slug text,
  p_owner_full_name text,
  p_owner_work_email text,
  p_setup_token_hash bytea
)
returns table (
  organization_id uuid,
  owner_person_id uuid,
  owner_engagement_id uuid,
  setup_token_expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org_id uuid := gen_random_uuid();
  v_department_id uuid := gen_random_uuid();
  v_person_id uuid := gen_random_uuid();
  v_engagement_id uuid := gen_random_uuid();
  v_role_id uuid;
  v_timezone text;
  v_code text;
  v_issued_at timestamptz;
  v_gate boolean;
begin
  if session_user not in ('app_admin', 'app_owner') then
    raise exception 'bootstrap may only be performed by the bootstrap database role'
      using errcode = '42501';
  end if;

  -- Nobody is acting, and this makes it structurally true rather than assumed: whatever the
  -- caller put in the transaction context, no row written below can be attributed to a
  -- person, and may_manage_protected_roles() cannot evaluate an identity.
  perform set_config('app.person_id', '', true);
  perform set_config('app.org_id', '', true);
  perform set_config('app.aal', '', true);

  -- Error messages name the parameter and never echo the value.
  if p_org_name is null or length(btrim(p_org_name)) = 0 then
    raise exception 'bootstrap: organization name is required' using errcode = '22023';
  end if;
  if p_org_slug is null then
    raise exception 'bootstrap: organization slug is required' using errcode = '22023';
  end if;
  if p_owner_full_name is null or length(btrim(p_owner_full_name)) = 0 then
    raise exception 'bootstrap: owner full name is required' using errcode = '22023';
  end if;
  if p_owner_work_email is null
     or p_owner_work_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'bootstrap: owner work email is not a valid address' using errcode = '22023';
  end if;
  if p_setup_token_hash is null or octet_length(p_setup_token_hash) <> 32 then
    raise exception 'bootstrap: setup token hash must be a 32-byte SHA-256 digest'
      using errcode = '22023';
  end if;

  if exists (select 1 from public.bootstrap_state) then
    raise exception 'this database has already been bootstrapped; bootstrap runs once and cannot be repeated'
      using errcode = '55000';
  end if;

  -- A login that already uses the owner's address cannot be shown to belong to the owner, and
  -- the first SUPER_ADMIN must not be attachable to a credential this path did not create.
  if exists (
    select 1 from auth.auth_users u where u.email = p_owner_work_email::public.citext
  ) then
    raise exception 'bootstrap: a login already exists for the owner work email'
      using errcode = '55000';
  end if;

  -- THE GATE. The first write. A concurrent caller blocks here on this uncommitted row and,
  -- once it commits, finds the conflict and writes nothing. If this transaction rolls back
  -- instead, the row goes with it and the next caller proceeds: a failed attempt does not
  -- consume the one bootstrap.
  insert into public.bootstrap_state (id, org_id, department_id, person_id, engagement_id, performed_by)
  values (true, v_org_id, v_department_id, v_person_id, v_engagement_id, session_user)
  on conflict (id) do nothing
  returning true into v_gate;

  if v_gate is null then
    raise exception 'this database has already been bootstrapped; bootstrap runs once and cannot be repeated'
      using errcode = '55000';
  end if;

  -- organizations_seed_system_roles fires here and creates the fourteen system roles and the
  -- security.md matrix, SUPER_ADMIN at GLOBAL on the whole catalogue among them.
  insert into public.organizations (id, name, slug)
  values (v_org_id, btrim(p_org_name), p_org_slug);

  select o.timezone into v_timezone from public.organizations o where o.id = v_org_id;

  insert into public.departments (id, org_id, code, name)
  values (v_department_id, v_org_id, 'EXEC', 'Executive');

  v_code := authz.next_identity_code(v_org_id, 'EMP', to_char(now() at time zone v_timezone, 'YYYY'));

  insert into public.people (id, org_id, code, full_legal_name, work_email, person_status)
  values (v_person_id, v_org_id, v_code, btrim(p_owner_full_name),
          p_owner_work_email::public.citext, 'ACTIVE');

  -- Inserted directly at ACTIVE. The Task 1.6 transition machine polices status CHANGES on
  -- UPDATE; an engagement that begins active is a starting state, not a transition.
  insert into public.engagements
    (id, org_id, person_id, engagement_type, status, department_id, start_date)
  values
    (v_engagement_id, v_org_id, v_person_id, 'EMPLOYEE', 'ACTIVE', v_department_id,
     (now() at time zone v_timezone)::date);

  -- Blueprint 29.4 names the grant, so the role is found by its seeded identity — and then
  -- required to be the protected system role, not merely a row with that key.
  select r.id into v_role_id
  from public.roles r
  where r.org_id = v_org_id
    and r.key = 'SUPER_ADMIN'
    and r.is_system
    and r.is_protected
    and r.status = 'ACTIVE'
    and r.deleted_at is null;

  if v_role_id is null then
    raise exception 'bootstrap: the organization has no protected system SUPER_ADMIN role'
      using errcode = '55000';
  end if;

  -- granted_by is NULL because nobody granted it. enforce_protected_role_assignment() admits it
  -- through the genesis branch: this organization has no roles.manage holder, and session_user
  -- is not app_user. After this statement it has one, and that branch is closed for good.
  insert into public.person_roles (person_id, role_id, org_id, granted_by, expires_at)
  values (v_person_id, v_role_id, v_org_id, null, null);

  -- Postcondition. A bootstrap that produced an owner unable to manage roles would leave an
  -- organization nobody can administer and genesis already closed. Refuse to commit that.
  if not exists (
    select 1
    from public.person_roles pr
    join public.roles r on r.id = pr.role_id and r.org_id = pr.org_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where pr.person_id = v_person_id
      and pr.org_id = v_org_id
      and pr.expires_at is null
      and r.status = 'ACTIVE'
      and r.deleted_at is null
      and p.key = 'roles.manage'
      and rp.scope = 'GLOBAL'
  ) then
    raise exception 'bootstrap: the owner would not hold roles.manage at GLOBAL scope'
      using errcode = '55000';
  end if;

  v_issued_at := clock_timestamp();

  insert into public.bootstrap_setup_token (id, org_id, person_id, token_hash, issued_at, expires_at)
  values (true, v_org_id, v_person_id, p_setup_token_hash, v_issued_at,
          v_issued_at + interval '60 minutes');

  return query select v_org_id, v_person_id, v_engagement_id, v_issued_at + interval '60 minutes';
end;
$$;

-- 0008's function, verbatim.
create or replace function public.may_manage_protected_roles(p_org_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with holders as (
    select pr.person_id
    from public.person_roles pr
    join public.roles r on r.id = pr.role_id and r.org_id = pr.org_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where pr.org_id = p_org_id
      and (pr.expires_at is null or pr.expires_at > now())
      and r.deleted_at is null
      and r.status = 'ACTIVE'
      and p.key = 'roles.manage'
      and rp.scope = 'GLOBAL'
  )
  select (
      exists (select 1 from holders h where h.person_id = authz.person_id())
      and authz.is_active()
    )
    or (
      not exists (select 1 from holders)
      and session_user <> 'app_user'
    )
$$;

-- 0024's function, verbatim.
create or replace function authz.request_password_reset(p_email text, p_token_hash text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_auth_user_id uuid;
  v_reset_id uuid;
begin
  select u.id into v_auth_user_id
  from auth.auth_users u
  where u.email = lower(p_email)
  limit 1;

  if v_auth_user_id is null then
    return null;
  end if;

  -- Retire the user's outstanding tokens: only the newest token in the inbox works.
  update auth.password_resets
  set used_at = now()
  where auth_user_id = v_auth_user_id
    and used_at is null;

  insert into auth.password_resets (auth_user_id, token_hash, expires_at)
  values (v_auth_user_id, p_token_hash, now() + interval '1 hour')
  returning id into v_reset_id;

  return v_reset_id;
end;
$$;

drop trigger people_login_not_a_platform_admin on public.people;

drop schema platform cascade;

commit;
