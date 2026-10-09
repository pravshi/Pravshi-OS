-- ═════════════════════════════════════════════════════════════════════════════
-- 0064_task_reminder_delivery — task-reminder delivery sweep (P1b, AUD-04)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Phase 4 shipped task_reminders storage with is_sent permanently false:
-- "V1 never sets it; the Phase 6 automation sweep will." This migration is
-- that sweep's database half. No tables, no columns, no new permissions
-- (the catalogue stays at 127); function definitions only, so it applies
-- identically on fresh and upgraded chains.
--
-- PART 1 — public.claim_due_task_reminders(int): the cross-org claim.
--   The reminder sweep runs on the worker plane (no per-request identity,
--   across ALL orgs), and task_reminders is under FORCED RLS, so a plain
--   SELECT/UPDATE from the worker matches zero rows forever — the
--   jobs_claim_next() / scheduler_tick_claim() problem, solved the same
--   way: a SECURITY DEFINER function is the only cross-org path. The claim
--   is atomic: due rows (remind_at <= now(), is_sent = false) are picked
--   oldest-first FOR UPDATE SKIP LOCKED and flipped to is_sent = true in
--   the same statement, so two concurrent sweeps can never claim — and
--   therefore never deliver — the same reminder twice. The function takes
--   no org/person parameter, so there is nothing a caller can forge; its
--   only input is a bounded batch limit, re-validated server-side (the
--   0049 guard idiom). EXECUTE is granted to app_user only.
--
--   A reminder whose task has been soft-deleted is still claimed (and
--   flipped): it can never become deliverable again, and leaving it due
--   would re-scan it on every tick forever. The sweep reads task_live and
--   skips delivery for those rows — the claim is the retirement.
--
-- PART 2 — public.notification_channel_enabled(uuid, uuid, text, text):
--   the context-kind assertion (the 0061 PART 3A resolution, extended to
--   the family's third member). In Phase 11 this function kept the plain
--   person-context assertion because its only caller (the notification
--   service's preference gate) always runs under a real person's context.
--   The reminder sweep is a second, worker-plane caller: it must ask the
--   same one-bit question ("may this recipient be notified in-app?")
--   under the person-less system-actor context, where the plain assertion
--   can never hold. The body therefore asserts by CONTEXT KIND, exactly
--   like its 0061 siblings notifications_insert /
--   notifications_recipient_exists:
--     * person context present (authz.person_id() is not null):
--       p_org_id must equal authz.org_id() — the 0044 idiom, unchanged;
--     * person-less context (the worker plane): p_org_id must equal the
--       app.org_id claim the transaction carries. The sweep binds that
--       claim from the CLAIMED REMINDER ROW's org (never from payload or
--       caller input), so a mismatched or absent claim refuses 42501.
--   Resolution semantics (specific row, then '*' wildcard, then default
--   enabled) are 0052's, unchanged; the request-plane caller observes no
--   behaviour change.
--
-- PART 3 — verification: fail the migration rather than leave a
--   half-built privilege path (the 0046/0052/0061 pattern).
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — claim_due_task_reminders: atomic cross-org due-reminder claim
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.claim_due_task_reminders(
  p_limit int
) returns table (
  reminder_id uuid,
  org_id uuid,
  task_id uuid,
  person_id uuid,
  remind_at timestamptz,
  task_title text,
  task_live boolean
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
--> statement-breakpoint
comment on function public.claim_due_task_reminders(int) is
  'SECURITY DEFINER: worker-plane claim for due task reminders across all '
  'orgs. Atomically flips is_sent = true on up to p_limit due reminders '
  '(remind_at <= now(), oldest first, FOR UPDATE SKIP LOCKED) and returns '
  'them with their task title and liveness, so concurrent sweeps can never '
  'deliver the same reminder twice. The only cross-org task_reminders read '
  'path: RLS is FORCED on the table, so the identity-less worker plane '
  'cannot see reminders through plain SQL. Takes no org_id (the sweep is '
  'global); the org on each returned row comes from the reminder itself.';
--> statement-breakpoint
revoke all on function public.claim_due_task_reminders(int) from public;
--> statement-breakpoint
grant execute on function public.claim_due_task_reminders(int) to app_user;
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — notification_channel_enabled: context-kind org assertion
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Signature, defaults, return shape and resolution semantics are 0052/0061's;
-- the only change is the assertion, harmonised with the rest of the
-- notification definer family (0061 PART 3A): person contexts assert
-- against authz.org_id(); the person-less worker plane asserts against its
-- bound org claim. See the header for why the sweep needs the second arm.

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
  if (select authz.person_id()) is not null then
    if p_org_id is distinct from (select authz.org_id()) then
      raise exception 'org_id mismatch' using errcode = '42501';
    end if;
  elsif p_org_id is distinct from nullif(current_setting('app.org_id', true), '')::uuid then
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
--> statement-breakpoint
comment on function public.notification_channel_enabled(uuid, uuid, text, text) is
  'Effective enabled flag for one (org, person, event_type, channel) preference: '
  'specific row, then ''*'' wildcard row, then default true. SECURITY DEFINER '
  'because preference rows are own-rows under RLS while the delivery gate runs '
  'under the notification creator''s identity. Returns one boolean only. '
  'Phase 11 (F-11-02): org assertion. P1b (AUD-04): the assertion is by context '
  'kind, like the rest of the notification definer family — p_org_id = '
  'authz.org_id() under a person context; on the person-less worker plane '
  '(the task-reminder sweep), p_org_id = the app.org_id claim bound from the '
  'claimed reminder row; 42501 otherwise.';
--> statement-breakpoint
revoke all on function public.notification_channel_enabled(uuid, uuid, text, text) from public;
--> statement-breakpoint
grant execute on function public.notification_channel_enabled(uuid, uuid, text, text) to app_user;
--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — verification: fail the migration rather than leave a half-built
-- privilege path (the 0046/0052/0061 pattern).
-- ═════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_problems text;
begin
  select string_agg(p, '; ') into v_problems
  from (values
    ('claim_due_task_reminders missing',
      exists (select 1 from pg_proc where proname = 'claim_due_task_reminders'
              and pronamespace = 'public'::regnamespace)),
    ('claim_due_task_reminders not security definer',
      exists (select 1 from pg_proc
              where proname = 'claim_due_task_reminders'
                and pronamespace = 'public'::regnamespace
                and prosecdef)),
    ('claim_due_task_reminders executable by PUBLIC',
      not exists (select 1 from information_schema.role_routine_grants
                  where routine_schema = 'public'
                    and routine_name = 'claim_due_task_reminders'
                    and grantee = 'PUBLIC')),
    ('notification_channel_enabled missing',
      exists (select 1 from pg_proc where proname = 'notification_channel_enabled'
              and pronamespace = 'public'::regnamespace)),
    ('notification_channel_enabled not security definer',
      exists (select 1 from pg_proc
              where proname = 'notification_channel_enabled'
                and pronamespace = 'public'::regnamespace
                and prosecdef))
  ) as checks(p, ok)
  where not ok;

  if v_problems is not null then
    raise exception 'task reminder delivery privilege path broken: %', v_problems;
  end if;
end;
$$;
