-- Rollback for 0085_login_email_case — restores the 0084 behaviour.
--
-- Prepared in advance. Run as the migration owner, in one transaction, only with the founder's
-- approval for the named database. It does NOT remove 0085's row from the history.
--
-- What this re-opens: LOCK-1 — a login whose address is written in mixed case from now on is not
-- locked out and is not found by a reset request. Addresses lower-cased by 0085 stay lower-case
-- (the original spelling is not kept; citext treats the spellings as equal).
-- It refuses unless the database is exactly at 0085.

begin;

set local lock_timeout = '5s';

do $$
begin
  if (select count(*) from drizzle.__drizzle_migrations) <> 85 then
    raise exception '0085 rollback refused: the database is not at 0085 (roll back later migrations first)';
  end if;
end;
$$;

-- 0020's function, verbatim.
create or replace function public.resolve_login_org(p_email public.citext)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  -- The same address can exist in two orgs only by administrative accident; prefer the
  -- person who actually holds a login, then the oldest row. A login event attributed
  -- to the wrong org is a misfiled security signal, so the preference is explicit.
  select p.org_id
  from public.people p
  where p.work_email = p_email
    and p.deleted_at is null
  order by (p.auth_user_id is null), p.created_at
  limit 1;
$$;

-- bootstrap_organization as 0083 left it, verbatim.
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

  -- 0083 (ADR-008 P-2): once the platform is bootstrapped, every organization in this database
  -- is provisioned by the platform, with its audit entry; this path is closed.
  if exists (select 1 from platform.bootstrap_state) then
    raise exception 'organizations in this database are provisioned by the platform; the organization bootstrap is closed'
      using errcode = '42501';
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

-- 0015's complete_bootstrap_setup, verbatim.
create or replace function public.complete_bootstrap_setup(p_setup_token_hash bytea, p_password_hash text)
returns table (
  linked_person_id uuid,
  linked_org_id uuid,
  linked_auth_user_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_token public.bootstrap_setup_token%rowtype;
  v_state public.bootstrap_state%rowtype;
  v_person public.people%rowtype;
  v_auth_user_id uuid;
begin
  perform set_config('app.person_id', '', true);
  perform set_config('app.org_id', '', true);
  perform set_config('app.aal', '', true);

  if p_setup_token_hash is null or octet_length(p_setup_token_hash) <> 32 then
    raise exception 'bootstrap setup token is invalid, expired or already used'
      using errcode = '28000';
  end if;

  -- The row lock serialises concurrent consumers: a second caller waits here, then re-reads
  -- the row the first one committed and finds it consumed.
  select * into v_token from public.bootstrap_setup_token t where t.id for update;

  if not found
     or v_token.token_hash <> p_setup_token_hash
     or v_token.consumed_at is not null
     or v_token.expires_at <= v_now then
    raise exception 'bootstrap setup token is invalid, expired or already used'
      using errcode = '28000';
  end if;

  if p_password_hash is null or p_password_hash !~ '^[0-9a-f]{32}:[0-9a-f]{128}$' then
    raise exception 'bootstrap setup: the credential must be a password hash from the authentication library'
      using errcode = '22023';
  end if;

  select * into v_state from public.bootstrap_state s where s.id;

  if not found or v_state.person_id <> v_token.person_id or v_state.org_id <> v_token.org_id then
    raise exception 'bootstrap setup: the token is not bound to the bootstrap person'
      using errcode = '55000';
  end if;

  select * into v_person
  from public.people p
  where p.id = v_token.person_id and p.org_id = v_token.org_id
  for update;

  if not found
     or v_person.deleted_at is not null
     or v_person.person_status <> 'ACTIVE'
     or v_person.auth_user_id is not null
     or v_person.work_email is null then
    raise exception 'bootstrap setup: the bootstrap person cannot receive a login'
      using errcode = '55000';
  end if;

  if exists (select 1 from auth.auth_users u where u.email = v_person.work_email) then
    raise exception 'bootstrap setup: a login already exists for the bootstrap email and will not be adopted'
      using errcode = '55000';
  end if;

  -- The shape Better Auth's own sign-up writes: an unverified user, and a credential account
  -- whose account_id is the user id (sign-in looks the password up by exactly that pair).
  -- email_verified stays false: a link delivered to the operator's terminal proves nothing
  -- about the mailbox.
  insert into auth.auth_users (name, email, email_verified)
  values (v_person.full_legal_name, v_person.work_email, false)
  returning id into v_auth_user_id;

  insert into auth.auth_accounts (user_id, account_id, provider_id, password)
  values (v_auth_user_id, v_auth_user_id::text, 'credential', p_password_hash);

  perform set_config('app.person_id', v_person.id::text, true);
  perform set_config('app.org_id', v_person.org_id::text, true);

  update public.people p set auth_user_id = v_auth_user_id where p.id = v_person.id;

  update public.bootstrap_setup_token t
  set consumed_at = v_now, consumed_auth_user_id = v_auth_user_id
  where t.id;

  perform public.write_audit_log(
    p_action := 'bootstrap.setup_completed',
    p_entity_type := 'person',
    p_result := 'SUCCESS'::public.audit_result,
    p_entity_id := v_person.id,
    p_severity := 'CRITICAL',
    p_metadata := jsonb_build_object(
      'source', 'bootstrap',
      'auth_user_id', v_auth_user_id,
      'origin', jsonb_build_object(
        'performed_by', v_state.performed_by,
        'bootstrapped_at', v_state.bootstrapped_at,
        'engagement_id', v_state.engagement_id,
        'grant', jsonb_build_object('role', 'SUPER_ADMIN', 'granted_by', null))));

  perform set_config('app.person_id', '', true);
  perform set_config('app.org_id', '', true);

  return query select v_person.id, v_person.org_id, v_auth_user_id;
end;
$$;

alter table auth.auth_users drop constraint auth_users_email_lowercase;

drop trigger auth_users_normalize_email on auth.auth_users;

drop function auth.normalize_login_email();

commit;
