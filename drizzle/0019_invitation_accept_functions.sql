-- PRAVSHI OS — Phase 1 Task 1.17: invitation acceptance functions.
--
-- These functions are the only pre-authentication writes in the system, and they
-- exist because invitation acceptance happens before any session does. Each one is
-- deliberately narrow: it answers one question or performs one acceptance, and none of
-- them is a general-purpose write that the application could reuse elsewhere.
--
-- WHY SECURITY DEFINER, AND WHY IT IS SAFE
--
-- The pre-auth application path runs as app_user, which holds no write grant on
-- invitations, auth.auth_users, people or person_roles, and FORCE RLS would deny the writes
-- anyway. These functions run as the table owner so the acceptance can happen at all.
-- They stay safe because they are not generic: accept_invitation() only fulfills a
-- single valid invitation for the invited person, revoke_invitation() only flips one
-- invitation's revoked flag, record_login_event() only appends one event row, and
-- invitation_preview() only reads. There is no parameter combination that turns any of
-- them into "write an arbitrary row".
--
-- THE PROTECTED-ROLE RULE, AND WHO THE ACTOR IS
--
-- person_roles has a trigger (migration 0008) that rejects a protected-role grant
-- unless the ACTING identity holds roles.manage at GLOBAL scope with a live engagement.
-- During acceptance the acting identity for the grant is the INVITER (v_invited_by),
-- not the new person: the invitation was the inviter's authorized decision, and the
-- trigger judges that decision against the inviter's LIVE permission. If the inviter
-- has been offboarded since issuing the invite, a protected-role grant fails closed —
-- which is exactly what offboarding someone must mean.
--
-- For the same reason, invitation_grant_check() runs at CREATION time (from the
-- TypeScript service, inside the authorized transaction): an invitation carrying a
-- protected role may only be issued by someone holding roles.manage at GLOBAL. HR can
-- invite employees; only a global roles manager can invite an administrator. Failing at
-- creation keeps unusable invitations from ever existing.
--
-- RLS on these tables stays forced, and app_user gains no direct write grant: every
-- write below happens inside these functions, as the owner, through the owner policies.

-- ── accept_invitation ──────────────────────────────────────────────────────────
--
-- Fulfil a single valid invitation: create the auth user, create or link the person,
-- create the engagement when the person has none (authz.is_active() requires one —
-- without it the new login would authenticate but see no business data), grant the
-- invitation's roles, mark the invitation used, write the audit and login events.
-- Single-use is enforced in three layers, none of them a partial unique index: the
-- row lock (SELECT ... FOR UPDATE) serializes concurrent accepts of the same token;
-- the function then refuses any invitation whose accepted_at or revoked_at is already
-- set; and the integrity trigger (0018) makes both columns write-once, so a consumed
-- invitation can never be resurrected. The token_hash unique constraint guarantees
-- one token names exactly one invitation.
--
-- The token NEVER reaches this function. The TypeScript route hashes the presented
-- token and passes only the digest; a database log, a slow-query sample or an error
-- message can therefore never leak a live invitation token.
create function public.accept_invitation(
  p_token_hash text,
  p_full_name text,
  p_password_hash text
)
returns table (person_id uuid, auth_user_id uuid, org_id uuid, email public.citext)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invitations%rowtype;
  v_new_auth_user_id uuid;
  v_new_person_id uuid;
  v_existing_person_id uuid;
  v_role_id uuid;
  v_invited_by uuid;
  v_engagement_created boolean := false;
begin
  -- Lock the invitation row first: the single-use check below must be serializable
  -- against a concurrent accept of the same token.
  select * into v_inv
  from public.invitations i
  where i.token_hash = p_token_hash
  for update;

  if not found
     or v_inv.accepted_at is not null
     or v_inv.revoked_at is not null
     or v_inv.expires_at <= now() then
    raise exception 'invitation invalid, expired, revoked or already used'
      using errcode = '28000';
  end if;

  v_invited_by := v_inv.invited_by;

  -- The Better Auth user row. The password hash is produced by the application (scrypt
  -- via the Better Auth library); the database never sees a plaintext password.
  insert into auth.auth_users (id, email, email_verified, name, created_at, updated_at)
  values (gen_random_uuid(), v_inv.email, true, nullif(btrim(p_full_name), ''), now(), now())
  returning id into v_new_auth_user_id;

  insert into auth.auth_accounts (id, user_id, account_id, provider_id, password, created_at, updated_at)
  values (
    gen_random_uuid(), v_new_auth_user_id, v_inv.email, 'credential',
    p_password_hash, now(), now()
  );

  -- Person: link the invitation to an existing person when one was named, otherwise
  -- create the ACTIVE person row the authorization model expects.
  if v_inv.person_id is not null then
    select p.id into v_existing_person_id
    from public.people p
    where p.id = v_inv.person_id
      and p.org_id = v_inv.org_id
      and p.deleted_at is null
      and p.person_status = 'ACTIVE'
      and p.auth_user_id is null
    for update;

    if not found then
      raise exception 'the person named by this invitation cannot accept it'
        using errcode = '55000';
    end if;

    update public.people
    set auth_user_id = v_new_auth_user_id,
        full_legal_name = nullif(btrim(p_full_name), ''),
        updated_at = now()
    where id = v_existing_person_id;

    v_new_person_id := v_existing_person_id;
  else
    -- The person code comes from the same identity-code generator as every other
    -- person row (bootstrap uses 'EMP' too): the people_code_format check rejects
    -- anything else, and reusing the generator keeps codes unique per org and year.
    insert into public.people (
      org_id, code, full_legal_name, work_email, person_status, auth_user_id
    )
    values (
      v_inv.org_id,
      authz.next_identity_code(
        v_inv.org_id, 'EMP',
        to_char(now() at time zone (select o.timezone from public.organizations o where o.id = v_inv.org_id), 'YYYY')
      ),
      nullif(btrim(p_full_name), ''),
      v_inv.email,
      'ACTIVE',
      v_new_auth_user_id
    )
    returning id into v_new_person_id;
  end if;

  -- Engagement. The new login is useless without one: authz.is_active() requires a
  -- live engagement, and every business-data RLS policy builds on it. A linked
  -- person who already holds a live engagement keeps it; otherwise the invitation's
  -- engagement terms create one now. It is ACTIVE immediately — Phase 1 has no
  -- onboarding workflow that could transition a PRE_ONBOARDING row, so anything less
  -- would lock the invitee out with no path forward.
  if not exists (
    select 1
    from public.engagements e
    where e.person_id = v_new_person_id
      and e.org_id = v_inv.org_id
      and e.status in ('PRE_ONBOARDING', 'ONBOARDING', 'ACTIVE', 'NOTICE_PERIOD')
      and e.is_primary
      and e.deleted_at is null
  ) then
    if v_inv.engagement_type is null
       or v_inv.department_id is null
       or v_inv.start_date is null then
      raise exception 'this invitation carries no engagement and the person has none'
        using errcode = '55000';
    end if;

    insert into public.engagements (
      org_id, person_id, engagement_type, status, department_id,
      start_date, is_primary, created_by
    )
    values (
      v_inv.org_id, v_new_person_id, v_inv.engagement_type, 'ACTIVE',
      v_inv.department_id, v_inv.start_date, true, v_invited_by
    );

    v_engagement_created := true;
  end if;

  -- The role grants. The actor for these inserts is the INVITER: the protected-role
  -- trigger (migration 0008) judges the grant against the inviter's live roles.manage
  -- at GLOBAL scope, which is the authorization this invitation was issued under. The
  -- granted_by column records the same truth for the audit trail. After the grants the
  -- actor is restored to the new person.
  perform set_config('app.person_id', v_invited_by::text, true);

  for v_role_id in
    select ir.role_id
    from public.invitation_roles ir
    join public.roles r on r.id = ir.role_id
    where ir.invitation_id = v_inv.id
      and r.org_id = v_inv.org_id
      and r.deleted_at is null
      and r.status = 'ACTIVE'
  loop
    insert into public.person_roles (person_id, role_id, org_id, granted_by)
    values (v_new_person_id, v_role_id, v_inv.org_id, v_invited_by);
  end loop;

  -- Blueprint R21: EMPLOYEE is the baseline for every active engagement. The
  -- invitation names the extra roles; the baseline is granted unconditionally so a
  -- new login never lands with zero permissions. Found by seeded identity like the
  -- bootstrap's SUPER_ADMIN grant, and required to exist — fail closed, never silent.
  select r.id into v_role_id
  from public.roles r
  where r.org_id = v_inv.org_id
    and r.key = 'EMPLOYEE'
    and r.is_system
    and r.status = 'ACTIVE'
    and r.deleted_at is null;

  if v_role_id is null then
    raise exception 'accept: the organization has no active system EMPLOYEE role'
      using errcode = '55000';
  end if;

  insert into public.person_roles (person_id, role_id, org_id, granted_by)
  values (v_new_person_id, v_role_id, v_inv.org_id, v_invited_by)
  on conflict do nothing;

  perform set_config('app.person_id', v_new_person_id::text, true);

  -- Mark the invitation used. The write-once trigger (0018) rejects any later attempt
  -- to clear accepted_at, and the row lock taken above kept a concurrent accept from
  -- interleaving with this one.
  update public.invitations
  set accepted_at = now(),
      updated_at = now()
  where id = v_inv.id;

  -- Audit: who accepted what, and on whose authority the roles were granted.
  -- The actor's email is denormalised into actor_email_snapshot so the entry still
  -- names them after the person record is gone; the invitation id is the entity.
  insert into public.audit_logs (
    org_id, actor_person_id, actor_email_snapshot, action, entity_type, entity_id,
    result, metadata
  )
  values (
    v_inv.org_id, v_new_person_id, v_inv.email,
    'invitation.accept', 'invitation', v_inv.id,
    'SUCCESS',
    jsonb_build_object(
      'invited_by', v_invited_by,
      'roles_granted_by', v_invited_by,
      'auth_user_id', v_new_auth_user_id,
      'engagement_created', v_engagement_created
    )
  );

  -- Login event: the account now exists, so its first authentication is traceable.
  perform public.record_login_event(
    v_inv.org_id, 'INVITATION_ACCEPTED', v_inv.email, v_new_auth_user_id,
    null, null, jsonb_build_object('invitation_id', v_inv.id)
  );

  person_id := v_new_person_id;
  auth_user_id := v_new_auth_user_id;
  org_id := v_inv.org_id;
  email := v_inv.email;
  return next;
end;
$$;

comment on function public.accept_invitation(text, text, text) is
  'Pre-authentication invitation acceptance: creates the auth user and person, grants '
  'the invitation roles with the inviter as the granting actor (the protected-role '
  'trigger judges the inviter''s live roles.manage), marks the invitation used, and '
  'writes audit + login events. Takes only the token digest, never the token.';

revoke all on function public.accept_invitation(text, text, text) from public;
grant execute on function public.accept_invitation(text, text, text) to app_user;

-- ── record_login_event ───────────────────────────────────────────────────────
--
-- The single write path for public.login_events. The append-only trigger (0018)
-- rejects UPDATE and DELETE, so "write path" means INSERT only, and this function is
-- the only grant app_user holds for it. Login outcomes are recorded even when no
-- session exists yet — which is precisely when they matter most.
create function public.record_login_event(
  p_org_id uuid,
  p_event_type text,
  p_email public.citext,
  p_auth_user_id uuid,
  p_ip inet,
  p_user_agent text,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_event_type not in (
    'LOGIN_SUCCESS', 'LOGIN_FAILURE', 'MFA_CHALLENGE', 'MFA_FAILURE',
    'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED',
    'INVITATION_ACCEPTED', 'INVITATION_REJECTED', 'SESSION_REVOKED'
  ) then
    raise exception 'unknown login event type: %', p_event_type
      using errcode = 'P0001';
  end if;

  insert into public.login_events (
    org_id, event_type, email, auth_user_id, ip_address, user_agent, metadata
  )
  values (p_org_id, p_event_type, p_email, p_auth_user_id, p_ip, p_user_agent,
          coalesce(p_metadata, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.record_login_event(uuid, text, public.citext, uuid, inet, text, jsonb) is
  'The only write path for public.login_events granted to app_user. The append-only '
  'trigger rejects UPDATE/DELETE, so events are facts, not editable history.';

revoke all on function public.record_login_event(uuid, text, public.citext, uuid, inet, text, jsonb) from public;
grant execute on function public.record_login_event(uuid, text, public.citext, uuid, inet, text, jsonb) to app_user;

-- ── revoke_invitation ────────────────────────────────────────────────────────
--
-- Administrative revocation. The TypeScript route authorizes users.create before
-- calling; the function's own guard (accepted invitations cannot be revoked) makes a
-- confused-deputy call harmless. The write-once trigger keeps revoked_at permanent.
create function public.revoke_invitation(p_invitation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invitations%rowtype;
  v_actor uuid;
begin
  v_actor := nullif(current_setting('app.person_id', true), '')::uuid;

  select * into v_inv
  from public.invitations i
  where i.id = p_invitation_id
  for update;

  if not found then
    return false;
  end if;

  if v_inv.accepted_at is not null then
    raise exception 'an accepted invitation cannot be revoked'
      using errcode = 'P0001';
  end if;

  if v_inv.revoked_at is not null then
    return true;
  end if;

  update public.invitations
  set revoked_at = now(),
      updated_at = now()
  where id = v_inv.id;

  insert into public.audit_logs (
    org_id, actor_person_id, actor_email_snapshot, action, entity_type, entity_id, result, metadata
  )
  values (
    v_inv.org_id, v_actor, v_inv.email,
    'invitation.revoke', 'invitation', v_inv.id, 'SUCCESS',
    jsonb_build_object('email', v_inv.email)
  );

  return true;
end;
$$;

comment on function public.revoke_invitation(uuid) is
  'Revokes a pending invitation (accepted ones are immutable history). The caller sets '
  'app.person_id; the route authorizes users.create before calling.';

revoke all on function public.revoke_invitation(uuid) from public;
grant execute on function public.revoke_invitation(uuid) to app_user;

-- ── invitation_preview ───────────────────────────────────────────────────────
--
-- Pre-acceptance preview: what the invite page shows before the user commits.
-- Returns the organization name and invited email, and nothing else — no role list,
-- no inviter identity, no expiry timestamp for a prober to optimize against. Validity
-- is a single boolean; invalid, expired, revoked and used are indistinguishable.
create function public.invitation_preview(p_token_hash text)
returns table (valid boolean, org_name text, email public.citext)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (i.accepted_at is null and i.revoked_at is null and i.expires_at > now()),
    o.name,
    i.email
  from public.invitations i
  join public.organizations o on o.id = i.org_id
  where i.token_hash = p_token_hash;
$$;

comment on function public.invitation_preview(text) is
  'Pre-authentication invitation preview for the accept page: validity as one boolean, '
  'plus org name and email. Invalid/expired/revoked/used are indistinguishable.';

revoke all on function public.invitation_preview(text) from public;
grant execute on function public.invitation_preview(text) to app_user;

-- ── invitation_grant_check ───────────────────────────────────────────────────
--
-- Creation-time guard, called from the invitation service inside the authorized
-- transaction (app.person_id is the inviting administrator). An invitation carrying
-- any protected role — flagged, or carrying roles.manage / permissions.manage — may
-- only be issued by someone holding roles.manage at GLOBAL scope with a live
-- engagement. Without this, HR could issue an invitation the acceptance trigger
-- would then refuse, creating invitations that can never be fulfilled.
create function public.invitation_grant_check(p_role_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  v_org_id := nullif(current_setting('app.org_id', true), '')::uuid;

  if exists (
    select 1
    from public.roles r
    where r.id = any (p_role_ids)
      and public.role_is_protected(r.id)
  ) and not public.may_manage_protected_roles(v_org_id) then
    raise exception 'inviting with a protected role requires roles.manage at GLOBAL scope in this organization'
      using errcode = '42501';
  end if;
end;
$$;

comment on function public.invitation_grant_check(uuid[]) is
  'Creation-time guard for invitations: protected roles in the invitation require the '
  'issuing administrator to hold roles.manage at GLOBAL scope. Called inside the '
  'authorized transaction; the acceptance trigger re-checks the inviter''s live '
  'permission at grant time.';

revoke all on function public.invitation_grant_check(uuid[]) from public;
grant execute on function public.invitation_grant_check(uuid[]) to app_user;
