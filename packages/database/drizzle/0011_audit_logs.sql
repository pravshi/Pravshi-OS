-- PRAVSHI OS — Phase 1 Task 1.10: the audit log.
--
-- Blueprint section 19 gives eight non-negotiable properties. Seven of them are enforced by
-- this file; the eighth (redaction) is the caller's job with a database backstop, and says
-- so below. What this task does NOT do is attach audit triggers to existing tables — that
-- is blueprint 19.3's first source, and it is a separate task with its own review.
--
-- ── WHAT MAKES THIS TABLE DIFFERENT FROM EVERY OTHER ONE ─────────────────────────
--
-- Every other table so far protects data. This one protects the record OF what happened to
-- that data, which means the threat model inverts: the dangerous operation is not reading a
-- row you should not see, it is REMOVING a row that says what you did. So:
--
--   * app_user, app_admin AND app_owner all lose UPDATE and DELETE (database.md:208 names
--     app_owner explicitly), and a trigger raises for anyone who still finds a way.
--   * app_user loses INSERT too. The only write path is write_audit_log(), which fills in
--     the actor and the organization itself.
--   * There is no soft delete, no updated_at, and no created_at. The row is immutable and
--     permanent by construction; occurred_at is the only timestamp it can have.
--
-- ── WHY THE ACTOR IS RESOLVED DIFFERENTLY HERE ───────────────────────────────────
--
-- Every other consumer of identity uses authz.person_id(), which returns NULL unless the
-- person is ACTIVE and not deleted. That is an AUTHORIZATION gate and it is right for
-- authorization. It is wrong for auditing: blueprint 19.5 makes denials the primary
-- intrusion signal, and the denials that matter most are attempts by people who are exactly
-- the ones authz.person_id() refuses to name — suspended, offboarded, deactivated.
--
-- write_audit_log() therefore resolves the actor against `people` WITHOUT the liveness gate
-- and derives the organization from that person's own row. The identity is still never
-- accepted from a parameter, and the organization is still never accepted from the caller.
-- The difference is only that a suspended person can be named as the actor of the thing
-- they were refused.

create type public.audit_result as enum ('SUCCESS', 'DENIED', 'ERROR');

comment on type public.audit_result is
  'Outcome of the audited attempt. DENIED is not an error condition: blueprint 19.5 makes a '
  'burst of denials the primary intrusion signal, so it must be as recordable as a success.';

-- ── the table ────────────────────────────────────────────────────────────────────
--
-- Columns are blueprint section 19, in order.
--
-- PARTITIONED BY RANGE (occurred_at), monthly, from the first migration. database.md:471:
-- "Retrofitting partitioning onto a large table is painful; doing it on an empty one is
-- free." The consequence is that the primary key must contain the partition key, so it is
-- (id, occurred_at) rather than (id) — Postgres cannot enforce uniqueness across partitions
-- without it. id alone is still unique in practice because it is a v4 uuid.
create table public.audit_logs (
  id uuid not null default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),

  -- clock_timestamp(), not now(): now() is fixed for the whole transaction, so several
  -- entries written by one request would be indistinguishable in order. Same reasoning as
  -- engagement_events in Task 1.6.
  occurred_at timestamptz not null default clock_timestamp(),

  -- Nullable FK AND a denormalised snapshot, because database.md's ERD note requires this
  -- row to outlive what it describes: "actor identity is stored as both a nullable FK and a
  -- denormalised email snapshot". No cascade — the FK is NO ACTION by default and must stay
  -- that way, or deleting a person would delete the evidence of what they did.
  actor_person_id uuid,
  actor_email_snapshot citext,

  actor_ip inet,
  user_agent text,

  -- Blueprint 19.4: "request_id correlates every entry from a single user action, so an
  -- incident is one query."
  request_id uuid,

  action text not null,
  entity_type text not null,
  entity_id uuid,

  -- A small fixed vocabulary, expressed as a CHECK rather than an enum by founder decision:
  -- the architecture never defined it as a native type, and a CHECK is the cheaper thing to
  -- widen if a fifth level is ever needed.
  severity text not null default 'LOW',
  result public.audit_result not null,

  before jsonb,
  after jsonb,
  metadata jsonb not null default '{}'::jsonb,

  constraint audit_logs_pkey primary key (id, occurred_at),

  constraint audit_logs_severity_valid
    check (severity in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  -- Same shape as record_grants.entity_type in Task 1.9: lower_snake_case, dotted where a
  -- module qualifies it, and only ever compared as a parameter.
  constraint audit_logs_action_format
    check (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  constraint audit_logs_entity_type_format
    check (entity_type ~ '^[a-z][a-z0-9_]{1,62}$'),
  constraint audit_logs_actor_same_org
    foreign key (actor_person_id, org_id) references public.people (id, org_id)
) partition by range (occurred_at);

comment on table public.audit_logs is
  'Append-only record of what happened. Monthly partitions, no DEFAULT partition, and no '
  'role — including app_owner — may UPDATE or DELETE a row. Written only by '
  'public.write_audit_log().';
comment on column public.audit_logs.actor_email_snapshot is
  'Denormalised at write time so the entry still names its actor after the person record is '
  'gone. Never used for authorization, only for reading the history.';
comment on column public.audit_logs.result is
  'SUCCESS, DENIED or ERROR. Denials are recorded deliberately (blueprint 19.5).';

-- ── indexes ──────────────────────────────────────────────────────────────────────
--
-- The first three are database.md section 8 verbatim. Created on the partitioned parent,
-- which Postgres propagates to every existing and future partition.
create index audit_logs_org_occurred_idx on public.audit_logs (org_id, occurred_at desc);
create index audit_logs_entity_idx
  on public.audit_logs (entity_type, entity_id, occurred_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_person_id, occurred_at desc);

-- The fourth is blueprint 19.4's stated query pattern — "an incident is one query" — which
-- is a table scan across every partition without it.
create index audit_logs_request_idx
  on public.audit_logs (request_id) where request_id is not null;

-- ── append-only, enforced for everyone ───────────────────────────────────────────
--
-- Revoking privileges stops app_user and app_admin. This stops app_owner too, which is the
-- property blueprint 19.1 actually asks for: "Not even SUPER_ADMIN can rewrite history
-- through the application." A history the most privileged role can quietly edit is not a
-- history. Same construction as engagement_events in Task 1.6.
--
-- Declared on the partitioned parent, so Postgres clones it onto every partition — including
-- ones created months from now by ensure_audit_log_partitions().
create function public.audit_logs_append_only() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_logs is append-only: % is not permitted', tg_op
    using errcode = '42501';
end;
$$;

comment on function public.audit_logs_append_only() is
  'Raises on any UPDATE or DELETE of an audit entry, for every role without exception.';

create trigger audit_logs_no_update
  before update on public.audit_logs
  for each row execute function public.audit_logs_append_only();

create trigger audit_logs_no_delete
  before delete on public.audit_logs
  for each row execute function public.audit_logs_append_only();

-- ── RLS on the parent ────────────────────────────────────────────────────────────

alter table public.audit_logs enable row level security;
alter table public.audit_logs force row level security;

-- FORCE applies to the owner, and write_audit_log() runs as the owner, so without this the
-- only write path would be blocked by the protection meant for everyone else.
create policy audit_logs_owner_all on public.audit_logs
  for all to app_owner using (true) with check (true);

-- ── THE FIRST POLICY IN THIS CODEBASE DRIVEN BY A PERMISSION ─────────────────────
--
-- Tasks 1.2 to 1.9 all left their policies relationship-scoped, because the database.md 4.2
-- template branches on scopes whose helpers do not exist yet: TEAM needs reports_to_me and
-- PROJECT needs is_project_member. audit_logs escapes that entirely — the security.md
-- section 2 matrix grants audit_logs.view at GLOBAL to SUPER_ADMIN and ADMIN and to nobody
-- else, at no other scope. With only one reachable branch there is no dead CASE arm to
-- write, so the comparison is made directly and anything that is not GLOBAL is denied.
--
-- NOTE WHAT THIS MEANS, because it is a deliberate break from every earlier table: there is
-- no SELF visibility. A person cannot read their own audit entries. security.md's matrix has
-- no S in the audit_logs.view row, and inventing one would hand every employee a search over
-- their own record — which is exactly how somebody checks whether their activity was noticed.
create policy audit_logs_select_global on public.audit_logs
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (select authz.scope_for('audit_logs.view')) = 'GLOBAL'
  );

-- No INSERT policy for app_user, and no UPDATE or DELETE policy for anyone. Writing goes
-- through write_audit_log(); the revokes at the bottom of this file remove the privileges
-- that the roles.sql default grant would otherwise hand out.

-- ── monthly partitions ───────────────────────────────────────────────────────────
--
-- NO DEFAULT PARTITION, by founder decision. A default partition means a write that falls
-- outside the window silently lands somewhere unintended and then blocks the creation of the
-- partition it should have gone to. Without one, the same write fails loudly. For an audit
-- table a loud failure is the correct outcome: a silently misfiled audit entry is worse than
-- a failed request, because nobody finds out.
--
-- Each partition is a table in its own right, so each needs its own treatment:
--
--   RLS enabled and forced   a partition read DIRECTLY does not inherit the parent's
--                            policies, only its own. Without this, app_user could select
--                            straight from audit_logs_2026_09 and see the whole tenant.
--                            tests/guards/rls-enabled.test.ts scans relkind='r' and would
--                            catch it, which is the guard doing its job.
--   an owner policy          so writes routed from the parent are not blocked by FORCE.
--   all privileges revoked   app_user and app_admin get select/insert/update on every new
--                            public table from the roles.sql default privilege. They need
--                            none of it here: reads go through the parent, where the policy
--                            above governs them, and writes go through the function.
--
-- Dynamic SQL is unavoidable — the partition name is computed from a date, and DDL cannot be
-- parameterised. Every identifier goes through format(%I) and every bound through %L, and
-- nothing in the statement comes from a caller-supplied string: p_months is an integer and
-- the rest is derived from date_trunc. This is the one function in the schema that executes
-- SQL it builds, and it is a maintenance routine that no application role can call.
create function public.ensure_audit_log_partitions(p_months integer default 12)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start date;
  v_end date;
  v_name text;
  v_created integer := 0;
  i integer;
begin
  if p_months < 0 or p_months > 120 then
    raise exception 'p_months must be between 0 and 120, got %', p_months
      using errcode = '22023';
  end if;

  for i in 0..p_months loop
    v_start := (date_trunc('month', now()) + make_interval(months => i))::date;
    v_end := (v_start + interval '1 month')::date;
    v_name := 'audit_logs_' || to_char(v_start, 'YYYY_MM');

    if to_regclass('public.' || quote_ident(v_name)) is null then
      execute format(
        'create table public.%I partition of public.audit_logs for values from (%L) to (%L)',
        v_name, v_start, v_end);
      execute format('alter table public.%I enable row level security', v_name);
      execute format('alter table public.%I force row level security', v_name);
      execute format(
        'create policy %I on public.%I for all to app_owner using (true) with check (true)',
        v_name || '_owner_all', v_name);
      execute format('revoke all on public.%I from app_user, app_admin', v_name);
      v_created := v_created + 1;
    end if;
  end loop;

  return v_created;
end;
$$;

comment on function public.ensure_audit_log_partitions(integer) is
  'Creates any missing monthly partitions from the current month forward, each with RLS '
  'enabled and forced, an owner policy, and no privileges for the runtime roles. Idempotent. '
  'Returns how many it created. There is deliberately no DEFAULT partition.';

-- Not an application API. It performs DDL, so it is granted to nobody at all; only its
-- owner can call it, and the only callers are this migration and whatever extends the
-- window later.
revoke all on function public.ensure_audit_log_partitions(integer) from public;

-- Current month plus twelve.
select public.ensure_audit_log_partitions(12);

-- ── the writer ───────────────────────────────────────────────────────────────────
--
-- Blueprint 19.2: "Written by a SECURITY DEFINER function, so the app can insert without
-- holding table rights." This is the one definer-rights function in the schema that WRITES,
-- and Task 1.7 refused to create such a thing for role management on the grounds that it
-- would hand app_user the capability the task existed to withhold. The difference is what it
-- can be made to do: role management writes authority, and a function that grants roles is a
-- function that grants roles to anybody who can call it. This one writes only history, and
-- the fields that decide WHOSE history — actor and organization — are not parameters at all.
-- The worst a caller can do is record a true event with a misleading action string.
--
-- VOLATILE, not STABLE: it writes.
--
-- WHAT IT REFUSES. If the transaction names no person, or names one that does not exist, it
-- raises rather than inventing an anonymous entry. audit_logs.org_id is NOT NULL and an
-- entry with no tenant has nowhere to live. Genuinely pre-authentication events — a failed
-- login by someone we cannot yet identify — belong to login_events, which is why blueprint
-- section 19 keeps it as a separate table. That table is not this task.
create function public.write_audit_log(
  p_action text,
  p_entity_type text,
  p_result public.audit_result default 'SUCCESS',
  p_entity_id uuid default null,
  p_severity text default 'LOW',
  p_before jsonb default null,
  p_after jsonb default null,
  p_metadata jsonb default '{}'::jsonb,
  p_request_id uuid default null,
  p_actor_ip inet default null,
  p_user_agent text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_org uuid;
  v_email public.citext;
  v_id uuid;
begin
  -- The actor is resolved from the transaction context, never from a parameter, and
  -- deliberately WITHOUT the liveness gate authz.person_id() applies. See the header: a
  -- denial by a suspended person is the entry most worth having.
  select p.id, p.org_id, p.work_email
    into v_actor, v_org, v_email
  from public.people p
  where p.id = nullif(current_setting('app.person_id', true), '')::uuid;

  if v_actor is null then
    raise exception
      'write_audit_log requires an identified actor; events before authentication belong to login_events'
      using errcode = '42501';
  end if;

  -- A backstop, not the redaction itself. Blueprint 19.6 puts redaction before storage,
  -- which is the caller's job and the only place nested and free-text values can be handled.
  -- This strips the obvious credential keys at the top level so a careless caller cannot
  -- persist them, and it can only ever remove data.
  insert into public.audit_logs (
    org_id, actor_person_id, actor_email_snapshot, actor_ip, user_agent, request_id,
    action, entity_type, entity_id, severity, result, before, after, metadata
  )
  values (
    v_org, v_actor, v_email, p_actor_ip, p_user_agent, p_request_id,
    p_action, p_entity_type, p_entity_id, p_severity, p_result,
    case when jsonb_typeof(p_before) = 'object'
         then p_before - '{password,password_hash,token,secret,credential}'::text[]
         else p_before end,
    case when jsonb_typeof(p_after) = 'object'
         then p_after - '{password,password_hash,token,secret,credential}'::text[]
         else p_after end,
    case when jsonb_typeof(p_metadata) = 'object'
         then p_metadata - '{password,password_hash,token,secret,credential}'::text[]
         else coalesce(p_metadata, '{}'::jsonb) end
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.write_audit_log(text, text, public.audit_result, uuid, text, jsonb, jsonb, jsonb, uuid, inet, text) is
  'The only path that writes an audit entry. Actor and organization are derived from the '
  'transaction identity and cannot be supplied; the actor is resolved without the engagement '
  'liveness gate so denials by suspended people are recorded.';

revoke all on function public.write_audit_log(text, text, public.audit_result, uuid, text, jsonb, jsonb, jsonb, uuid, inet, text) from public;
grant execute on function public.write_audit_log(text, text, public.audit_result, uuid, text, jsonb, jsonb, jsonb, uuid, inet, text) to app_user, app_admin;

-- ── privileges ───────────────────────────────────────────────────────────────────
--
-- database.md:208 spells this out, app_owner included:
--   revoke update, delete on audit_logs from app_user, app_admin, app_owner;
-- INSERT goes too for the runtime roles, because the writer is the only permitted path.
-- SELECT stays for app_user and is governed by the policy above.
revoke insert, update, delete on public.audit_logs from app_user, app_admin;
revoke update, delete on public.audit_logs from app_owner;
