-- ═════════════════════════════════════════════════════════════════════════════
-- 0069_password_reset_email_content — the password-reset email body leaves the
-- job payload
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE VULNERABILITY. enqueue_password_reset_email() (0061) stored the whole
-- reset email — html carrying `/reset-password?token=<plaintext token>` — in
-- public.jobs.payload. jobs_select admits any holder of jobs.view (SUPER_ADMIN,
-- ADMIN, PROJECT_MANAGER; the policy checks the permission, not its scope) and
-- GET /api/jobs returns payloads. Anyone can request a reset for any address
-- before signing in, so a PROJECT_MANAGER could request one for a colleague and
-- read the link from the jobs list before the colleague did — a takeover of any
-- account in the organization without an enrolled second factor.
--
-- THE FIX.
--   PART 1  public.job_email_content — the email body, keyed by job. No
--           application role holds any privilege on it; RLS is FORCED with an
--           owner-only policy. It is reachable only through the two definers
--           below.
--   PART 2  enqueue_password_reset_email() — same signature and behaviour for
--           its caller; the payload now carries only { to, subject,
--           contentRef } and the body goes into job_email_content.
--   PART 3  job_email_content_for_worker(job_id, worker_id) — the worker's
--           only read path: serves the job the caller holds (status running,
--           claimed_by = worker id), refuses any signed-in caller.
--   PART 4  the body is deleted when its job reaches a terminal state
--           (succeeded, dead_letter, cancelled); a retryable failure keeps it.
--   PART 5  existing reset jobs: the body is moved out of every payload (live
--           jobs keep it in job_email_content; finished ones lose it).
--   PART 6  verification.
--
-- Not changed: token generation, hashing, expiry and single use
-- (auth.password_resets, consume_password_reset), the reset routes, MFA, and
-- every other email job (their payload is business content, not a credential).
--
-- RESIDUAL (documented, docs/architecture/security.md): until the worker has
-- its own database role (app_worker), a caller able to run raw SQL as app_user
-- with no identity can claim a job and call the worker reader. Such a caller
-- can already set any password directly through
-- authz.update_credential_password, so this adds no capability; the
-- person-context paths — the demonstrated attack — are closed here.
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — public.job_email_content
-- ═════════════════════════════════════════════════════════════════════════════
create table public.job_email_content (
  job_id uuid primary key references public.jobs (id) on delete cascade,
  org_id uuid not null references public.organizations (id),
  subject text not null,
  html text,
  text_body text,
  created_at timestamptz not null default now(),
  constraint job_email_content_has_body check (html is not null or text_body is not null)
);

comment on table public.job_email_content is
  'Bodies of email jobs that carry a credential (the password-reset link). Readable by no '
  'application role: written by enqueue_password_reset_email(), read only through '
  'job_email_content_for_worker() by the worker holding the job, deleted when the job is '
  'terminal (0069).';

alter table public.job_email_content enable row level security;
alter table public.job_email_content force row level security;

create policy job_email_content_owner_all on public.job_email_content
  for all to app_owner
  using (true)
  with check (true);

-- roles.sql's default privileges grant app_user select/insert/update on every
-- new public table; this table is the exception.
revoke all on public.job_email_content from public, app_user, app_admin;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — enqueue_password_reset_email: the payload no longer carries the body
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.enqueue_password_reset_email(
  p_reset_id uuid,
  p_subject text,
  p_html text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth_user_id uuid;
  v_org_id uuid;
  v_email text;
  v_job_id uuid;
  v_dedup_key text := 'pwreset:' || p_reset_id::text;
begin
  select pr.auth_user_id into v_auth_user_id
  from auth.password_resets pr
  where pr.id = p_reset_id
    and pr.used_at is null
    and pr.expires_at > now();

  if v_auth_user_id is null then
    return null;
  end if;

  select p.org_id into v_org_id
  from public.people p
  where p.auth_user_id = v_auth_user_id
    and p.deleted_at is null;

  select u.email::text into v_email
  from auth.auth_users u
  where u.id = v_auth_user_id;

  if v_org_id is null or v_email is null then
    return null;
  end if;

  -- The payload names the recipient and the subject (what the jobs list
  -- shows); the body — the link — is referenced, never inlined.
  insert into public.jobs (org_id, type, payload, dedup_key)
  values (
    v_org_id,
    'email',
    jsonb_build_object('to', v_email, 'subject', p_subject, 'contentRef', 'job_email_content'),
    v_dedup_key
  )
  on conflict (org_id, dedup_key) where dedup_key is not null do nothing
  returning id into v_job_id;

  if v_job_id is null then
    -- The job already exists (a raced or retried enqueue): return its id.
    select j.id into v_job_id
    from public.jobs j
    where j.org_id = v_org_id
      and j.dedup_key = v_dedup_key;
  else
    insert into public.job_email_content (job_id, org_id, subject, html)
    values (v_job_id, v_org_id, p_subject, p_html);
  end if;

  return v_job_id;
end;
$$;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — the worker's read path
-- ═════════════════════════════════════════════════════════════════════════════
create function public.job_email_content_for_worker(p_job_id uuid, p_worker_id text)
returns table (subject text, html text, text_body text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- Worker plane only: a signed-in request never reads an email body.
  if (select authz.person_id()) is not null then
    raise exception 'job_email_content_for_worker is worker-plane only'
      using errcode = '42501';
  end if;

  -- Only the job this worker holds: running, and claimed under this worker id
  -- (the jobs_start ownership check put it there).
  if p_worker_id is null or not exists (
    select 1 from public.jobs j
    where j.id = p_job_id
      and j.type = 'email'
      and j.status = 'running'
      and j.claimed_by = p_worker_id
  ) then
    raise exception 'job_email_content_for_worker: the job is not held by this worker'
      using errcode = '42501';
  end if;

  return query
  select c.subject, c.html, c.text_body
  from public.job_email_content c
  join public.jobs j on j.id = c.job_id and j.org_id = c.org_id
  where c.job_id = p_job_id;
end;
$$;

comment on function public.job_email_content_for_worker(uuid, text) is
  'Worker-plane read of a protected email body: only for the email job the caller holds '
  '(running, claimed_by = p_worker_id); refuses a person context (0069).';

revoke all on function public.job_email_content_for_worker(uuid, text) from public;
grant execute on function public.job_email_content_for_worker(uuid, text) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 4 — the body is forgotten when the job is finished
-- ═════════════════════════════════════════════════════════════════════════════
create function public.job_email_content_forget() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.job_email_content where job_id = new.id;
  return null;
end;
$$;

revoke all on function public.job_email_content_forget() from public;

create trigger jobs_forget_email_content
  after update of status on public.jobs
  for each row
  when (new.status in ('succeeded', 'dead_letter', 'cancelled')
        and old.status is distinct from new.status)
  execute function public.job_email_content_forget();

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 5 — move the body out of every existing reset job
-- ═════════════════════════════════════════════════════════════════════════════
-- A job's payload is frozen (jobs_identity_freeze, 0061); this one-off rewrite
-- is the documented exception, made by the owner inside this migration's
-- transaction. Live jobs keep their body in job_email_content; finished ones
-- simply lose it (their token is used, expired or superseded).
insert into public.job_email_content (job_id, org_id, subject, html, text_body)
select j.id, j.org_id, coalesce(j.payload->>'subject', ''), j.payload->>'html', j.payload->>'text'
from public.jobs j
where j.type = 'email'
  and j.dedup_key like 'pwreset:%'
  and (j.payload ? 'html' or j.payload ? 'text')
  and j.status not in ('succeeded', 'dead_letter', 'cancelled')
on conflict (job_id) do nothing;

alter table public.jobs disable trigger jobs_identity_freeze;

update public.jobs j
set payload = (j.payload - 'html' - 'text')
              || jsonb_build_object('contentRef', 'job_email_content')
where j.type = 'email'
  and j.dedup_key like 'pwreset:%'
  and (j.payload ? 'html' or j.payload ? 'text');

alter table public.jobs enable trigger jobs_identity_freeze;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 6 — verification
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_problems text;
begin
  select string_agg(problem, '; ') into v_problems
  from (
    select 'job_email_content: RLS not enabled and forced' as problem
    where not exists (
      select 1 from pg_class c
      where c.oid = 'public.job_email_content'::regclass
        and c.relrowsecurity and c.relforcerowsecurity
    )
    union all
    select 'job_email_content: ' || r || ' holds ' || p
    from unnest(array['app_user', 'app_admin']) r,
         unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
    where has_table_privilege(r, 'public.job_email_content', p)
    union all
    select 'job_email_content: a policy admits a role other than app_owner'
    where exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'job_email_content'
        and roles <> array['app_owner']::name[]
    )
    union all
    select f.sig || ' is not SECURITY DEFINER with search_path pinned to empty'
    from (values
      ('public.enqueue_password_reset_email(uuid,text,text)'),
      ('public.job_email_content_for_worker(uuid,text)'),
      ('public.job_email_content_forget()')
    ) as f(sig)
    join pg_proc p on p.oid = to_regprocedure(f.sig)
    where not p.prosecdef or not coalesce('search_path=""' = any (p.proconfig), false)
    union all
    select 'job_email_content_for_worker is executable by PUBLIC'
    where exists (
      select 1 from pg_proc p,
           aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = 'public.job_email_content_for_worker(uuid,text)'::regprocedure
        and a.grantee = 0 and a.privilege_type = 'EXECUTE'
    )
    union all
    select 'enqueue_password_reset_email still writes the body into the payload'
    from pg_proc p
    where p.oid = 'public.enqueue_password_reset_email(uuid,text,text)'::regprocedure
      and (strpos(p.prosrc, '''html'', p_html') > 0
           or strpos(p.prosrc, 'insert into public.job_email_content') = 0)
    union all
    select 'job_email_content_for_worker does not bind to the held job'
    from pg_proc p
    where p.oid = 'public.job_email_content_for_worker(uuid,text)'::regprocedure
      and (strpos(p.prosrc, 'j.claimed_by = p_worker_id') = 0
           or strpos(p.prosrc, 'authz.person_id()') = 0)
    union all
    select 'the jobs_forget_email_content trigger is missing or disabled'
    where not exists (
      select 1 from pg_trigger
      where tgname = 'jobs_forget_email_content'
        and tgrelid = 'public.jobs'::regclass and tgenabled = 'O'
    )
    union all
    select 'jobs_identity_freeze is not enabled again'
    where not exists (
      select 1 from pg_trigger
      where tgname = 'jobs_identity_freeze'
        and tgrelid = 'public.jobs'::regclass and tgenabled = 'O'
    )
    union all
    select count(*)::text || ' reset job payload(s) still carry an email body'
    from public.jobs j
    where j.dedup_key like 'pwreset:%' and (j.payload ? 'html' or j.payload ? 'text')
    having count(*) > 0
  ) problems;

  if v_problems is not null then
    raise exception '0069 password-reset content protection incomplete: %', v_problems;
  end if;
end;
$$;
