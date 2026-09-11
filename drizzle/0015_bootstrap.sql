-- PRAVSHI OS — Phase 1 Task 1.14: first-run bootstrap.
--
-- Blueprint section 29.4: bootstrap "runs once ... and in a single transaction creates the
-- organization, seeds every role and permission, creates the owner people row, an ACTIVE
-- engagement, and the SUPER_ADMIN grant ... and prints a one-time setup link for the owner
-- to set their password and enrol MFA. It refuses to run if [the system is] already
-- [bootstrapped]."
--
-- ── THE TRUST BOUNDARY, END TO END ───────────────────────────────────────────────
--
--   app_admin credential            held on the operator's machine only; never Vercel,
--                                   never GitHub Actions (ENVIRONMENT.md)
--   → bootstrap_organization()      SECURITY DEFINER; EXECUTE granted to app_admin alone
--   → bootstrap_state               the one-time gate, and the FIRST write the function makes
--   → organization                  seed_system_roles() fires and creates the fourteen roles
--   → Executive department          engagements.department_id is NOT NULL
--   → person                        ACTIVE, no login yet
--   → ACTIVE engagement             so authz.is_active() is true for them
--   → SUPER_ADMIN origin grant      person_roles.granted_by = NULL: nobody granted it
--   → bootstrap_setup_token         a SHA-256 digest; the plaintext never reaches Postgres
--
-- and later, once:
--
--   app_user runtime → complete_bootstrap_setup()   token-gated, single use, 60 minutes
--   → auth_users + credential account                created by this path, never adopted
--   → people.auth_user_id                            the person points at the login
--
-- ── WHY THERE IS NO REUSABLE PATH ────────────────────────────────────────────────
--
-- Nothing here is a general capability that happens to be used once. Each function performs
-- exactly one fixed act, and each is closed by state that cannot be reopened:
--
--   * bootstrap_organization() refuses the moment bootstrap_state holds a row, and that row
--     can never be updated, deleted or truncated — by anyone, including app_owner.
--   * Its SUPER_ADMIN grant rides the genesis branch of may_manage_protected_roles() (Task
--     1.7), which evaporates the instant the organization has a holder. It does not bypass
--     the protected-role rule; it satisfies it, from a non-runtime role, exactly once.
--   * complete_bootstrap_setup() can only ever attach a login to the one person
--     bootstrap_state names, only while that person has none, and only by consuming the one
--     token, whose consumption can never be reversed.
--   * There is no re-issue function. If the token expires unused, the database is
--     bootstrapped and unclaimable; recovery is a fresh database, not a second door.
--
-- ── WHAT THE AUDIT LOG DOES AND DOES NOT SAY ABOUT THE ORIGIN ────────────────────
--
-- No human acts during bootstrap. The operator holds a database credential, not a people
-- row, and the owner does not yet exist when the transaction starts. Task 1.10 decided that
-- write_audit_log() refuses an unattributed entry, Task 1.11 decided that "there is no system
-- actor and no synthetic identity", and tests/db/audit-triggers.test.ts pins that no row in
-- audit_logs has a null actor. Inventing one here would reopen all three.
--
-- So the origin is recorded honestly, in the place built to hold it:
--
--   * bootstrap_state IS the bootstrap-origin event. It is immutable and permanent, and it
--     names the authenticated database role that performed it (session_user), when, and the
--     exact rows it created. It does not name a person, because none acted.
--   * The identity context is CLEARED at the top of the function, so the Task 1.11 triggers
--     on people, engagements and person_roles skip, exactly as they do for a migration or a
--     seed. Nothing attributes the origin grant to the new owner.
--   * The first audit_logs entries are written when a real person first acts — consuming
--     their own setup credential — and bootstrap.setup_completed carries the origin in its
--     metadata: performed_by, bootstrapped_at, and granted_by null.
--
-- Blueprint 29.4's "writes an audit entry" is therefore satisfied by an attributed entry at
-- the first moment one can be honest, not by a fabricated one at bootstrap time.

-- ═════════════════════════════════════════════════════════════════════════════════
-- bootstrap_state — the one-time gate and the permanent origin record
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- A singleton: the primary key is a boolean constrained to true, so the table can hold at
-- most one row and a second INSERT is a unique violation, whatever it contains.
--
-- The foreign keys are DEFERRABLE INITIALLY DEFERRED for one reason: this row is written
-- FIRST, before the rows it names exist, with identifiers allocated up front. That ordering
-- is the concurrency design. A second caller blocks on this row before it has written
-- anything at all, and fails once the first commits — so a losing attempt cannot leave an
-- organization, a person or a grant behind, even transiently. The keys are still checked, at
-- COMMIT, by which point every row they name must exist.
--
-- No FK indexes: the table has one row, and a scan of it is the index.
create table public.bootstrap_state (
  id boolean primary key default true,
  org_id uuid not null,
  department_id uuid not null,
  person_id uuid not null,
  engagement_id uuid not null,

  -- The authenticated database principal that performed the bootstrap. session_user, not
  -- current_user: inside the SECURITY DEFINER function current_user is always app_owner.
  performed_by text not null,
  bootstrapped_at timestamptz not null default clock_timestamp(),

  constraint bootstrap_state_singleton check (id),
  constraint bootstrap_state_performed_by_valid check (performed_by in ('app_admin', 'app_owner')),

  constraint bootstrap_state_org_fk
    foreign key (org_id) references public.organizations (id)
    deferrable initially deferred,
  constraint bootstrap_state_department_same_org
    foreign key (department_id, org_id) references public.departments (id, org_id)
    deferrable initially deferred,
  constraint bootstrap_state_person_same_org
    foreign key (person_id, org_id) references public.people (id, org_id)
    deferrable initially deferred,
  constraint bootstrap_state_engagement_same_org
    foreign key (engagement_id, org_id) references public.engagements (id, org_id)
    deferrable initially deferred
);

comment on table public.bootstrap_state is
  'The one-time bootstrap gate and the permanent record of the bootstrap-origin event: who '
  '(database role) and when, and the organization, department, person and engagement it '
  'created. At most one row; never updated, deleted or truncated by any role.';

-- ═════════════════════════════════════════════════════════════════════════════════
-- bootstrap_setup_token — the one first-login credential
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Also a singleton, and keyed to bootstrap_state, so there can never be a second token for
-- any reason — not after expiry, not after use.
--
-- token_hash is SHA-256 of the token string. The token itself is 32 bytes from a CSPRNG,
-- generated by the operator's script, hashed there, and never sent to the database; the
-- runtime hashes what it is presented with before it asks. A fast hash is correct for a
-- 256-bit random secret — there is no dictionary to slow down — and it means a read of this
-- table reveals nothing usable.
--
-- Sixty minutes is the same lifetime Better Auth gives its own password-reset token
-- (resetPasswordTokenExpiresIn, 3600 seconds), and the CHECK makes it a ceiling rather than a
-- convention: no row can be written with a longer one.
create table public.bootstrap_setup_token (
  id boolean primary key default true references public.bootstrap_state (id),
  org_id uuid not null,
  person_id uuid not null,

  token_hash bytea not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,

  consumed_at timestamptz,
  consumed_auth_user_id uuid references auth.auth_users (id),

  constraint bootstrap_setup_token_singleton check (id),
  constraint bootstrap_setup_token_hash_is_sha256 check (octet_length(token_hash) = 32),
  constraint bootstrap_setup_token_expires_after_issue check (expires_at > issued_at),
  constraint bootstrap_setup_token_lifetime_bounded
    check (expires_at <= issued_at + interval '60 minutes'),
  constraint bootstrap_setup_token_consumption_complete
    check ((consumed_at is null) = (consumed_auth_user_id is null)),
  constraint bootstrap_setup_token_consumed_in_window
    check (consumed_at is null or (consumed_at >= issued_at and consumed_at < expires_at)),

  constraint bootstrap_setup_token_person_same_org
    foreign key (person_id, org_id) references public.people (id, org_id)
);

comment on table public.bootstrap_setup_token is
  'The single setup credential for the bootstrap person: a SHA-256 digest, never the token. '
  'Expires 60 minutes after issue; consumed at most once; never re-issued, deleted or reset.';
comment on column public.bootstrap_setup_token.token_hash is
  'SHA-256 of the setup token string. The plaintext token is never sent to or stored in the '
  'database.';

-- ── immutability, enforced for everyone ──────────────────────────────────────────
--
-- Privileges stop app_user and app_admin. These triggers stop app_owner as well, which is the
-- property a one-time gate needs: a gate the migration role can quietly reopen by deleting a
-- row is not one-time. TRUNCATE is covered separately because row triggers do not fire for it.
-- A role that owns the table can still disable a trigger with DDL; that is a reviewed
-- migration, not an accident, and it is out of reach of both runtime roles.

create function public.bootstrap_state_immutable() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'bootstrap_state records a one-time event and is immutable: % is not permitted', tg_op
    using errcode = '42501';
end;
$$;

comment on function public.bootstrap_state_immutable() is
  'Raises on any UPDATE, DELETE or TRUNCATE of bootstrap_state, for every role.';

create trigger bootstrap_state_no_update
  before update on public.bootstrap_state
  for each row execute function public.bootstrap_state_immutable();
create trigger bootstrap_state_no_delete
  before delete on public.bootstrap_state
  for each row execute function public.bootstrap_state_immutable();
create trigger bootstrap_state_no_truncate
  before truncate on public.bootstrap_state
  for each statement execute function public.bootstrap_state_immutable();

-- The token row may change exactly once, in exactly one way: from unconsumed to consumed,
-- naming the login that consumed it. Every other column is frozen at issue, consumption can
-- never be cleared or repeated, and the row can never be removed.
create function public.bootstrap_setup_token_consume_once() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'the bootstrap setup token cannot be removed: % is not permitted', tg_op
      using errcode = '42501';
  end if;

  if old.consumed_at is not null then
    raise exception 'the bootstrap setup token has been consumed and can never change again'
      using errcode = '42501';
  end if;

  if new.consumed_at is null
     or new.consumed_auth_user_id is null
     or new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.person_id is distinct from old.person_id
     or new.token_hash is distinct from old.token_hash
     or new.issued_at is distinct from old.issued_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'the only permitted change to the bootstrap setup token is its single consumption'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.bootstrap_setup_token_consume_once() is
  'Permits one transition of bootstrap_setup_token — unconsumed to consumed — and refuses '
  'every other UPDATE, and every DELETE and TRUNCATE, for every role.';

create trigger bootstrap_setup_token_guard_update
  before update on public.bootstrap_setup_token
  for each row execute function public.bootstrap_setup_token_consume_once();
create trigger bootstrap_setup_token_no_delete
  before delete on public.bootstrap_setup_token
  for each row execute function public.bootstrap_setup_token_consume_once();
create trigger bootstrap_setup_token_no_truncate
  before truncate on public.bootstrap_setup_token
  for each statement execute function public.bootstrap_setup_token_consume_once();

revoke all on function public.bootstrap_state_immutable() from public;
revoke all on function public.bootstrap_setup_token_consume_once() from public;

-- ═════════════════════════════════════════════════════════════════════════════════
-- bootstrap_organization() — the operator's one act
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- SECURITY DEFINER because nothing else could do it: app_admin holds no write privilege on
-- any of the tables below, and must not. It runs as app_owner, whose _owner_all policies are
-- the only ones under FORCE RLS that admit these writes — the same arrangement
-- seed_system_roles() and next_identity_code() already use.
--
-- WHO MAY CALL IT. EXECUTE is granted to app_admin only. app_owner can call it as the
-- function's owner, and the check below admits it, because app_owner owns every table
-- involved and could write the same rows directly; refusing it would protect nothing and
-- would leave the function untestable in CI, where no app_admin credential exists by design.
-- app_user is refused twice: it holds no EXECUTE, and session_user is checked here as well,
-- so a mistaken future GRANT still cannot put bootstrap in the runtime's hands.
--
-- The returned column names are deliberately distinct from every table column, because a
-- plpgsql OUT parameter named like a column makes that column ambiguous in every query here.
create function public.bootstrap_organization(
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

comment on function public.bootstrap_organization(text, text, text, text, bytea) is
  'Blueprint 29.4 bootstrap, once per database: organization, Executive department, ACTIVE '
  'person and engagement, the SUPER_ADMIN origin grant (granted_by NULL) and the setup token '
  'digest, in one transaction. Refuses after the first success. EXECUTE: app_admin only.';

revoke all on function public.bootstrap_organization(text, text, text, text, bytea) from public;
grant execute on function public.bootstrap_organization(text, text, text, text, bytea) to app_admin;

-- ═════════════════════════════════════════════════════════════════════════════════
-- the setup credential, from the runtime's side
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Completion is an authentication act — someone establishing their first credential — so it
-- belongs to app_user and the auth layer, and not to app_admin, exactly as
-- resolve_auth_identity() does (tests/db/auth-schema.test.ts: authentication is not an
-- app_admin path).

-- Advisory only. It lets the runtime refuse an unknown or dead token BEFORE spending a scrypt
-- computation on the password that came with it, so an unauthenticated caller cannot turn the
-- endpoint into a CPU sink. It answers one yes/no question about a digest the caller already
-- holds, and says nothing about whom a valid token belongs to. complete_bootstrap_setup()
-- re-checks everything under a row lock and is the authority.
create function public.bootstrap_setup_token_is_valid(p_setup_token_hash bytea)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.bootstrap_setup_token t
    where t.id
      and t.token_hash = p_setup_token_hash
      and t.consumed_at is null
      and t.expires_at > now()
  )
$$;

comment on function public.bootstrap_setup_token_is_valid(bytea) is
  'Whether a digest names the live, unconsumed bootstrap setup token. Advisory: it lets the '
  'runtime avoid hashing a password for a dead token. complete_bootstrap_setup() decides.';

revoke all on function public.bootstrap_setup_token_is_valid(bytea) from public;
grant execute on function public.bootstrap_setup_token_is_valid(bytea) to app_user;

-- ── complete_bootstrap_setup() ───────────────────────────────────────────────────
--
-- Consumes the token and creates the bootstrap person's login, atomically: the token is
-- consumed if and only if the login exists and the person points at it.
--
-- WHAT THE CALLER SUPPLIES: the token digest, and a password hash produced by Better Auth's
-- own hasher. Nothing else — not an email, not a person, not an organization. Every one of
-- those comes from the token row, so the caller cannot choose whose login this becomes.
--
-- WHY IT CREATES THE LOGIN RATHER THAN ADOPTING ONE. Until this runs, the bootstrap person has
-- no auth_user_id, and app_user holds no UPDATE on people, so there is no way to attach a
-- credential to the SUPER_ADMIN except through this function and its token. If a login with
-- the bootstrap email already exists — created by some other path — it is refused, never
-- linked: a credential this function did not create is not proof of anything.
--
-- WHAT IT ACCEPTS AS A CREDENTIAL. The Better Auth scrypt format, salt:key in hex (16 and 64
-- bytes). Plaintext, an empty string or anything else is refused, so even a compromised
-- runtime holding the token cannot store a password the library would not have produced.
--
-- ATTRIBUTION. The token is bound to the bootstrap person, so consuming it is that person's
-- act, in the same way every authenticated request is attributed to the session's person. The
-- identity context is set for the link and the audit entry, and cleared again before return.
-- The origin — bootstrap itself, and the grant nobody made — is carried in the metadata as
-- what it was, not re-attributed to anyone.
--
-- One generic error for every token failure, so the function is not an oracle for whether a
-- token exists, expired or was used.
create function public.complete_bootstrap_setup(p_setup_token_hash bytea, p_password_hash text)
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

comment on function public.complete_bootstrap_setup(bytea, text) is
  'Consumes the bootstrap setup token once and, in the same transaction, creates the bootstrap '
  'person''s Better Auth login from a library-produced password hash and links it. Refuses a '
  'dead token, a person who already has a login, and any existing login for the email.';

revoke all on function public.complete_bootstrap_setup(bytea, text) from public;
grant execute on function public.complete_bootstrap_setup(bytea, text) to app_user;

-- ═════════════════════════════════════════════════════════════════════════════════
-- RLS and privileges
-- ═════════════════════════════════════════════════════════════════════════════════

alter table public.bootstrap_state enable row level security;
alter table public.bootstrap_state force row level security;
alter table public.bootstrap_setup_token enable row level security;
alter table public.bootstrap_setup_token force row level security;

-- FORCE subjects the owner to its own policies, and the functions above run as the owner.
create policy bootstrap_state_owner_all on public.bootstrap_state
  for all to app_owner using (true) with check (true);
create policy bootstrap_setup_token_owner_all on public.bootstrap_setup_token
  for all to app_owner using (true) with check (true);

-- No policy for app_user or app_admin, and no privilege either: the roles.sql default grant of
-- select/insert/update on new public tables is revoked outright. Both tables are reachable only
-- through the functions above — the identity_counters arrangement from Task 1.1.
revoke all on public.bootstrap_state from app_user, app_admin;
revoke all on public.bootstrap_setup_token from app_user, app_admin;
