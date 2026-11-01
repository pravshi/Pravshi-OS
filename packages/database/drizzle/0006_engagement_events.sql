-- PRAVSHI OS — Phase 1 Task 1.6: engagement lifecycle events and the transition machine.
--
-- Blueprint section 9: "Status is never edited freely; it moves through a transition
-- function that validates the source state, so history is always reconstructable."
--
-- ── WHY TRIGGERS RATHER THAN A TRANSITION FUNCTION ───────────────────────────────
--
-- A function only validates the callers who use it. Anything holding an UPDATE grant can
-- still write `set status = 'ACTIVE'` directly and leave no event behind, and the rule
-- silently becomes advisory.
--
-- Two triggers on `engagements` instead:
--
--   BEFORE UPDATE  validates the (from, to) pair against the matrix and resolves the actor
--   AFTER  UPDATE  writes the engagement_events row
--
-- Both fire on the same statement inside the same transaction, on EVERY path — the
-- application, psql, a migration, a bulk load. Atomicity is therefore structural rather
-- than remembered: there is no code path that changes status without writing an event,
-- because the database writes the event itself. If either trigger raises, the whole
-- statement rolls back and neither change survives.
--
-- ── THE TRANSITION MATRIX ────────────────────────────────────────────────────────
--
-- Taken from the blueprint section 9 diagram, and nothing beyond it:
--
--   PRE_ONBOARDING → ONBOARDING
--   ONBOARDING     → ACTIVE
--   ACTIVE         → NOTICE_PERIOD | SUSPENDED
--   NOTICE_PERIOD  → OFFBOARDING
--   SUSPENDED      → OFFBOARDING
--   OFFBOARDING    → ARCHIVED
--
-- ROLE_CHANGE, DEPT_TRANSFER, LEAVE and PERFORMANCE_REVIEW appear in that diagram but are
-- things that happen WHILE active, not statuses; they are not in engagement_status and so
-- are not in this matrix. Recruitment states are not here either — see migration 0005.
--
-- Three paths a reader may expect are deliberately ABSENT because the diagram does not
-- draw them, and inventing lifecycle rules is not this task's job:
--   SUSPENDED    → ACTIVE          (lifting a suspension)
--   ACTIVE       → OFFBOARDING     (immediate termination without notice)
--   PRE_ONBOARDING/ONBOARDING → ARCHIVED  (withdrawing before the start date)
-- Each is a plausible business need and a founder decision, not a technical one.

create table public.engagement_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  engagement_id uuid not null,

  from_status public.engagement_status not null,
  to_status public.engagement_status not null,

  effective_date date not null default current_date,
  reason text,

  actor_person_id uuid not null,

  -- clock_timestamp(), not now(): now() is fixed for the whole transaction, so two
  -- transitions committed together would be indistinguishable in order. clock_timestamp()
  -- advances, which keeps the history strictly orderable.
  occurred_at timestamptz not null default clock_timestamp(),

  constraint engagement_events_status_changed check (from_status <> to_status),

  constraint engagement_events_engagement_same_org
    foreign key (engagement_id, org_id) references public.engagements (id, org_id),
  constraint engagement_events_actor_same_org
    foreign key (actor_person_id, org_id) references public.people (id, org_id)
);

-- No updated_at and no deleted_at. The row is immutable and permanent by construction;
-- a column implying it could be modified or retired would misdescribe the table.

create index engagement_events_engagement_idx
  on public.engagement_events (engagement_id, occurred_at);
create index engagement_events_actor_idx on public.engagement_events (actor_person_id);
create index engagement_events_org_idx on public.engagement_events (org_id);

comment on table public.engagement_events is
  'Append-only lifecycle history for engagements. Written only by the transition trigger; '
  'no role may UPDATE or DELETE a row, including app_owner.';

-- ── append-only, enforced for everyone ───────────────────────────────────────────
-- Revoking privileges stops app_user. This trigger stops everyone else as well, which is
-- the property the table needs: history that the most privileged role can quietly rewrite
-- is not history.
create function public.engagement_events_append_only() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'engagement_events is append-only: % is not permitted', tg_op
    using errcode = '42501';
end;
$$;

create trigger engagement_events_no_update
  before update on public.engagement_events
  for each row execute function public.engagement_events_append_only();

create trigger engagement_events_no_delete
  before delete on public.engagement_events
  for each row execute function public.engagement_events_append_only();

-- ── the transition machine ───────────────────────────────────────────────────────

create function public.engagements_validate_transition() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  if new.status is not distinct from old.status then
    return new;                      -- not a lifecycle transition; nothing to police
  end if;

  -- The actor comes from the transaction-local identity context, never from a column the
  -- caller supplies. There is no way to attribute a transition to somebody else.
  v_actor := authz.person_id();
  if v_actor is null then
    raise exception
      'engagement transition requires an authenticated actor; none in the transaction context'
      using errcode = '42501';
  end if;

  -- The actor must belong to the engagement's organization. authz.org_id() is derived
  -- from the actor and returns NULL on a mismatched tenant claim, so this rejects both a
  -- foreign actor and a spoofed organization. The composite FK on engagement_events would
  -- also catch it, but only after the fact and with a constraint error that says nothing
  -- about why; failing here names the actual problem.
  if authz.org_id() is distinct from new.org_id then
    raise exception 'engagement transition actor is not in the engagement organization'
      using errcode = '42501';
  end if;

  if not (
       (old.status = 'PRE_ONBOARDING' and new.status = 'ONBOARDING')
    or (old.status = 'ONBOARDING'     and new.status = 'ACTIVE')
    or (old.status = 'ACTIVE'         and new.status in ('NOTICE_PERIOD', 'SUSPENDED'))
    or (old.status = 'NOTICE_PERIOD'  and new.status = 'OFFBOARDING')
    or (old.status = 'SUSPENDED'      and new.status = 'OFFBOARDING')
    or (old.status = 'OFFBOARDING'    and new.status = 'ARCHIVED')
  ) then
    raise exception 'invalid engagement transition: % -> %', old.status, new.status
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create function public.engagements_record_transition() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then
    return null;
  end if;

  -- authz.person_id() was already proven non-null by the BEFORE trigger, and both run in
  -- the same statement, so this cannot record an anonymous actor.
  insert into public.engagement_events
    (org_id, engagement_id, from_status, to_status, actor_person_id)
  values
    (new.org_id, new.id, old.status, new.status, authz.person_id());

  return null;
end;
$$;

comment on function public.engagements_validate_transition() is
  'Rejects any status change that is not in the blueprint transition matrix, and any '
  'transition without an authenticated actor.';
comment on function public.engagements_record_transition() is
  'Writes the engagement_events row for a status change, in the same statement.';

create trigger engagements_validate_transition
  before update on public.engagements
  for each row execute function public.engagements_validate_transition();

create trigger engagements_record_transition
  after update on public.engagements
  for each row execute function public.engagements_record_transition();

-- ── RLS ──────────────────────────────────────────────────────────────────────────

alter table public.engagement_events enable row level security;
alter table public.engagement_events force row level security;

-- The AFTER trigger inserts as whoever performed the UPDATE; app_owner needs a policy
-- because FORCE applies to the owner too. There is no app_user write policy at all.
create policy engagement_events_owner_all on public.engagement_events
  for all to app_owner using (true) with check (true);

-- SELF: a person may read the history of their own engagements, including after they
-- have ended — being able to see the record that says you were offboarded is the point.
-- Manager and HR visibility is scope_for('engagements.view') in Task 1.7.
create policy engagement_events_select_self on public.engagement_events
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and exists (
      select 1 from public.engagements e
      where e.id = public.engagement_events.engagement_id
        and e.person_id = (select authz.person_id())
        and e.deleted_at is null
    )
  );

-- roles.sql grants select/insert/update on new public tables by default privilege. Only
-- SELECT is wanted; a write grant here would be a grant to fabricate history.
revoke insert, update, delete on public.engagement_events from app_user, app_admin;
