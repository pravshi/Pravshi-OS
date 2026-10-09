-- PRAVSHI OS — Phase 11 (Security Hardening), Wave A: database hardening —
-- SECURITY DEFINER context assertions (F-11-01, F-11-02) and
-- identity-freeze triggers (F-11-03, F-11-13). No tables, no data changes,
-- no new permissions (the catalogue stays at 127); function/trigger
-- definitions only, so it applies identically on fresh and upgraded chains.
--
-- PART 1 — public.ai_effective_limits(uuid): the claimed org is asserted
--   against the transaction context (F-11-01).
-- PART 2 — public.ai_usage_counters(uuid, uuid): org assertion, plus the
--   person assertion with the contracted ai.usage.view exception (F-11-01).
-- PART 3 — public.notification_channel_enabled(uuid, uuid, text, text):
--   org assertion (F-11-02, the member of the family whose callers all run
--   under a real person's context).
-- PART 3A — public.notifications_insert(uuid, uuid, text, text, jsonb,
--   text, text) and public.notifications_recipient_exists(uuid, uuid):
--   the context-kind org assertion (F-11-02 — see the resolution note
--   below): person contexts assert against authz.org_id(); the
--   person-less worker plane asserts against its bound org claim.
-- PART 4 — identity-freeze triggers on jobs / schedules / workflows /
--   ai_usage_requests (F-11-03, F-11-13), the 0056 mechanism.
-- PART 5 — public.enqueue_password_reset_email(uuid, text, text): the one
--   pre-auth job-enqueue path (Wave C coordination, F-11-06). Every other
--   enqueue requires a live person's jobs.create by design; this narrow
--   definer is the reset flow's exception — org and recipient are derived
--   from the reset row, only the email content is a parameter.
-- PART 6 — verification: fail the migration rather than leave a
--   half-hardened schema (the 0047/0060 pattern).
--
-- THE ASSERTION IDIOM (PARTS 1–3; PART 3A extends it by context kind)
--
-- The 0044 workflow definers are the gold standard: a definer that accepts
-- an org/person id asserts it against the transaction context —
-- `p_org_id is distinct from (select authz.org_id())` — and raises 42501
-- on mismatch. authz.org_id() derives the org from the context PERSON
-- (0003: the org is a property of the person; the app.org_id claim can only
-- deny, never grant), so a context-free call has org_id() = NULL, the
-- assertion can never hold for it, and it refuses — fail closed. The two
-- 0054 AI functions were written without the assertion; PARTS 1–2 bring
-- them to the standard without changing their signatures, return shapes or
-- counting rules. Every current call site passes the caller's own
-- org/person (src/lib/ai/usage.ts selectEffectiveLimits / selectCounters,
-- reached from readAiLimits / readAiUsageCounters / evaluateAiLimits), so
-- no caller changes. Both functions are re-declared in plpgsql (from
-- language sql) solely so the assertion can raise; bodies are otherwise
-- verbatim.
--
-- F-11-02 RESOLUTION NOTE (Wave A stop, resolved by Lead decision)
--
-- Wave A stopped on notifications_insert and notifications_recipient_exists:
-- §4.1 contracts the same org assertion for them, but the plain assertion
-- (p_org_id = authz.org_id()) can never hold on their only call path. The
-- notification job handler (src/lib/jobs/handlers.ts handleNotification /
-- assertPersonInOrg) runs on the worker plane as the system actor
-- (buildJobAuthorization, src/lib/jobs/worker.ts): the system actor is not
-- a people row, so authz.person_id() and authz.org_id() are both NULL in
-- that context — the handler's own comment records that the definer path
-- exists precisely because the system actor cannot satisfy person-derived
-- checks. The contracted assertion would therefore raise 42501 on EVERY
-- worker-plane notification insert, breaking notification delivery
-- outright; the audit's compatibility premise ("the worker-plane call
-- satisfies the assertion") does not hold against the 0003 helpers.
--
-- Resolution (PART 3A): assert by CONTEXT KIND. When a person context
-- exists (authz.person_id() is not null), the 0044 idiom applies unchanged
-- — p_org_id must equal authz.org_id(), and a mismatch or NULL refuses
-- 42501. When the context is person-less, the identity is the org claim
-- the context itself carries: buildJobAuthorization binds app.org_id to
-- the JOB ROW's org (never the payload) and withAuthorizedDb
-- (src/lib/db/authorized.ts) sets it on the handler's transaction, so
-- p_org_id must equal nullif(current_setting('app.org_id', true), '')::uuid
-- — the same value the handler passes from that same job row. An absent
-- or mismatched claim refuses 42501, exactly as a mismatched person-org
-- does. The family's third member, notification_channel_enabled, is
-- asserted with the plain idiom (PART 3): its only caller
-- (src/lib/notifications/preferences.ts isChannelEnabled) runs under the
-- CREATOR's real-person context and passes that person's own org. The
-- notifications person_org guard trigger remains the insert-time second
-- layer: it enforces the recipient's org at write time whatever the
-- assertion saw. record_login_event keeps its audited no-assertion
-- disposition (§4.1: pre-auth by design; event-type allowlist +
-- append-only table are its mitigations).

-- ═════════════════════════════════════════════════════════════════════════
-- PART 1 — ai_effective_limits: org assertion (F-11-01)
-- ═════════════════════════════════════════════════════════════════════════

create or replace function public.ai_effective_limits(p_org_id uuid)
returns table (
  enabled boolean,
  monthly_request_limit int,
  monthly_token_limit int,
  max_requests_per_minute_per_user int,
  max_concurrent_requests int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_org_id is distinct from (select authz.org_id()) then
    raise exception 'org_id mismatch' using errcode = '42501';
  end if;

  return query
    select
      coalesce(l.enabled, true),
      coalesce(l.monthly_request_limit, 5000),
      coalesce(l.monthly_token_limit, 2000000),
      coalesce(l.max_requests_per_minute_per_user, 10),
      coalesce(l.max_concurrent_requests, 4)
    from (select 1) as one
    left join public.ai_org_limits l on l.org_id = p_org_id;
end;
$$;

comment on function public.ai_effective_limits(uuid) is
  'Effective AI limits for one org: the ai_org_limits row merged over the '
  'contract §8.2 code defaults. SECURITY DEFINER: the limit check must run '
  'for ai.use holders who do not hold ai.usage.view. Returns one merged row. '
  'Phase 11 (F-11-01): asserts p_org_id = authz.org_id() and raises 42501 '
  'otherwise — a caller may only ever read its own org''s limits.';

revoke all on function public.ai_effective_limits(uuid) from public;
grant execute on function public.ai_effective_limits(uuid) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- PART 2 — ai_usage_counters: org + person assertions (F-11-01)
-- ═════════════════════════════════════════════════════════════════════════
--
-- Person rule (§4.1): the per-minute window names a person, so the caller
-- reads either its OWN cadence (p_person_id = authz.person_id()) or, when
-- it holds ai.usage.view in the context org, another person's (the admin
-- usage read). The audit's third exception — the system actor — is
-- unreachable here and deliberately not coded (audit §6 Q8: the exception
-- list must not grow by accretion): a system-actor context has no
-- person-derived org, so it has already refused at the org assertion.
-- The counting rules are 0054's, unchanged (including the carried Phase 9
-- F1 note: the per-minute window counts NOT_CONFIGURED rows, the monthly
-- windows exclude them — fail-closed, disposition unchanged).

create or replace function public.ai_usage_counters(p_org_id uuid, p_person_id uuid)
returns table (
  month_requests bigint,
  month_tokens bigint,
  last_minute_requests bigint,
  in_flight bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_org_id is distinct from (select authz.org_id()) then
    raise exception 'org_id mismatch' using errcode = '42501';
  end if;

  if p_person_id is distinct from (select authz.person_id())
     and not (select authz.has('ai.usage.view')) then
    raise exception 'person_id mismatch' using errcode = '42501';
  end if;

  return query
    select
      (select count(*)
         from public.ai_usage_requests r
        where r.org_id = p_org_id
          and r.status in ('SUCCEEDED', 'FAILED')
          and r.created_at >= (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC')),
      (select coalesce(sum(r.total_tokens), 0)
         from public.ai_usage_requests r
        where r.org_id = p_org_id
          and r.status = 'SUCCEEDED'
          and r.created_at >= (date_trunc('month', now() at time zone 'UTC') at time zone 'UTC')),
      (select count(*)
         from public.ai_usage_requests r
        where r.org_id = p_org_id
          and r.person_id = p_person_id
          and r.status <> 'LIMITED'
          and r.created_at >= now() - interval '60 seconds'),
      (select count(*)
         from public.ai_usage_requests r
        where r.org_id = p_org_id
          and r.status = 'STARTED'
          and r.created_at >= now() - interval '5 minutes');
end;
$$;

comment on function public.ai_usage_counters(uuid, uuid) is
  'Usage counters for one org (and one person for the per-minute window), per '
  'the contract §8.2 counting rules. SECURITY DEFINER: callable by ai.use '
  'holders without ai.usage.view. Returns four aggregate numbers only. '
  'Phase 11 (F-11-01): asserts p_org_id = authz.org_id(); the named person '
  'must be the caller unless the caller holds ai.usage.view (42501 otherwise).';

revoke all on function public.ai_usage_counters(uuid, uuid) from public;
grant execute on function public.ai_usage_counters(uuid, uuid) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- PART 3 — notification_channel_enabled: org assertion (F-11-02)
-- ═════════════════════════════════════════════════════════════════════════
--
-- The delivery gate runs under the notification creator's identity and
-- passes that identity's own org (src/lib/notifications/preferences.ts),
-- so the gold-standard assertion holds for every legitimate call. The
-- resolution semantics (specific row, then '*' wildcard, then default
-- enabled) are 0052's, unchanged.

create or replace function public.notification_channel_enabled(
  p_org_id uuid,
  p_person_id uuid,
  p_event_type text,
  p_channel text
) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_org_id is distinct from (select authz.org_id()) then
    raise exception 'org_id mismatch' using errcode = '42501';
  end if;

  return coalesce(
    (select np.enabled
       from public.notification_preferences np
      where np.org_id = p_org_id
        and np.person_id = p_person_id
        and np.event_type = p_event_type
        and np.channel = p_channel),
    (select np.enabled
       from public.notification_preferences np
      where np.org_id = p_org_id
        and np.person_id = p_person_id
        and np.event_type = '*'
        and np.channel = p_channel),
    true
  );
end;
$$;

comment on function public.notification_channel_enabled(uuid, uuid, text, text) is
  'Effective enabled flag for one (org, person, event_type, channel) preference: '
  'specific row, then ''*'' wildcard row, then default true. SECURITY DEFINER '
  'because preference rows are own-rows under RLS while the delivery gate runs '
  'under the notification creator''s identity. Returns one boolean only. '
  'Phase 11 (F-11-02): asserts p_org_id = authz.org_id() (42501 otherwise).';

revoke all on function public.notification_channel_enabled(uuid, uuid, text, text) from public;
grant execute on function public.notification_channel_enabled(uuid, uuid, text, text) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- PART 3A — notifications_insert / notifications_recipient_exists:
-- the context-kind org assertion (F-11-02, resolved)
-- ═════════════════════════════════════════════════════════════════════════
--
-- Both functions keep 0052's signatures, defaults, return shapes and body
-- semantics; the only change is the assertion prepended to each body (and,
-- for recipient_exists, the move from language sql to plpgsql so the
-- assertion can raise — the same re-declaration PARTS 1–2 make). The
-- assertion is identical in both and branches on the context kind:
--
--   person context present (authz.person_id() is not null):
--     p_org_id must equal authz.org_id() — the 0044 idiom. A mismatched
--     app.org_id claim makes org_id() NULL under 0003's deny-only rule,
--     so a bad claim refuses here too.
--   person-less context (the worker plane's system actor):
--     p_org_id must equal the app.org_id claim the transaction carries.
--     buildJobAuthorization binds that claim to the job row's org and the
--     handler passes the same job row's org as p_org_id, so every
--     legitimate worker-plane call satisfies it; an absent claim (NULL)
--     or a mismatched one refuses 42501.
--
-- The insert's person_org guard trigger remains the second layer: it
-- enforces the recipient's org at write time whatever the assertion saw.

create or replace function public.notifications_insert(
  p_org_id uuid,
  p_person_id uuid,
  p_title text,
  p_message text,
  p_data jsonb,
  p_type text default 'SYSTEM_ALERT',
  p_event_id text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if (select authz.person_id()) is not null then
    if p_org_id is distinct from (select authz.org_id()) then
      raise exception 'org_id mismatch' using errcode = '42501';
    end if;
  elsif p_org_id is distinct from nullif(current_setting('app.org_id', true), '')::uuid then
    raise exception 'org_id mismatch' using errcode = '42501';
  end if;

  insert into public.notifications (org_id, person_id, title, message, data, type, event_id)
  values (p_org_id, p_person_id, p_title, p_message, coalesce(p_data, '{}'::jsonb), p_type, p_event_id)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.notifications_insert(uuid, uuid, text, text, jsonb, text, text) is
  'SECURITY DEFINER: the notification job handler''s write path. Phase 8 adds '
  'the type column (NOT NULL) and the event_id idempotency key; both arrive as '
  'defaulted parameters so the Phase 6 5-argument call shape keeps working. '
  'org_id comes from the job row and the person_org guard trigger enforces the '
  'recipient''s org. Phase 11 (F-11-02): asserts the claimed org by context '
  'kind — p_org_id = authz.org_id() under a person context; on the person-less '
  'worker plane, p_org_id = the app.org_id claim bound from the job row; '
  '42501 otherwise.';

revoke all on function public.notifications_insert(uuid, uuid, text, text, jsonb, text, text) from public;
grant execute on function public.notifications_insert(uuid, uuid, text, text, jsonb, text, text) to app_user;

--> statement-breakpoint

create or replace function public.notifications_recipient_exists(
  p_org_id uuid,
  p_person_id uuid
) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select authz.person_id()) is not null then
    if p_org_id is distinct from (select authz.org_id()) then
      raise exception 'org_id mismatch' using errcode = '42501';
    end if;
  elsif p_org_id is distinct from nullif(current_setting('app.org_id', true), '')::uuid then
    raise exception 'org_id mismatch' using errcode = '42501';
  end if;

  return exists (
    select 1
    from public.people p
    where p.id = p_person_id
      and p.org_id = p_org_id
      and p.deleted_at is null
  );
end;
$$;

comment on function public.notifications_recipient_exists(uuid, uuid) is
  'True when the named person is a non-deleted member of the given organization. '
  'SECURITY DEFINER because the notification worker''s system actor cannot see '
  'the recipient through people_select RLS. Returns one boolean and no person data. '
  'Phase 11 (F-11-02): asserts the claimed org by context kind — p_org_id = '
  'authz.org_id() under a person context; on the person-less worker plane, '
  'p_org_id = the app.org_id claim bound from the job row; 42501 otherwise.';

revoke all on function public.notifications_recipient_exists(uuid, uuid) from public;
grant execute on function public.notifications_recipient_exists(uuid, uuid) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- PART 4 — identity freeze triggers (F-11-03, F-11-13)
-- ═════════════════════════════════════════════════════════════════════════
--
-- The 0056 mechanism verbatim: a BEFORE UPDATE trigger raising SQLSTATE
-- 23514 when a frozen column changes (RLS policies cannot reference OLD,
-- so the freeze cannot live in a policy). Exactly the identity set is
-- frozen; every column a legitimate plane updates stays mutable. The
-- writer sweep behind each list (every UPDATE in drizzle/ + src/,
-- enumerated 2026-10-09 for this migration):
--
-- jobs — writers: the worker definers jobs_claim_next (0045),
--   jobs_start / jobs_complete / jobs_fail / jobs_heartbeat (0047),
--   jobs_sweep_retryable / jobs_reap_stale (0049), jobs_release_claim /
--   jobs_apply_backoff (0050); the service writers in src/lib/jobs/
--   queue.ts (start/complete/fail/heartbeat/cancel/retry) and the
--   lease-expiry cleanup in src/lib/jobs/handlers.ts. Between them they
--   set ONLY: status, attempts, next_run_at, claimed_by, claimed_at,
--   heartbeat_at, error_code, error_message, updated_at. (priority and
--   max_attempts are likewise never updated after enqueue, but they are
--   not identity and the contract does not freeze them.)
--   payload (§4.2's conditional): NO writer anywhere rewrites it after
--   enqueue — payloads are enqueue-time facts (grep of every UPDATE in
--   drizzle/ and src/ finds no payload assignment) — so payload IS
--   frozen, with this sweep as the recorded evidence. Since 0048 a
--   workflow_run job executes AS its enqueued_by, so freezing
--   enqueued_by + payload + type closes the execution-authority forgery
--   F-11-03 names.
-- schedules — writers: scheduler_tick_fire (0046: last_run_at,
--   next_run_at, updated_at); src/lib/jobs/scheduler.ts pause/resume
--   (is_active, next_run_at, updated_at). workflow_id stays mutable by
--   contract (re-pointing a schedule is a product edit, §4.2/Q4).
-- workflows — writers: src/lib/workflows/service.ts (name, description,
--   trigger, conditions, actions, version, updated_by, status,
--   updated_at; crm_soft_delete sets deleted_at). No SQL definer updates
--   the table.
-- ai_usage_requests — the only writer is the finalize path
--   (src/lib/ai/usage.ts finalizeAiUsageRequest: status, prompt_tokens,
--   completion_tokens, total_tokens, provider_attempts, tool_calls_count,
--   duration_ms, error_code; updated_at via the set_updated_at trigger).
--   The finalize set stays mutable; identity (incl. capability, the
--   metering dimension) freezes (F-11-13).

-- ── jobs ─────────────────────────────────────────────────────────────────

create or replace function public.jobs_identity_freeze() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.type is distinct from old.type
     or new.enqueued_by is distinct from old.enqueued_by
     or new.dedup_key is distinct from old.dedup_key
     or new.payload is distinct from old.payload
     or new.created_at is distinct from old.created_at then
    raise exception
      'a job is identified by its org, type, payload, enqueueing actor and dedup key; those columns are immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.jobs_identity_freeze() is
  'BEFORE UPDATE on jobs: identity columns (id, org_id, type, enqueued_by, '
  'dedup_key, payload, created_at) are frozen; raises 23514 (Phase 11, '
  'F-11-03). The worker lifecycle set (status, attempts, claim/lease/ '
  'heartbeat, next_run_at, error fields) remains mutable.';

revoke all on function public.jobs_identity_freeze() from public;

drop trigger if exists jobs_identity_freeze on public.jobs;
create trigger jobs_identity_freeze
  before update on public.jobs
  for each row execute function public.jobs_identity_freeze();

--> statement-breakpoint

-- ── schedules ────────────────────────────────────────────────────────────

create or replace function public.schedules_identity_freeze() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception
      'a schedule is identified by its org and creator; those columns are immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.schedules_identity_freeze() is
  'BEFORE UPDATE on schedules: identity columns (id, org_id, created_by, '
  'created_at) are frozen; raises 23514 (Phase 11, F-11-03). Cron, name, '
  'activation, run stamps and workflow_id (a product edit) remain mutable.';

revoke all on function public.schedules_identity_freeze() from public;

drop trigger if exists schedules_identity_freeze on public.schedules;
create trigger schedules_identity_freeze
  before update on public.schedules
  for each row execute function public.schedules_identity_freeze();

--> statement-breakpoint

-- ── workflows ────────────────────────────────────────────────────────────

create or replace function public.workflows_identity_freeze() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception
      'a workflow is identified by its org and creator; those columns are immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.workflows_identity_freeze() is
  'BEFORE UPDATE on workflows: identity columns (id, org_id, created_by, '
  'created_at) are frozen; raises 23514 (Phase 11, F-11-03). Definition, '
  'status and soft-delete remain mutable through the service.';

revoke all on function public.workflows_identity_freeze() from public;

drop trigger if exists workflows_identity_freeze on public.workflows;
create trigger workflows_identity_freeze
  before update on public.workflows
  for each row execute function public.workflows_identity_freeze();

--> statement-breakpoint

-- ── ai_usage_requests ────────────────────────────────────────────────────

create or replace function public.ai_usage_requests_identity_freeze() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.person_id is distinct from old.person_id
     or new.capability is distinct from old.capability
     or new.created_at is distinct from old.created_at then
    raise exception
      'a usage request is identified by its org, requester and capability; those columns are immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.ai_usage_requests_identity_freeze() is
  'BEFORE UPDATE on ai_usage_requests: identity columns (id, org_id, '
  'person_id, capability, created_at) are frozen; raises 23514 (Phase 11, '
  'F-11-13). The finalize set (status, token counts, provider attempts, '
  'tool calls, duration, error fields) remains mutable.';

revoke all on function public.ai_usage_requests_identity_freeze() from public;

drop trigger if exists ai_usage_requests_identity_freeze on public.ai_usage_requests;
create trigger ai_usage_requests_identity_freeze
  before update on public.ai_usage_requests
  for each row execute function public.ai_usage_requests_identity_freeze();

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- PART 5 — enqueue_password_reset_email: the pre-auth enqueue (F-11-06)
-- ═════════════════════════════════════════════════════════════════════════
--
-- Wave C decoupled the reset send from the forgot-password response: the
-- token row stays the source of truth and delivery becomes an ordinary
-- `email` job on the Phase 6/10 plane (retry, dead-letter, provider
-- idempotency). The enqueue cannot go through enqueueJob / the
-- jobs_insert policy — both gate on a live person holding jobs.create,
-- and this caller is pre-authentication by definition. This definer is
-- the narrow exception, on the scheduler_tick_fire pattern:
--   * the reset id is the capability — a row that is used or expired
--     (0024's own predicates) enqueues nothing and returns null;
--   * the org is DERIVED from the person row the reset names
--     (people.auth_user_id is one-to-one, 0013), the recipient email
--     from auth.auth_users — neither is ever a caller parameter;
--   * only subject/html are parameters, because only the caller knows
--     the plaintext token the html carries (the DB stores its digest);
--   * dedup_key 'pwreset:<reset id>' + the jobs_org_dedup_uidx partial
--     unique index make the insert idempotent — one job per issued
--     token, and a raced duplicate returns the existing job's id;
--   * enqueued_by stays NULL — a system-enqueued job, like the
--     scheduler's; email jobs never resolve an execution principal.

create or replace function public.enqueue_password_reset_email(
  p_reset_id uuid,
  p_subject text,
  p_html text
) returns uuid
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

  insert into public.jobs (org_id, type, payload, dedup_key)
  values (
    v_org_id,
    'email',
    jsonb_build_object('to', v_email, 'subject', p_subject, 'html', p_html),
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
  end if;

  return v_job_id;
end;
$$;

comment on function public.enqueue_password_reset_email(uuid, text, text) is
  'SECURITY DEFINER: enqueue the password-reset email job for one live '
  'reset row (Phase 11, F-11-06). Org and recipient are derived from the '
  'reset row; only the email content is caller-supplied. Returns the job '
  'id, or null when the reset is used/expired or names no live person.';

revoke all on function public.enqueue_password_reset_email(uuid, text, text) from public;
grant execute on function public.enqueue_password_reset_email(uuid, text, text) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════
-- PART 6 — verification: fail the migration rather than leave a
-- half-hardened schema (the 0047/0060 pattern)
-- ═════════════════════════════════════════════════════════════════════════

do $$
declare
  v_problems text;
begin
  select string_agg(p, '; ') into v_problems
  from (values
    ('ai_effective_limits missing or not SECURITY DEFINER',
      exists (select 1 from pg_proc
              where oid = to_regprocedure('public.ai_effective_limits(uuid)')
                and prosecdef)),
    ('ai_effective_limits body lacks the org assertion',
      coalesce((select prosrc like '%authz.org_id()%'
                from pg_proc
                where oid = to_regprocedure('public.ai_effective_limits(uuid)')), false)),
    ('ai_usage_counters missing or not SECURITY DEFINER',
      exists (select 1 from pg_proc
              where oid = to_regprocedure('public.ai_usage_counters(uuid, uuid)')
                and prosecdef)),
    ('ai_usage_counters body lacks the org assertion',
      coalesce((select prosrc like '%authz.org_id()%'
                from pg_proc
                where oid = to_regprocedure('public.ai_usage_counters(uuid, uuid)')), false)),
    ('ai_usage_counters body lacks the person assertion',
      coalesce((select prosrc like '%authz.person_id()%'
                          and prosrc like '%ai.usage.view%'
                from pg_proc
                where oid = to_regprocedure('public.ai_usage_counters(uuid, uuid)')), false)),
    ('notification_channel_enabled missing or not SECURITY DEFINER',
      exists (select 1 from pg_proc
              where oid = to_regprocedure('public.notification_channel_enabled(uuid, uuid, text, text)')
                and prosecdef)),
    ('notification_channel_enabled body lacks the org assertion',
      coalesce((select prosrc like '%authz.org_id()%'
                from pg_proc
                where oid = to_regprocedure('public.notification_channel_enabled(uuid, uuid, text, text)')), false)),
    ('notifications_insert missing or not SECURITY DEFINER',
      exists (select 1 from pg_proc
              where oid = to_regprocedure('public.notifications_insert(uuid, uuid, text, text, jsonb, text, text)')
                and prosecdef)),
    ('notifications_insert body lacks the context-kind assertion',
      coalesce((select prosrc like '%authz.org_id()%'
                          and prosrc like '%app.org_id%'
                from pg_proc
                where oid = to_regprocedure('public.notifications_insert(uuid, uuid, text, text, jsonb, text, text)')), false)),
    ('notifications_recipient_exists missing or not SECURITY DEFINER',
      exists (select 1 from pg_proc
              where oid = to_regprocedure('public.notifications_recipient_exists(uuid, uuid)')
                and prosecdef)),
    ('notifications_recipient_exists body lacks the context-kind assertion',
      coalesce((select prosrc like '%authz.org_id()%'
                          and prosrc like '%app.org_id%'
                from pg_proc
                where oid = to_regprocedure('public.notifications_recipient_exists(uuid, uuid)')), false)),
    ('jobs identity freeze trigger missing',
      exists (select 1 from pg_trigger where tgname = 'jobs_identity_freeze'
              and tgrelid = 'public.jobs'::regclass)),
    ('schedules identity freeze trigger missing',
      exists (select 1 from pg_trigger where tgname = 'schedules_identity_freeze'
              and tgrelid = 'public.schedules'::regclass)),
    ('workflows identity freeze trigger missing',
      exists (select 1 from pg_trigger where tgname = 'workflows_identity_freeze'
              and tgrelid = 'public.workflows'::regclass)),
    ('ai_usage_requests identity freeze trigger missing',
      exists (select 1 from pg_trigger where tgname = 'ai_usage_requests_identity_freeze'
              and tgrelid = 'public.ai_usage_requests'::regclass)),
    ('a freeze function is not SECURITY DEFINER',
      (select count(*) = 4 from pg_proc
        where oid in (
          to_regprocedure('public.jobs_identity_freeze()'),
          to_regprocedure('public.schedules_identity_freeze()'),
          to_regprocedure('public.workflows_identity_freeze()'),
          to_regprocedure('public.ai_usage_requests_identity_freeze()'))
        and prosecdef)),
    ('enqueue_password_reset_email missing or not SECURITY DEFINER',
      exists (select 1 from pg_proc
              where oid = to_regprocedure('public.enqueue_password_reset_email(uuid, text, text)')
                and prosecdef)),
    ('app_user EXECUTE missing on enqueue_password_reset_email',
      has_function_privilege('app_user', 'public.enqueue_password_reset_email(uuid, text, text)', 'EXECUTE')),
    ('enqueue_password_reset_email must not be executable by PUBLIC',
      not has_function_privilege('public', 'public.enqueue_password_reset_email(uuid, text, text)', 'EXECUTE'))
  ) as checks(p, ok)
  where not ok;

  if v_problems is not null then
    raise exception 'security hardening migration verification failed: %', v_problems;
  end if;
end;
$$;
