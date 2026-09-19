-- PRAVSHI OS — Phase 1 Task 1.16: scope-aware RLS, and the two helpers it needs.
--
-- Task 1.15 built the application-layer chain and deliberately left the database half of
-- database.md 4.2 unfinished: every Phase 1 table still answered SELF only, so a DEPARTMENT or
-- GLOBAL holder reached nothing and requirePermission() concealed the row as 404. That was the
-- fail-closed direction, and it is now closed properly rather than widened by hand.
--
-- ── WHAT THIS MIGRATION DOES, AND WHAT IT REFUSES TO DO ──────────────────────────
--
--   authz.reports_to_me()      the TEAM branch of the 4.2 template, which had no helper
--   authz.in_my_departments()  the DEPARTMENT branch, for a table with no department column
--   people                     the full template, keyed on people.view
--   engagements                the full template, keyed on engagements.view
--   engagement_events          the same, through the engagement it belongs to
--   people columns             date_of_birth, personal_email and phone leave app_user's reach
--
-- It invents no permission key and changes no grant in the security.md section 2 matrix. That
-- matters more than it sounds: the matrix gives engagements.view to SUPER_ADMIN alone, so the
-- engagements policy below reaches nobody else today. Writing it anyway is the point — when the
-- founder decides HR should read what it may already transition, that becomes one row in
-- role_permissions rather than a migration. Widening the seed to make a test pass would be
-- inventing authorization, which is the one thing this layer must never do.
--
-- internships stays SELF: migration 0007 promised scope_for('internships.view') and the catalogue
-- has no internships.* key at all. A key nobody approved is not a key.
--
-- ── WHY SELF IS NOT GATED ON is_active() ─────────────────────────────────────────
--
-- The template opens with `and (select authz.is_active())`. Applied literally to these tables it
-- would take away a person's own record the moment their engagement ended — and the record that
-- says you were offboarded is exactly the one you must still be able to read (Tasks 1.2, 1.5 and
-- 1.6 each said so in their policies). So the SELF branch stays unconditional and the WIDENING
-- branches carry is_active(): seeing yourself is identity, seeing anybody else is access.
--
-- ── PROJECT ──────────────────────────────────────────────────────────────────────
--
-- Still false everywhere. authz.is_project_member() needs project_members, which is Phase 4. A
-- person who resolves PROJECT for one of these permissions therefore reaches nothing, which is
-- narrower than SELF would have been and never wider. tests/authz/scopes-and-grants.test.ts
-- records that collapse; it is a Phase 4 decision, not something to paper over here.

-- ═════════════════════════════════════════════════════════════════════════════════
-- authz.reports_to_me() — the manager chain
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- database.md 4.1 specifies `authz.reports_to_me(person uuid)  -- recursive manager chain`, and
-- the blueprint scope table reads "TEAM | the record's owner is me, or reports to me (recursive
-- manager chain)". The "or me" half lives in the policy, beside every other SELF test; this
-- function answers only the chain, so no caller can get self-visibility out of it by accident.
--
-- WHAT MAKES IT TRUE. The target has a live engagement whose manager_person_id chain reaches the
-- caller, every hop inside the caller's own organization, and the caller's own engagement is
-- live. Anything else is false — no identity, a suspended manager, a dead link in the chain, a
-- mismatched tenant claim, or a NULL argument.
--
-- WHY THE CALLER IS EXCLUDED EXPLICITLY. Walking downwards does not on its own keep the caller
-- out of their own result: if the caller sits inside a management cycle, the walk leaves them and
-- comes back, and "you report to yourself" would be true. The final predicate therefore says so
-- outright, which makes the contract hold for every shape of data rather than for the shapes
-- without a cycle in them.
--
-- WHY IT CANNOT LEAK ACROSS TENANTS. Every hop carries e.org_id = authz.org_id(), and
-- authz.org_id() returns NULL when app.org_id disagrees with the person's row, so a spoofed tenant
-- produces an empty chain rather than another organization's reporting line.
--
-- WHY THE CYCLE GUARD IS NOT OPTIONAL. The schema forbids managing yourself and nothing more: A
-- managing B while B manages A is representable today. Without the visited-set test that is an
-- infinite recursion inside an RLS predicate — a denial of service reachable by data entry. The
-- depth cap is the second belt: ten levels is far past any real reporting line here, and a chain
-- longer than that fails closed rather than running forever.
--
-- WHY SECURITY DEFINER IS SAFE. It reads engagements as the owner, which is required: the
-- caller's own RLS view of engagements is precisely what this function helps compute, so an
-- invoker-rights version would answer from a half-built policy. It cannot recurse into that policy
-- either — FORCE applies the owner's own policy, engagements_owner_all, which is `using (true)`
-- and calls no helper. Same argument as authz.person_id() reading people since Task 1.3, and
-- tests/db/scope-rls.test.ts asserts it rather than assuming it.
create function authz.reports_to_me(p_person uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with recursive chain as (
    select e.person_id, array[e.person_id] as seen, 1 as depth
    from public.engagements e
    where e.manager_person_id = authz.person_id()
      and e.org_id = authz.org_id()
      and e.status = 'ACTIVE'
      and e.deleted_at is null
    union all
    select e.person_id, c.seen || e.person_id, c.depth + 1
    from public.engagements e
    join chain c on e.manager_person_id = c.person_id
    where e.org_id = authz.org_id()
      and e.status = 'ACTIVE'
      and e.deleted_at is null
      and not (e.person_id = any (c.seen))
      and c.depth < 10
  )
  select p_person is not null
     and p_person is distinct from authz.person_id()
     and authz.is_active()
     and exists (select 1 from chain where chain.person_id = p_person)
$$;

comment on function authz.reports_to_me(uuid) is
  'Whether the given person reports to the authenticated person through the live manager chain, '
  'within one organization and with both engagements ACTIVE. Excludes the caller themselves: the '
  'policy tests that separately. Cycle-guarded and depth-capped, so bad data cannot hang a query.';

revoke all on function authz.reports_to_me(uuid) from public;
grant execute on function authz.reports_to_me(uuid) to app_user, app_admin;

-- ═════════════════════════════════════════════════════════════════════════════════
-- authz.in_my_departments() — the DEPARTMENT branch for a table with no department
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The 4.2 template writes DEPARTMENT as `department_id = any (my_departments())`, which assumes
-- the row carries its own department. `people` does not: a person's department comes from their
-- live engagement (blueprint section 8). The obvious move is to inline that lookup in the policy —
-- and it does not work, for a reason worth writing down because it is invisible in review:
--
--   A SUBQUERY INSIDE A POLICY IS ITSELF SUBJECT TO RLS. The policy runs as app_user, so a
--   reference to public.engagements from inside it is filtered by the engagements policy — which
--   shows app_user their OWN engagement and, beyond that, only what engagements.view grants. A
--   DEPARTMENT holder of people.view (who is granted nothing on engagements) would therefore see
--   one engagement, their own, and the branch could never be true for a colleague. The policy
--   would read as correct, review as correct, and hide the whole department.
--
-- So the lookup moves into a definer function, exactly as the TEAM branch already had to. This is
-- the same pattern as authz.reports_to_me() above and for the same reason: a helper answers a
-- question ABOUT ANOTHER PERSON, which needs the owner's view of engagements, while the policy
-- decides what to do with the answer.
--
-- IT WIDENS NOTHING. The answer is one boolean about one person id, gated on the caller being
-- live, inside the caller's own organization (authz.org_id() is NULL on a spoofed claim, so a
-- mismatched tenant yields no rows), and the departments compared are the caller's own from
-- authz.my_departments(). A caller who holds no DEPARTMENT scope never reaches it: the policy's
-- CASE arm is what calls it.
create function authz.in_my_departments(p_person uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_person is not null
     and authz.is_active()
     and exists (
       select 1
       from public.engagements e
       where e.person_id = p_person
         and e.org_id = authz.org_id()
         and e.status = 'ACTIVE'
         and e.deleted_at is null
         and e.department_id = any (authz.my_departments())
     )
$$;

comment on function authz.in_my_departments(uuid) is
  'Whether the given person has a live engagement in one of the authenticated person''s '
  'departments, primary or secondary, within one organization and with the caller live. Exists '
  'because a policy subquery is itself subject to RLS, so the department of somebody else cannot '
  'be read from inside a policy.';

revoke all on function authz.in_my_departments(uuid) from public;
grant execute on function authz.in_my_departments(uuid) to app_user, app_admin;

-- ═════════════════════════════════════════════════════════════════════════════════
-- people — the first table where one person can read another
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- DEPARTMENT is not a column here. A person's department comes from their live engagement
-- (blueprint section 8: "primary department comes from the active engagement"), so the branch goes
-- through authz.in_my_departments() rather than a department_id that people does not have — see
-- that function for why the lookup cannot be inlined into this policy.
--
-- The record-grant arm names the entity 'person'. Nothing issues such a grant yet — the issuing
-- path is deferred — so it reaches nothing today, and is written now so that a grant, when one
-- exists, reaches exactly one row through the same policy as everything else.
drop policy people_select_self on public.people;

create policy people_select on public.people
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (
      id = (select authz.person_id())
      or (
        (select authz.is_active())
        and (
          case (select authz.scope_for('people.view'))
            when 'GLOBAL' then true
            when 'DEPARTMENT' then (select authz.in_my_departments(public.people.id))
            when 'TEAM' then (select authz.reports_to_me(public.people.id))
            when 'PROJECT' then false
            when 'SELF' then false
            else false
          end
          or (select authz.has_record_grant('person', public.people.id, 'people.view'))
        )
      )
    )
  );

-- ── the columns row access must not carry with it ────────────────────────────────
--
-- security.md section 2 footnote 2: SALES_MANAGER and PROJECT_MANAGER hold people.view at
-- DEPARTMENT for "directory-level fields only (name, title, department, work email, photo). Not
-- HR data." RLS filters ROWS. The moment the policy above lets a manager read a colleague's row,
-- date_of_birth, personal_email and phone travel with it unless something else stops them — and
-- database.md marks date_of_birth "sensitive: HR-only column policy".
--
-- Postgres has no per-request column policy, so this is enforced with the privilege system, which
-- is checked before any policy runs: the table-level grant is replaced by a column list that omits
-- the three. app_user cannot read them by any query, at any scope, under any identity, and a
-- `select *` on people now fails outright instead of quietly returning them.
--
-- WHO STILL READS THEM. app_owner, and therefore every SECURITY DEFINER function that needs them:
-- resolve_auth_identity(), the actor email snapshot inside write_audit_log(), the audit trigger.
-- Nothing on the application path does today, because no HR module exists yet.
--
-- WHAT THIS IS NOT. It is not the HR boundary itself. The architecture puts sensitive HR data in
-- its own table with its own permission — database.md section 5 does exactly that for compensation
-- — and hr.sensitive.view sits in the catalogue waiting for it. This keeps footnote 2 true in the
-- meantime instead of trusting every future query to select carefully.
--
-- WHAT THIS COSTS, AND IT IS NOT FREE. A column grant names columns that exist; it does not cover
-- columns added later, and the table-level grant that used to cover them is gone. So a migration
-- that adds a column to people leaves it unreadable by app_user until it is named here. That is
-- the fail-closed direction, and tests/db/scope-rls.test.ts asserts the withheld set is exactly
-- these three, so the next column to arrive fails a test instead of silently disappearing.
revoke select on public.people from app_user, app_admin;

grant select (
  id, org_id, code, auth_user_id,
  full_legal_name, preferred_name, work_email,
  photo_url, location, timezone,
  person_status, sessions_revoked_at,
  created_at, updated_at, created_by, updated_by, deleted_at
) on public.people to app_user;

-- ═════════════════════════════════════════════════════════════════════════════════
-- engagements, and the events that record their lifecycle
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Keyed on engagements.view, which the matrix grants to SUPER_ADMIN alone. Every other role
-- resolves NULL here and keeps exactly what it had: its own engagement. HR_MANAGER holding
-- engagements.transition at DEPARTMENT with no matching read is a gap in the matrix, not something
-- a policy may quietly fix.
drop policy engagements_select_self on public.engagements;

create policy engagements_select on public.engagements
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and (
      person_id = (select authz.person_id())
      or (
        (select authz.is_active())
        and (
          case (select authz.scope_for('engagements.view'))
            when 'GLOBAL' then true
            when 'DEPARTMENT' then department_id = any ((select authz.my_departments())::uuid[])
            when 'TEAM' then (select authz.reports_to_me(public.engagements.person_id))
            when 'PROJECT' then false
            when 'SELF' then false
            else false
          end
          or (select authz.has_record_grant('engagement', public.engagements.id, 'engagements.view'))
        )
      )
    )
  );

-- An event carries no subject of its own: it belongs to an engagement, and the engagement decides
-- who may read it. A policy cannot be called, so the predicate above is restated here rather than
-- consulted — and the two are then ANDed by something that is easy to miss: the reference to
-- public.engagements below is ITSELF subject to the engagements policy, because a policy subquery
-- runs as app_user like any other query (the same mechanism that forced
-- authz.in_my_departments() into a definer function).
--
-- So an event is reachable only when its engagement is reachable AND this predicate agrees. The
-- restatement is therefore not what makes this correct — the nested policy already bounds it — but
-- it keeps events from silently following a future widening of the engagements policy that nobody
-- considered from here. tests/db/scope-rls.test.ts asserts the two agree row for row.
drop policy engagement_events_select_self on public.engagement_events;

create policy engagement_events_select on public.engagement_events
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and exists (
      select 1
      from public.engagements e
      where e.id = public.engagement_events.engagement_id
        and e.deleted_at is null
        and (
          e.person_id = (select authz.person_id())
          or (
            (select authz.is_active())
            and (
              case (select authz.scope_for('engagements.view'))
                when 'GLOBAL' then true
                when 'DEPARTMENT' then e.department_id = any ((select authz.my_departments())::uuid[])
                when 'TEAM' then (select authz.reports_to_me(e.person_id))
                when 'PROJECT' then false
                when 'SELF' then false
                else false
              end
              or (select authz.has_record_grant('engagement', e.id, 'engagements.view'))
            )
          )
        )
    )
  );

-- ── the helper inventory ─────────────────────────────────────────────────────────
comment on schema authz is
  'Authorization helper functions. Every RLS policy is written in terms of these. '
  'Implemented: person_id, org_id, is_active_person, is_active, aal, my_departments, has, '
  'scope_for, has_record_grant, reports_to_me, in_my_departments. '
  'Remaining: is_project_member (Phase 4).';
