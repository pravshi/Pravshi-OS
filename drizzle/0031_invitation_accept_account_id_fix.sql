-- PRAVSHI OS — BUG-001 fix: invitation accepters could never log in.
--
-- THE HOLE. accept_invitation() (migration 0019) inserted the credential row with
-- account_id = the invitee's EMAIL. Better Auth's sign-in-email resolves the
-- credential account with `account.accountId === user.id` — the auth USER'S UUID.
-- An email string never equals that UUID, so every user who accepted an invitation
-- got a credential row Better Auth could never find: login always failed with
-- "User not found" -> INVALID_CREDENTIALS. The bootstrap (0015) used the correct
-- pattern (account_id = user id), which is why /setup owners were unaffected.
--
-- THE FIX. CREATE OR REPLACE the function with account_id = v_new_auth_user_id::text,
-- plus a data repair for rows already written by the broken version. The repair is
-- safe: for provider_id='credential' Better Auth always uses the user id as the
-- account id, so any credential row whose account_id differs from its user_id is
-- definitionally broken. OAuth rows (other provider_id values) are untouched.

create or replace function public.accept_invitation(
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
    gen_random_uuid(), v_new_auth_user_id, v_new_auth_user_id::text, 'credential',
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

-- Data repair: rows written by the broken 0019 version.
update auth.auth_accounts
set account_id = user_id::text,
    updated_at = now()
where provider_id = 'credential'
  and account_id is distinct from user_id::text;
