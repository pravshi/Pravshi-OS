-- PRAVSHI OS — Fix: project_members RLS policy recursion (post-V1 defect repair).
--
-- THE DEFECT. The four app_user policies on public.project_members (0042) each
-- carry an EXISTS arm that scans public.project_members itself:
--
--   exists (select 1 from public.project_members m
--           where m.project_id = project_members.project_id
--             and m.person_id = (select authz.person_id()) ...)
--
-- Evaluating the policy for a statement on project_members therefore requires
-- evaluating the same policy for the subquery scan, which requires it again —
-- unbounded RLS policy-expansion recursion. EVERY app_user statement against
-- the table errors, so GET/POST/DELETE /api/work/projects/[id]/members have
-- 500'd deterministically since Phase 4 shipped. The helper the original
-- design named for exactly this — authz.is_project_member(), planned in 0003,
-- 0009 and 0017 and deferred each time because project_members did not exist
-- yet — was never created once the table landed in 0042; the policies inlined
-- the self-scan instead.
--
-- THE FIX, in three parts, with NO widening of access:
--   1. authz.is_project_member(uuid) / authz.is_project_manager(uuid) — the
--      deferred helpers, SECURITY DEFINER in the 0003 idiom: the membership
--      probe runs as app_owner (project_members_owner_all), so it never
--      re-enters the app_user policy. Each helper reproduces its policy arm
--      EXACTLY (project + caller person; the manager arm adds the
--      role_in_project = 'manager' condition from the 0042 CHECK).
--   2. The four project_members policies are dropped and recreated with ONLY
--      the self-referencing EXISTS arms replaced by calls to the helpers.
--      Every other arm — org match, is_active(), the projects.view /
--      projects.manage_members keys, the update WITH CHECK — is unchanged.
--   3. public.project_member_directory(uuid) — a narrow roster read definer
--      (the 0059 precedent): the members list joins people for display
--      fields, but people RLS would hide roster names from any caller whose
--      people.view scope is narrower than the project roster they are
--      entitled to see. The directory returns display fields for live
--      members ONLY after re-checking the caller's read access to the
--      project itself (see its comment); a caller without project read
--      access gets zero rows, never an error and never a name.
--
-- PROJECT scope wiring is deliberately NOT part of this migration:
-- authz.scope_for() and the scope consumers keep answering exactly what they
-- answered before. These helpers exist to serve the project_members policies
-- and the roster directory, nothing else.

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — the membership helpers (authz, SECURITY DEFINER, the 0003 idiom)
-- ═════════════════════════════════════════════════════════════════════════════

create function authz.is_project_member(p_project_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members pm
    where pm.project_id = p_project_id
      and pm.person_id = (select authz.person_id())
  )
$$;
--> statement-breakpoint
comment on function authz.is_project_member(uuid) is
  'True iff the authenticated person (authz.person_id()) is a member of the '
  'named project. SECURITY DEFINER: the probe reads project_members as '
  'app_owner, so policies on project_members can call it without re-entering '
  'themselves — the recursion that broke every app_user statement on that '
  'table (0042''s inlined self-scan) is the defect this replaces. Planned in '
  '0003/0009/0017; landed in 0063 once its table existed.';
--> statement-breakpoint
create function authz.is_project_manager(p_project_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members pm
    where pm.project_id = p_project_id
      and pm.person_id = (select authz.person_id())
      and pm.role_in_project = 'manager'
  )
$$;
--> statement-breakpoint
comment on function authz.is_project_manager(uuid) is
  'True iff the authenticated person is a member of the named project with '
  'role_in_project = ''manager'' (the project-level arm of the '
  'project_members write policies). Same definer idiom and rationale as '
  'authz.is_project_member(uuid).';
--> statement-breakpoint
revoke all on function authz.is_project_member(uuid) from public;
--> statement-breakpoint
revoke all on function authz.is_project_manager(uuid) from public;
--> statement-breakpoint
grant execute on function authz.is_project_member(uuid) to app_user, app_admin;
--> statement-breakpoint
grant execute on function authz.is_project_manager(uuid) to app_user, app_admin;
--> statement-breakpoint
-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — the roster directory (public, SECURITY DEFINER, the 0059 idiom)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Gate, re-checked inside the definer on every call — a caller may read the
-- roster only when ALL of these hold, mirroring the project_members_select
-- arms plus the work_projects visibility idiom (0042):
--   * the project is live (deleted_at is null) and belongs to the caller's
--     own org — the org is DERIVED by authz.org_id() from the caller's
--     person, never taken from a parameter; the project id is the only
--     caller-supplied value and it is validated against that derived org;
--   * the caller is active (authz.is_active());
--   * the caller holds projects.view OR is a member of the project.
-- Rows: live membership rows for the project, joined to people for display
-- fields, with the people's own liveness applied (deleted_at is null and
-- person_status = 'ACTIVE', mirroring people visibility) so a soft-deleted
-- or deactivated person drops off the roster exactly as the people-join
-- under RLS dropped them. Failing the gate returns zero rows — fail-closed,
-- with no error that could distinguish "no such project" from "not yours".

create function public.project_member_directory(p_project_id uuid)
returns table (
  person_id uuid,
  display_name text,
  work_email text
)
language sql
stable
security definer
set search_path = ''
as $$
  select pm.person_id,
         coalesce(per.preferred_name, per.full_legal_name) as display_name,
         per.work_email::text as work_email
  from public.project_members pm
  join public.work_projects wp
    on wp.id = pm.project_id
  join public.people per
    on per.id = pm.person_id
  where pm.project_id = p_project_id
    and pm.org_id = wp.org_id
    and wp.org_id = (select authz.org_id())
    and wp.deleted_at is null
    and (select authz.is_active())
    and (
      (select authz.has('projects.view'))
      or (select authz.is_project_member(p_project_id))
    )
    and per.deleted_at is null
    and per.person_status = 'ACTIVE'
$$;
--> statement-breakpoint
comment on function public.project_member_directory(uuid) is
  'Roster read model for one project: (person_id, display_name, work_email) '
  'for its live members. SECURITY DEFINER so a caller entitled to the '
  'project roster is not silently scope-limited by people RLS; the gate '
  'inside re-checks project read access (own-org live project + is_active + '
  'projects.view or membership) and returns zero rows to anyone else. '
  'Consumed by the work projects service member list (0063).';
--> statement-breakpoint
revoke all on function public.project_member_directory(uuid) from public;
--> statement-breakpoint
grant execute on function public.project_member_directory(uuid) to app_user;
--> statement-breakpoint
-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — the four project_members policies, recursion removed
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Reproduced from 0042 with ONLY the self-referencing EXISTS arms replaced:
-- the select arm's membership probe becomes authz.is_project_member(...),
-- and the write arms' manager probe becomes authz.is_project_manager(...).
-- Nothing else changes.

drop policy if exists project_members_select on public.project_members;
--> statement-breakpoint
create policy project_members_select on public.project_members
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (
      (select authz.has('projects.view'))
      or (select authz.is_project_member(project_members.project_id))
    )
  );
--> statement-breakpoint
drop policy if exists project_members_insert on public.project_members;
--> statement-breakpoint
create policy project_members_insert on public.project_members
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (
      (select authz.has('projects.manage_members'))
      or (select authz.is_project_manager(project_members.project_id))
    )
  );
--> statement-breakpoint
drop policy if exists project_members_update on public.project_members;
--> statement-breakpoint
create policy project_members_update on public.project_members
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (
      (select authz.has('projects.manage_members'))
      or (select authz.is_project_manager(project_members.project_id))
    )
  )
  with check (
    org_id = (select authz.org_id())
  );
--> statement-breakpoint
drop policy if exists project_members_delete on public.project_members;
--> statement-breakpoint
create policy project_members_delete on public.project_members
  for delete to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.is_active())
    and (
      (select authz.has('projects.manage_members'))
      or (select authz.is_project_manager(project_members.project_id))
    )
  );
