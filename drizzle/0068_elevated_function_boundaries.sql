-- ═════════════════════════════════════════════════════════════════════════════
-- 0068_elevated_function_boundaries — tenant boundaries inside elevated
-- (SECURITY DEFINER) functions, and background work that stops for
-- organizations that are not ACTIVE
-- (multi-tenant audit WP-T2: MT-M2 and the protected-role check; design K10)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE GAP (MT-M2). Several functions executable by the runtime role app_user
-- accepted an organization or record id and acted on it without checking it
-- against the caller. None is reachable through the API today — every
-- application caller passes ids it derived itself — but anyone able to run SQL
-- as app_user (e.g. through a future injection bug) could act on another
-- tenant. The 0061 idiom closes that class: a function that accepts a tenant id
-- asserts it against the transaction identity and raises 42501 on mismatch.
--
-- THE LIFECYCLE GAP (design §F, K10). Person-context paths already stop for a
-- SUSPENDED/ARCHIVED organization (authz.is_active()), but the worker plane did
-- not: job claims, scheduler ticks, reminder claims, retry sweeps and the
-- next-due lookup ignored organization status, and inbound webhooks resolved
-- for any organization. Work of an organization that is not ACTIVE (or is
-- deleted) now stays where it is — untouched, not cancelled — and resumes when
-- the organization is ACTIVE again. Cancelling it on archival is WP-T4b.
--
-- WHAT CHANGES (every body is otherwise verbatim from its latest definition):
--   PART 1  jobs_claim_next            refuses a person context; claims only
--                                      jobs of ACTIVE organizations
--   PART 2  integration_webhook_resolve_delivery
--                                      p_org_id asserted by context kind (the
--                                      0061 PART 3A idiom)
--   PART 3  scheduler_admin_delete     needs a person context holding
--                                      jobs.delete; deletes in that person's
--                                      organization only
--   PART 4  record_login_event         a supplied organization must be the
--                                      login's (or the email's) organization
--   PART 5  authz.next_identity_code   no longer executable by app_user; the new
--                                      authz.next_identity_code_for_current_org
--                                      advances only the caller's own org.
--                                      Nested callers (bootstrap, invitation
--                                      acceptance) run as the function owner
--                                      and are unaffected.
--   PART 6  integration_inbound_set_receipt_status
--                                      takes the endpoint key hash and verifies
--                                      it against the receipt's connection (the
--                                      write_receipt rule); the old 3-argument
--                                      signature is dropped
--   PART 7  person_holds_protected_role
--                                      needs a person context; own org only
--   PART 8  scheduler_tick_claim, claim_due_task_reminders,
--           jobs_sweep_retryable, worker_next_due_at,
--           integration_inbound_resolve_endpoint
--                                      ACTIVE, non-deleted organizations only
--   PART 9  verification
--
-- NOT CHANGED — DOCUMENTED RESIDUAL: public.resolve_login_org(email) remains an
-- email → organization lookup callable without identity, because sign-in needs
-- it before anyone is authenticated. Its answer (an organization id) is never
-- returned by any API response.
--
-- DEFERRED: dedicated worker and platform database roles (app_worker,
-- app_platform) are a separate infrastructure package. Until then, "refuses a
-- person context" is what keeps tenant requests away from worker-only functions.
--
-- The organization predicates below are inline EXISTS clauses, not a helper
-- function: a SECURITY DEFINER SQL function is never inlined, so a helper would
-- be called once per scanned row; the inline form plans as a primary-key probe
-- of organizations. FOR UPDATE does not extend to tables inside a WHERE-clause
-- subquery, so no organization row is ever locked by these claims.
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — jobs_claim_next
-- ═════════════════════════════════════════════════════════════════════════════
-- A claim hands back the whole job row, payload included, so a tenant request
-- must never be able to make one.
create or replace function public.jobs_claim_next(p_worker_id text, p_types text[])
returns public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.jobs%rowtype;
begin
  if (select authz.person_id()) is not null then
    raise exception 'jobs_claim_next is worker-plane only'
      using errcode = '42501';
  end if;

  with candidate as (
    select id
    from public.jobs
    where status = 'pending'
      and next_run_at <= now()
      and (p_types is null or type = any(p_types))
      and exists (
        select 1 from public.organizations o
        where o.id = jobs.org_id and o.status = 'ACTIVE' and o.deleted_at is null
      )
    order by priority desc, next_run_at asc
    limit 1
    for update skip locked
  )
  update public.jobs j
  set status = 'claimed',
      claimed_by = p_worker_id,
      claimed_at = now(),
      heartbeat_at = now(),
      updated_at = now()
  from candidate c
  where j.id = c.id
  returning j.* into v_job;
  return v_job;
end;
$$;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — integration_webhook_resolve_delivery
-- ═════════════════════════════════════════════════════════════════════════════
-- Its only caller is the webhook-delivery job handler, which runs under the
-- system actor with app.org_id bound to the JOB ROW's organization. Assert by
-- context kind, exactly as 0061 PART 3A does: with a person, p_org_id must be
-- that person's organization; without one, it must be the bound app.org_id.
-- (sql → plpgsql so the assertion runs before the read; same result set.)
create or replace function public.integration_webhook_resolve_delivery(
  p_org_id uuid,
  p_subscription_id uuid
)
returns table (is_active boolean, signing_secret_ciphertext text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select authz.person_id()) is not null then
    if p_org_id is distinct from (select authz.org_id()) then
      raise exception 'integration_webhook_resolve_delivery: organization mismatch'
        using errcode = '42501';
    end if;
  elsif p_org_id is distinct from nullif(current_setting('app.org_id', true), '')::uuid then
    raise exception 'integration_webhook_resolve_delivery: organization mismatch'
      using errcode = '42501';
  end if;

  return query
  select s.active, s.signing_secret_ciphertext
  from public.integration_webhook_subscriptions s
  where s.org_id = p_org_id
    and s.id = p_subscription_id;
end;
$$;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — scheduler_admin_delete
-- ═════════════════════════════════════════════════════════════════════════════
-- Hard delete of a schedule (schedules has no DELETE policy by design). The
-- caller (src/lib/jobs/scheduler.ts deleteSchedule) now calls this inside its
-- own identity transaction, after its visibility check; the function
-- re-derives the organization from that identity and requires jobs.delete. A
-- schedule of another organization is treated like a missing one: nothing is
-- deleted and no error is raised (unchanged for a missing one).
create or replace function public.scheduler_admin_delete(p_schedule_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select authz.person_id()) is null or not (select authz.is_active()) then
    raise exception 'scheduler_admin_delete requires an authorized transaction'
      using errcode = '42501';
  end if;
  if not (select authz.has('jobs.delete')) then
    raise exception 'scheduler_admin_delete requires jobs.delete'
      using errcode = '42501';
  end if;

  delete from public.schedules
  where id = p_schedule_id
    and org_id = (select authz.org_id());
end;
$$;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 4 — record_login_event
-- ═════════════════════════════════════════════════════════════════════════════
-- Called before authentication (src/lib/auth/login-events.ts, no identity) and
-- nested inside accept_invitation (0031). Neither can assert a person context,
-- so a supplied organization is checked against what the event itself names:
-- it must be the organization of the login's person (p_auth_user_id), or the
-- organization the email resolves to (resolve_login_org — what every
-- pre-authentication caller passes). Anything else raises 42501. NULL stays
-- NULL (unchanged behaviour for addresses that resolve to nobody).
create or replace function public.record_login_event(
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

  if p_org_id is not null
     and not exists (
       select 1 from public.people p
       where p_auth_user_id is not null
         and p.auth_user_id = p_auth_user_id
         and p.org_id = p_org_id
         and p.deleted_at is null
     )
     and (p_email is null or public.resolve_login_org(p_email) is distinct from p_org_id) then
    raise exception 'record_login_event: the organization is not the login''s organization'
      using errcode = '42501';
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

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 5 — identity codes: the runtime role allocates for its own org only
-- ═════════════════════════════════════════════════════════════════════════════
-- authz.next_identity_code(org, …) is unchanged and keeps serving its nested,
-- owner-run callers (bootstrap_organization 0015, accept_invitation 0031) and
-- app_admin. The runtime role loses direct EXECUTE: a nested call inside a
-- definer cannot be told apart from a direct one by context alone, so the only
-- way to stop app_user advancing ANOTHER organization's counter is to route its
-- calls through a function that takes no organization at all.
revoke execute on function authz.next_identity_code(uuid, text, text) from app_user;

create function authz.next_identity_code_for_current_org(
  p_code_type text,
  p_period text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  v_org_id := (select authz.org_id());
  if (select authz.person_id()) is null or v_org_id is null then
    raise exception 'next_identity_code_for_current_org requires an authorized transaction'
      using errcode = '42501';
  end if;
  return authz.next_identity_code(v_org_id, p_code_type, p_period);
end;
$$;

comment on function authz.next_identity_code_for_current_org(text, text) is
  'The runtime role''s way to allocate an identity code (EMP-2026-0001, INV-…): advances '
  'the counter of the caller''s own organization, derived from the transaction identity. '
  'authz.next_identity_code(org, …) itself is not executable by app_user (0068).';

revoke all on function authz.next_identity_code_for_current_org(text, text) from public;
grant execute on function authz.next_identity_code_for_current_org(text, text) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 6 — integration_inbound_set_receipt_status
-- ═════════════════════════════════════════════════════════════════════════════
-- The inbound pipeline holds the presented endpoint key hash for the whole
-- request; the status transition now proves it, as write_receipt does. A
-- receipt that does not exist still returns false; one whose connection's key
-- does not match raises 42501. The old 3-argument signature is dropped so no
-- unverified path remains.
drop function public.integration_inbound_set_receipt_status(uuid, text, boolean);

create function public.integration_inbound_set_receipt_status(
  p_receipt_id uuid,
  p_endpoint_key_hash text,
  p_status text,
  p_mark_processed boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_updated integer;
begin
  select e.org_id into v_org_id
  from public.integration_inbound_events e
  where e.id = p_receipt_id;

  if v_org_id is null then
    return false;
  end if;

  if not exists (
    select 1
    from public.integration_inbound_events e
    join public.integration_connections c
      on c.id = e.connection_id
     and c.org_id = e.org_id
    where e.id = p_receipt_id
      and c.inbound_endpoint_key_hash = p_endpoint_key_hash
  ) then
    raise exception 'integration_inbound_set_receipt_status: endpoint verification failed'
      using errcode = '42501';
  end if;

  update public.integration_inbound_events e
  set status = p_status,
      processed_at = case when p_mark_processed then now() else e.processed_at end
  where e.id = p_receipt_id
    and e.org_id = v_org_id;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

comment on function public.integration_inbound_set_receipt_status(uuid, text, text, boolean) is
  'SECURITY DEFINER: moves one inbound receipt to p_status after verifying the presented '
  'endpoint key hash against the receipt''s connection (0068). Returns false when the '
  'receipt does not exist; raises 42501 when the key does not match.';

revoke all on function public.integration_inbound_set_receipt_status(uuid, text, text, boolean) from public;
grant execute on function public.integration_inbound_set_receipt_status(uuid, text, text, boolean) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 7 — person_holds_protected_role
-- ═════════════════════════════════════════════════════════════════════════════
-- Its only caller (src/lib/admin/credential-reset.ts) runs in the admin's own
-- identity and asks about people of the admin's own organization.
-- (sql → plpgsql so the assertion runs before the read; same answer.)
create or replace function public.person_holds_protected_role(p_person_id uuid, p_org_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select authz.person_id()) is null
     or p_org_id is distinct from (select authz.org_id()) then
    raise exception 'person_holds_protected_role: own organization only'
      using errcode = '42501';
  end if;

  return exists (
    select 1
    from public.person_roles pr
    join public.roles r on r.id = pr.role_id and r.org_id = pr.org_id
    where pr.person_id = p_person_id
      and pr.org_id = p_org_id
      and (pr.expires_at is null or pr.expires_at > now())
      and r.deleted_at is null
      and r.status = 'ACTIVE'
      -- role_is_protected(): the explicit is_protected flag OR the derived
      -- protection — a role carrying roles.manage / permissions.manage. Protection
      -- follows the capability, so an unflagged role cannot become an escape hatch.
      and public.role_is_protected(r.id)
  );
end;
$$;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 8 — background work for ACTIVE, non-deleted organizations only
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.scheduler_tick_claim(p_now timestamptz)
returns setof public.schedules
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select s.*
  from public.schedules s
  where s.is_active
    and s.next_run_at <= p_now
    and exists (
      select 1 from public.organizations o
      where o.id = s.org_id and o.status = 'ACTIVE' and o.deleted_at is null
    )
  order by s.next_run_at asc
  for update;
end;
$$;

create or replace function public.claim_due_task_reminders(p_limit integer)
returns table (
  reminder_id uuid, org_id uuid, task_id uuid, person_id uuid,
  remind_at timestamptz, task_title text, task_live boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Fail fast on a wiring bug: the limit is embedded by the caller, so
  -- validate before touching rows (mirrors jobs_sweep_retryable, 0049).
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'INVALID_REQUEST: p_limit must be an integer between 1 and 1000';
  end if;

  return query
  with due as (
    select r.id
    from public.task_reminders r
    where not r.is_sent
      and r.remind_at <= now()
      and exists (
        select 1 from public.organizations o
        where o.id = r.org_id and o.status = 'ACTIVE' and o.deleted_at is null
      )
    order by r.remind_at asc, r.id asc
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.task_reminders r
    set is_sent = true
    from due
    where r.id = due.id
    returning r.id, r.org_id, r.task_id, r.person_id, r.remind_at
  )
  select
    c.id,
    c.org_id,
    c.task_id,
    c.person_id,
    c.remind_at,
    t.title,
    (t.id is not null and t.deleted_at is null)
  from claimed c
  left join public.work_tasks t
    on t.id = c.task_id
   and t.org_id = c.org_id;
end;
$$;

create or replace function public.jobs_sweep_retryable(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  -- Fail fast on a wiring bug: limit is embedded by the caller, so validate
  -- before touching rows (mirrors the old buildRetrySweepUpdate guards).
  if p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'INVALID_REQUEST: p_limit must be an integer between 1 and 10000';
  end if;

  -- Postgres UPDATE takes no ORDER BY/LIMIT: a bounded id-subquery picks the
  -- oldest-due rows first. The outer WHERE repeats status='failed' so a row a
  -- manual retry already flipped is never re-swept (atomic race guard).
  -- A failed job of an organization that is not ACTIVE stays failed (0068).
  update public.jobs j
  set status = 'pending',
      claimed_by = null,
      claimed_at = null,
      heartbeat_at = null,
      next_run_at = now(),
      updated_at = now()
  where j.id in (
    select id
    from public.jobs
    where status = 'failed'
      and next_run_at <= now()
      and attempts < max_attempts
      and exists (
        select 1 from public.organizations o
        where o.id = jobs.org_id and o.status = 'ACTIVE' and o.deleted_at is null
      )
    order by next_run_at asc
    limit p_limit
  )
    and j.status = 'failed';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- In-flight claims are NOT filtered: a job claimed before its organization was
-- suspended must still be reaped if its worker dies; once reaped it is pending
-- and, like every other pending job of that organization, is not due.
create or replace function public.worker_next_due_at()
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select authz.person_id()) is not null then
    raise exception 'worker_next_due_at is worker-plane only'
      using errcode = '42501';
  end if;

  return least(
    (select min(j.next_run_at) from public.jobs j
      where j.status = 'pending'
        and exists (select 1 from public.organizations o
                     where o.id = j.org_id and o.status = 'ACTIVE' and o.deleted_at is null)),
    (select min(j.next_run_at) from public.jobs j
      where j.status = 'failed' and j.attempts < j.max_attempts
        and exists (select 1 from public.organizations o
                     where o.id = j.org_id and o.status = 'ACTIVE' and o.deleted_at is null)),
    (select min(coalesce(j.heartbeat_at, j.claimed_at)) + interval '60 seconds'
       from public.jobs j
      where j.status in ('claimed', 'running')),
    (select min(r.remind_at) from public.task_reminders r
      where not r.is_sent
        and exists (select 1 from public.organizations o
                     where o.id = r.org_id and o.status = 'ACTIVE' and o.deleted_at is null)),
    (select min(s.next_run_at) from public.schedules s
      where s.is_active
        and exists (select 1 from public.organizations o
                     where o.id = s.org_id and o.status = 'ACTIVE' and o.deleted_at is null))
  );
end;
$$;

-- An endpoint of an organization that is not ACTIVE resolves to nothing, which
-- the inbound route already answers with its uniform rejection.
create or replace function public.integration_inbound_resolve_endpoint(p_endpoint_key_hash text)
returns table (
  connection_id uuid, org_id uuid, provider_key text, status text,
  config jsonb, connected_by uuid, endpoint_key_hash text
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.org_id, c.provider_key, c.status, c.config, c.connected_by,
         c.inbound_endpoint_key_hash
  from public.integration_connections c
  where c.inbound_endpoint_key_hash = p_endpoint_key_hash
    and exists (
      select 1 from public.organizations o
      where o.id = c.org_id and o.status = 'ACTIVE' and o.deleted_at is null
    );
$$;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 9 — verification
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_problems text;
begin
  with fns(sig) as (
    values
      ('public.jobs_claim_next(text,text[])'),
      ('public.integration_webhook_resolve_delivery(uuid,uuid)'),
      ('public.scheduler_admin_delete(uuid)'),
      ('public.record_login_event(uuid,text,public.citext,uuid,inet,text,jsonb)'),
      ('authz.next_identity_code(uuid,text,text)'),
      ('authz.next_identity_code_for_current_org(text,text)'),
      ('public.integration_inbound_set_receipt_status(uuid,text,text,boolean)'),
      ('public.person_holds_protected_role(uuid,uuid)'),
      ('public.scheduler_tick_claim(timestamptz)'),
      ('public.claim_due_task_reminders(integer)'),
      ('public.jobs_sweep_retryable(integer)'),
      ('public.worker_next_due_at()'),
      ('public.integration_inbound_resolve_endpoint(text)')
  )
  select string_agg(problem, '; ') into v_problems
  from (
    select f.sig || ' is missing' as problem
    from fns f
    where to_regprocedure(f.sig) is null
    union all
    select f.sig || ' is not SECURITY DEFINER with search_path pinned to empty'
    from fns f
    join pg_proc p on p.oid = to_regprocedure(f.sig)
    where not p.prosecdef
       or not coalesce('search_path=""' = any (p.proconfig), false)
    union all
    select f.sig || ' is not owned by app_owner'
    from fns f
    join pg_proc p on p.oid = to_regprocedure(f.sig)
    where pg_get_userbyid(p.proowner) <> 'app_owner'
    union all
    select f.sig || ' is executable by PUBLIC'
    from fns f
    join pg_proc p on p.oid = to_regprocedure(f.sig)
    where exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE'
    )
    union all
    select 'app_user can still execute authz.next_identity_code directly'
    where has_function_privilege('app_user', 'authz.next_identity_code(uuid,text,text)', 'execute')
    union all
    select 'app_user cannot execute ' || s
    from unnest(array[
      'authz.next_identity_code_for_current_org(text,text)',
      'public.integration_inbound_set_receipt_status(uuid,text,text,boolean)',
      'public.jobs_claim_next(text,text[])',
      'public.scheduler_admin_delete(uuid)',
      'public.record_login_event(uuid,text,public.citext,uuid,inet,text,jsonb)'
    ]) s
    where not has_function_privilege('app_user', s, 'execute')
    union all
    select 'the unverified 3-argument integration_inbound_set_receipt_status still exists'
    where to_regprocedure('public.integration_inbound_set_receipt_status(uuid,text,boolean)') is not null
  ) problems;

  if v_problems is not null then
    raise exception '0068 elevated function boundaries incomplete: %', v_problems;
  end if;
end;
$$;
