-- PRAVSHI OS — Phase 1 Task 1.8: scope resolution.
--
-- Task 1.7 answered "does this person hold this permission at all". This answers "how far
-- does it reach", which is the half every RLS policy branches on:
--
--   person -> live engagement -> assigned roles -> role grants -> ONE effective scope
--
-- ── WHY min() IS THE WHOLE ALGORITHM ─────────────────────────────────────────────
--
-- Blueprint 7.2: "Effective scope = the broadest scope granted across all of my roles for
-- that permission." Task 1.7 declared access_scope broadest-first —
-- GLOBAL, DEPARTMENT, TEAM, PROJECT, SELF — precisely so that Postgres enum ordering IS
-- the breadth ordering. min() over the matching grants therefore returns the broadest one,
-- with no CASE ladder, no numeric rank column and no second ranking mechanism to keep in
-- agreement with the enum. Reordering the enum would silently invert this; the type
-- comment in 0008 says so, and so does this one.
--
-- min() also collapses the union naturally: a person holding leads.view at SELF through
-- SALES and at DEPARTMENT through SALES_MANAGER gets exactly one answer, DEPARTMENT, and
-- dropping the broader role narrows it on the very next query. Nothing is cached, no role
-- is "primary", no role name is compared, and no seniority is inferred.

create function authz.scope_for(p_permission text) returns public.access_scope
language sql
stable
security definer
set search_path = ''
as $$
  select min(rp.scope)
  from public.person_roles pr
  join public.roles r
    on r.id = pr.role_id
   and r.org_id = pr.org_id
  join public.role_permissions rp on rp.role_id = r.id
  join public.permissions p on p.id = rp.permission_id
  where pr.person_id = authz.person_id()
    and pr.org_id = authz.org_id()
    -- Expiry is enforced in the authorization query itself, not by a job that removes
    -- rows. There is nothing to schedule, nothing that can fail to run, and no window in
    -- which an expired assignment still answers. Blueprint 7.3 makes the same argument for
    -- record_grants.
    and (pr.expires_at is null or pr.expires_at > now())
    and r.deleted_at is null
    and r.status = 'ACTIVE'
    and p.key = p_permission
    -- Access is derived from the engagement, read from the tables on every call
    -- (blueprint 7.4 step 2, checked before the permission question at step 4). A person
    -- on NOTICE_PERIOD, SUSPENDED, OFFBOARDING or ARCHIVED keeps their assignments and
    -- resolves no scope at all. person_status = ACTIVE is not this check and never
    -- substitutes for it: authz.is_active() reads engagements and organizations.
    and authz.is_active()
$$;

comment on function authz.scope_for(text) is
  'The broadest access_scope the authenticated person holds for this permission, or NULL '
  'when they do not hold it or their engagement is not live. One scope, never a set.';

-- ── has() becomes a restatement of scope_for(), not a parallel implementation ─────
--
-- database.md section 4.1 defines has(p) as "scope_for(p) is not null". Task 1.7 had to
-- express that as its own query because scope_for did not exist yet, which left two
-- predicates that had to be kept in agreement by hand — the kind of duplication that stays
-- correct until exactly one of them is edited.
--
-- Written this way the equivalence is not a property to be tested and hoped for, it is the
-- definition. It holds in both directions for every identity state because role_permissions
-- .scope is NOT NULL: if any grant matches, min() is non-null, so has() is true; if none
-- matches — no identity, no roles, expired assignment, archived role, dead engagement,
-- foreign tenant, unknown key — min() over the empty set is NULL, so has() is false.
-- The tests assert it anyway, on every seeded role and every identity state, because a
-- claim like this earns its assertions.
create or replace function authz.has(p_permission text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select authz.scope_for(p_permission) is not null
$$;

comment on function authz.has(text) is
  'Whether the authenticated person holds this permission at any scope. Defined as '
  'authz.scope_for(p) is not null, so the two can never disagree.';

-- ── my_departments() reaches its final semantics ─────────────────────────────────
--
-- Task 1.4 shipped this deliberately narrow and said so: database.md defines it as
-- "primary + secondary", the primary department lives on the active engagement, and
-- `engagements` did not exist yet. It returned secondary membership alone — narrower than
-- the final behaviour, never broader, so no policy written against it could over-grant in
-- the meantime. The table it was waiting for arrived in Task 1.5, and DEPARTMENT scope is
-- unusable without it: a person whose only department comes from their engagement would
-- resolve DEPARTMENT and then match nothing.
--
-- WHAT COUNTS AS THE PRIMARY DEPARTMENT. Blueprint section 8: "Primary department comes
-- from the active engagement." The engagement condition here is the same one
-- authz.is_active() uses — status ACTIVE and not soft-deleted — rather than an additional
-- is_primary filter. Two reasons: the whole authorization chain already turns on that one
-- definition of live, and a second concurrent ACTIVE engagement is a real working
-- relationship whose department the person genuinely belongs to. The
-- one_primary_active_engagement index means at most one of them is flagged primary anyway.
--
-- Everything else the helper already did is preserved: archived and soft-deleted
-- departments are excluded, the tenant is derived rather than accepted, and an absent
-- identity yields an empty array rather than every department. There is no organization-
-- wide fallback at any point — an empty result is an empty result, and DEPARTMENT scope
-- over no departments correctly matches nothing.
create or replace function authz.my_departments() returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct d.id), '{}'::uuid[])
  from public.departments d
  where d.org_id = authz.org_id()
    and d.deleted_at is null
    and d.status = 'ACTIVE'
    and (
      -- primary: the department of a live engagement
      exists (
        select 1
        from public.engagements e
        where e.person_id = authz.person_id()
          and e.org_id = d.org_id
          and e.department_id = d.id
          and e.status = 'ACTIVE'
          and e.deleted_at is null
      )
      -- secondary: explicit additional membership
      or exists (
        select 1
        from public.person_departments pd
        where pd.person_id = authz.person_id()
          and pd.org_id = d.org_id
          and pd.department_id = d.id
          and pd.deleted_at is null
      )
    )
$$;

comment on function authz.my_departments() is
  'Departments of the authenticated person, as uuid[]: the primary department from a live '
  'engagement plus secondary person_departments membership, deduplicated. Archived, '
  'soft-deleted and other-tenant departments are excluded; no identity yields an empty '
  'array, never a wildcard.';

-- ── the authorization access path ────────────────────────────────────────────────
--
-- database.md section 8 names `create index on engagements (person_id, status)` in the V1
-- index plan. It is the exact lookup authz.is_active() and the primary-department branch
-- above both perform, and both now run on every authorization question rather than
-- occasionally. Partial on deleted_at because every one of those callers filters it.
--
-- This overlaps the Task 1.5 index on (person_id) alone, which is now a prefix of it. The
-- older index is left in place rather than dropped: removing an index that other query
-- plans may already depend on is a separate, measurable decision, not a side effect of
-- adding this one.
create index engagements_person_status_idx
  on public.engagements (person_id, status) where deleted_at is null;

-- ── grants ───────────────────────────────────────────────────────────────────────
--
-- CREATE OR REPLACE preserves existing grants, so has() and my_departments() keep theirs;
-- the pairs are repeated so this migration is correct on a database where those functions
-- were created by earlier migrations and on one where the whole chain runs at once. No
-- PUBLIC execute on any of them.

revoke all on function authz.scope_for(text) from public;
revoke all on function authz.has(text) from public;
revoke all on function authz.my_departments() from public;

grant execute on function authz.scope_for(text) to app_user, app_admin;
grant execute on function authz.has(text) to app_user, app_admin;
grant execute on function authz.my_departments() to app_user, app_admin;

-- ── RLS: what changes, and what deliberately does not ────────────────────────────
--
-- No policy text is edited by this migration, and that is a decision rather than an
-- omission.
--
-- ONE POLICY CHANGES BEHAVIOUR, THROUGH THE HELPER RATHER THAN THROUGH AN EDIT.
-- departments_select_mine (Task 1.4) already reads
--   id = any ((select authz.my_departments())::uuid[])
-- — the corrected array form from commit c92a215, with the (select ...) InitPlan wrapper
-- that makes the helper run once per query instead of once per row. Now that the helper
-- returns primary + secondary, a person sees the department they actually work in as well
-- as the ones they additionally sit in. That widening is the authoritative definition of
-- my_departments() arriving, not a new grant invented here.
--
-- WHY THE database.md 4.2 TEMPLATE IS NOT APPLIED TO THE EXISTING TABLES YET.
-- The template branches on all five scopes:
--
--   GLOBAL      -> true                                     available now
--   DEPARTMENT  -> any ((select authz.my_departments()))    available now
--   TEAM        -> authz.reports_to_me(owner)               DOES NOT EXIST
--   PROJECT     -> authz.is_project_member(project)         DOES NOT EXIST (Phase 4)
--   SELF        -> owner = authz.person_id()                available now
--
-- plus `or authz.has_record_grant(...)`, which needs record_grants (Task 1.9). A policy
-- written today would have to answer false for TEAM and PROJECT. That fails closed, so it
-- would be safe — and it would also be a silent under-grant baked into every table, of
-- exactly the kind nobody notices until someone reports missing data months later. The
-- honest state is that scope resolution is complete and its consumers are not, so the
-- policies stay as each task left them: provable from relationships that exist, and
-- narrower than the final design rather than wider.

comment on schema authz is
  'Authorization helper functions. Every RLS policy is written in terms of these. '
  'Implemented: person_id, org_id, is_active_person, is_active, aal, my_departments, has, '
  'scope_for. Remaining: reports_to_me, is_project_member, has_record_grant.';
