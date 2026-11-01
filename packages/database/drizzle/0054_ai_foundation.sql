-- PRAVSHI OS — Phase 9: AI Foundation — usage metering + org limits schema.
--
-- PART 1 — public.ai_usage_requests: the append-mostly metering log, one row
--   per orchestrated AI request (contract §4.1, decision D6). Two-phase
--   lifecycle: the orchestrator INSERTs status='STARTED' before invoking the
--   provider and UPDATEs the same row to its final status; provider retries
--   within a request never create rows (provider_attempts records them).
--   NO prompt text, NO response text, NO record content columns — by design
--   (D7): metadata only (ids, capability, provider, model, token counts when
--   the provider reports them — never estimated for real providers, status,
--   duration, normalized error code).
-- PART 2 — public.ai_org_limits: per-org AI configuration (contract §4.2):
--   the enabled kill switch + nullable limit overrides. Absence of a row
--   means the code defaults (§8.2) apply.
-- PART 3 — SECURITY DEFINER aggregate functions (contract §8.1):
--   ai_effective_limits() and ai_usage_counters(). The orchestrator's limit
--   check must work for users who hold ai.use but NOT ai.usage.view, and the
--   §4.1 SELECT policy is gated on ai.usage.view — so limit/config reads go
--   through these definer functions instead (the
--   notifications_recipient_exists precedent from 0052). Both return
--   aggregates only: no usage rows, no record fields ever leave them.
-- PART 4 — verification DO blocks (the 0047 pattern): fail closed.

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 1 — public.ai_usage_requests
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.ai_usage_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  person_id uuid not null references public.people (id),
  -- The app request id; joins audit_logs metadata. Unique per org (index below).
  request_id uuid not null,

  capability text not null
    constraint ai_usage_requests_capability_check check (capability in (
      'lead_summary', 'deal_summary', 'contact_summary', 'company_summary',
      'activity_summary', 'project_summary', 'task_summary', 'general_assistance'
    )),
  provider text not null,
  -- Null when the provider was never invoked (limited / not configured).
  model text,

  status text not null
    constraint ai_usage_requests_status_check check (status in (
      'STARTED', 'SUCCEEDED', 'FAILED', 'LIMITED', 'NOT_CONFIGURED'
    )),

  -- Provider-reported only; NULL = not reported, never estimated.
  prompt_tokens int,
  completion_tokens int,
  total_tokens int,

  provider_attempts int not null default 0,
  tool_calls_count int not null default 0,
  -- Set at finalize; NULL while STARTED.
  duration_ms int,
  -- Normalized taxonomy code (contract §3.2); never a raw provider error.
  error_code text,

  -- Attribution only: the record the capability ran against.
  target_entity_type text
    constraint ai_usage_requests_target_entity_type_check check (
      target_entity_type is null
      or target_entity_type in ('company', 'contact', 'deal', 'activity', 'project', 'task')
    ),
  target_entity_id uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ai_usage_requests_org_request_unique unique (org_id, request_id)
);

--> statement-breakpoint

-- Usage reporting + monthly quota window.
create index ai_usage_requests_org_created_idx
  on public.ai_usage_requests (org_id, created_at desc);

--> statement-breakpoint

-- Per-user rate window.
create index ai_usage_requests_org_person_created_idx
  on public.ai_usage_requests (org_id, person_id, created_at desc);

--> statement-breakpoint

create trigger ai_usage_requests_set_updated_at
  before update on public.ai_usage_requests
  for each row execute function public.set_updated_at();

--> statement-breakpoint

comment on table public.ai_usage_requests is
  'Phase 9 AI metering log: one row per orchestrated request, two-phase '
  '(STARTED then finalized in place). Metadata only — no prompt text, no '
  'response text, no record content is ever stored (decision D7).';

--> statement-breakpoint

-- ── RLS: ENABLED + FORCED (the 0047/0052 template) ────────────────────────────

alter table public.ai_usage_requests enable row level security;
alter table public.ai_usage_requests force row level security;

create policy ai_usage_requests_owner_all on public.ai_usage_requests
  for all to app_owner using (true) with check (true);

--> statement-breakpoint

-- Reads are an admin surface: org-wide usage belongs to ai.usage.view
-- holders. The own-rows carve-out is not a courtesy — Postgres applies the
-- SELECT policy to rows read by UPDATE and to INSERT/UPDATE ... RETURNING
-- output, so with a usage.view-only SELECT policy the requester could never
-- finalize (or even see) the STARTED row §4.1's two-phase lifecycle has them
-- write: every finalize would silently match 0 rows. Own-rows visibility is
-- the repo's standard pattern (notifications, notification_preferences) and
-- exposes nothing the requester did not themselves create. The
-- orchestrator's limit check does NOT use this policy — it goes through the
-- Part 3 definer functions, so aggregates stay gated on ai.usage.view.
create policy ai_usage_requests_select on public.ai_usage_requests
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (
      (select authz.has('ai.usage.view'))
      or person_id = (select authz.person_id())
    )
  );

--> statement-breakpoint

create policy ai_usage_requests_insert on public.ai_usage_requests
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and person_id = (select authz.person_id())
    and (select authz.has('ai.use'))
  );

--> statement-breakpoint

-- A requester finalizes only its own rows: same predicate as INSERT.
create policy ai_usage_requests_update on public.ai_usage_requests
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and person_id = (select authz.person_id())
    and (select authz.has('ai.use'))
  )
  with check (
    org_id = (select authz.org_id())
    and person_id = (select authz.person_id())
    and (select authz.has('ai.use'))
  );

--> statement-breakpoint

-- No DELETE policy: the metering log is append-mostly; retention purges run
-- through a cleanup job as the owner, same as notifications/jobs.

-- ── tenant guards: the 0047 notifications_org_guard / person_org_guard pattern ─

create or replace function public.ai_usage_requests_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null then
    raise exception 'ai_usage_requests.org_id must not be null'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.organizations o where o.id = new.org_id) then
    raise exception 'ai_usage_requests.org_id does not reference a valid organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.ai_usage_requests_org_guard() is
  'BEFORE INSERT/UPDATE on ai_usage_requests: org_id must reference a valid '
  'organization. Defense-in-depth behind the FK; raises 42501.';

revoke all on function public.ai_usage_requests_org_guard() from public;

drop trigger if exists ai_usage_requests_org_guard on public.ai_usage_requests;
create trigger ai_usage_requests_org_guard
  before insert or update on public.ai_usage_requests
  for each row execute function public.ai_usage_requests_org_guard();

--> statement-breakpoint

create or replace function public.ai_usage_requests_person_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_org uuid;
begin
  select p.org_id into v_person_org
  from public.people p
  where p.id = new.person_id;
  if v_person_org is distinct from new.org_id then
    raise exception 'ai_usage_requests.person_id must belong to the request''s organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.ai_usage_requests_person_org_guard() is
  'BEFORE INSERT/UPDATE on ai_usage_requests: person_id must belong to the '
  'row''s org_id. Closes the cross-org metering hole; raises 42501.';

revoke all on function public.ai_usage_requests_person_org_guard() from public;

drop trigger if exists ai_usage_requests_person_org_guard on public.ai_usage_requests;
create trigger ai_usage_requests_person_org_guard
  before insert or update on public.ai_usage_requests
  for each row execute function public.ai_usage_requests_person_org_guard();

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 2 — public.ai_org_limits
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.ai_org_limits (
  org_id uuid primary key references public.organizations (id),
  -- Org kill switch: false → every AI request is LIMITED (reason 'disabled').
  enabled boolean not null default true,
  -- NULL = the code default applies (contract §8.2).
  monthly_request_limit int,
  monthly_token_limit int,
  max_requests_per_minute_per_user int,
  max_concurrent_requests int,
  updated_by uuid references public.people (id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

--> statement-breakpoint

create trigger ai_org_limits_set_updated_at
  before update on public.ai_org_limits
  for each row execute function public.set_updated_at();

--> statement-breakpoint

comment on table public.ai_org_limits is
  'Per-org AI configuration: kill switch + limit overrides. One row per org; '
  'absence of a row means the code defaults (contract §8.2) apply.';

--> statement-breakpoint

alter table public.ai_org_limits enable row level security;
alter table public.ai_org_limits force row level security;

create policy ai_org_limits_owner_all on public.ai_org_limits
  for all to app_owner using (true) with check (true);

--> statement-breakpoint

create policy ai_org_limits_select on public.ai_org_limits
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.has('ai.usage.view'))
  );

--> statement-breakpoint

create policy ai_org_limits_insert on public.ai_org_limits
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.has('ai.usage.manage'))
  );

--> statement-breakpoint

create policy ai_org_limits_update on public.ai_org_limits
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.has('ai.usage.manage'))
  )
  with check (
    org_id = (select authz.org_id())
    and (select authz.has('ai.usage.manage'))
  );

--> statement-breakpoint

-- No DELETE policy: limits are reset by nulling the override columns (or by
-- the owner), never by deleting the row from the runtime role.

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 3 — SECURITY DEFINER aggregate functions (contract §8.1)
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Both functions derive org/person ONLY from parameters the server passes
-- from the authorized session context — never from the client — and return
-- aggregates only: no usage rows, no record fields. SECURITY DEFINER because
-- the ai_usage_requests SELECT policy gates on ai.usage.view, which a plain
-- ai.use holder (the normal summarizer) does not hold; without these, the
-- orchestrator could not limit-check the very users it serves.

-- The org's effective limits: the ai_org_limits row merged over the §8.2
-- code defaults (monthly requests 5000, monthly tokens 2000000, per-minute
-- 10, concurrent 4, enabled true). Always returns exactly one row, even for
-- an org with no limits row.
create or replace function public.ai_effective_limits(p_org_id uuid)
returns table (
  enabled boolean,
  monthly_request_limit int,
  monthly_token_limit int,
  max_requests_per_minute_per_user int,
  max_concurrent_requests int
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(l.enabled, true),
    coalesce(l.monthly_request_limit, 5000),
    coalesce(l.monthly_token_limit, 2000000),
    coalesce(l.max_requests_per_minute_per_user, 10),
    coalesce(l.max_concurrent_requests, 4)
  from (select 1) as one
  left join public.ai_org_limits l on l.org_id = p_org_id
$$;

comment on function public.ai_effective_limits(uuid) is
  'Effective AI limits for one org: the ai_org_limits row merged over the '
  'contract §8.2 code defaults. SECURITY DEFINER: the limit check must run '
  'for ai.use holders who do not hold ai.usage.view. Returns one merged row.';

revoke all on function public.ai_effective_limits(uuid) from public;
grant execute on function public.ai_effective_limits(uuid) to app_user;

--> statement-breakpoint

-- The org's usage counters, per the §8.2 counting rules:
--   month_requests        current calendar month (UTC), status SUCCEEDED or FAILED
--   month_tokens          sum(total_tokens) over SUCCEEDED rows this month; NULL counts 0
--   last_minute_requests  the named person's rows in the trailing 60s, status <> LIMITED
--   in_flight             org rows STARTED within the last 5 minutes (stale
--                         STARTED rows from crashed requests age out)
-- LIMITED and NOT_CONFIGURED outcomes never consume request/token quota.
create or replace function public.ai_usage_counters(p_org_id uuid, p_person_id uuid)
returns table (
  month_requests bigint,
  month_tokens bigint,
  last_minute_requests bigint,
  in_flight bigint
)
language sql
stable
security definer
set search_path = ''
as $$
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
        and r.created_at >= now() - interval '5 minutes')
$$;

comment on function public.ai_usage_counters(uuid, uuid) is
  'Usage counters for one org (and one person for the per-minute window), per '
  'the contract §8.2 counting rules. SECURITY DEFINER: callable by ai.use '
  'holders without ai.usage.view. Returns four aggregate numbers only.';

revoke all on function public.ai_usage_counters(uuid, uuid) from public;
grant execute on function public.ai_usage_counters(uuid, uuid) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 4 — verification: fail the migration rather than leave a half-built schema
-- ═════════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_problems text;
begin
  select string_agg(p, '; ') into v_problems
  from (values
    ('ai_usage_requests table missing',
      exists (select 1 from pg_tables
              where schemaname = 'public' and tablename = 'ai_usage_requests')),
    ('ai_usage_requests RLS not forced',
      coalesce((select relrowsecurity and relforcerowsecurity from pg_class
                where relname = 'ai_usage_requests'), false)),
    ('ai_usage_requests column set drifted from the contract',
      coalesce((select string_agg(column_name, ',' order by column_name)
                from information_schema.columns
                where table_schema = 'public' and table_name = 'ai_usage_requests'), '')
        = 'capability,completion_tokens,created_at,duration_ms,error_code,id,model,org_id,person_id,prompt_tokens,provider,provider_attempts,request_id,status,target_entity_id,target_entity_type,tool_calls_count,total_tokens,updated_at'),
    ('ai_usage_requests content column present (D7 violation)',
      not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'ai_usage_requests'
                    and column_name in ('prompt', 'response', 'content', 'messages', 'output', 'summary'))),
    ('ai_usage_requests_org_request_unique missing',
      exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'ai_usage_requests_org_request_unique')),
    ('ai_usage_requests_org_created_idx missing',
      exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'ai_usage_requests_org_created_idx')),
    ('ai_usage_requests_org_person_created_idx missing',
      exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'ai_usage_requests_org_person_created_idx')),
    ('ai_usage_requests capability check missing',
      exists (select 1 from pg_constraint where conname = 'ai_usage_requests_capability_check')),
    ('ai_usage_requests status check missing',
      exists (select 1 from pg_constraint where conname = 'ai_usage_requests_status_check')),
    ('ai_usage_requests_select policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'ai_usage_requests'
                and policyname = 'ai_usage_requests_select')),
    ('ai_usage_requests_insert policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'ai_usage_requests'
                and policyname = 'ai_usage_requests_insert')),
    ('ai_usage_requests_update policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'ai_usage_requests'
                and policyname = 'ai_usage_requests_update')),
    ('ai_usage_requests guard triggers missing',
      exists (select 1 from pg_trigger where tgname = 'ai_usage_requests_org_guard')
      and exists (select 1 from pg_trigger where tgname = 'ai_usage_requests_person_org_guard')),
    ('ai_org_limits table missing',
      exists (select 1 from pg_tables
              where schemaname = 'public' and tablename = 'ai_org_limits')),
    ('ai_org_limits RLS not forced',
      coalesce((select relrowsecurity and relforcerowsecurity from pg_class
                where relname = 'ai_org_limits'), false)),
    ('ai_org_limits_select policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'ai_org_limits'
                and policyname = 'ai_org_limits_select')),
    ('ai_org_limits_insert policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'ai_org_limits'
                and policyname = 'ai_org_limits_insert')),
    ('ai_org_limits_update policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'ai_org_limits'
                and policyname = 'ai_org_limits_update')),
    ('ai_effective_limits missing',
      exists (select 1 from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'ai_effective_limits'
                and p.pronargs = 1)),
    ('ai_effective_limits not security-definer',
      coalesce((select p.prosecdef from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'ai_effective_limits'
                  and p.pronargs = 1), false)),
    ('ai_effective_limits not executable by app_user',
      exists (select 1 from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'ai_effective_limits'
                and has_function_privilege('app_user', p.oid, 'EXECUTE'))),
    ('ai_usage_counters missing',
      exists (select 1 from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'ai_usage_counters'
                and p.pronargs = 2)),
    ('ai_usage_counters not security-definer',
      coalesce((select p.prosecdef from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'ai_usage_counters'
                  and p.pronargs = 2), false)),
    ('ai_usage_counters not executable by app_user',
      exists (select 1 from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'ai_usage_counters'
                and has_function_privilege('app_user', p.oid, 'EXECUTE')))
  ) as checks(p, ok)
  where not ok;

  if v_problems is not null then
    raise exception 'ai foundation migration verification failed: %', v_problems;
  end if;
end;
$$;
