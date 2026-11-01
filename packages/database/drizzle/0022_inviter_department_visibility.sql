-- PRAVSHI OS — Phase 1: inviter department visibility.
--
-- WHY THIS POLICY EXISTS
--
-- An invitation for someone without a live engagement carries the engagement the
-- acceptance will create — including its department (migration 0018). The invite
-- dialog must therefore let the inviter see every ACTIVE department in the
-- organization. departments_select_mine (migration 0004) only shows departments the
-- viewer belongs to, which is right for browsing but wrong for placing a new hire.
--
-- This policy opens the ACTIVE department list to whoever may issue invitations —
-- the same breadth the invitations policies demand (users.create at GLOBAL scope,
-- with a live engagement). It grants SELECT only: department membership itself is
-- still managed through the departments.manage flows, and nothing here widens what
-- a non-inviter can see.

create policy departments_select_inviter on public.departments
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and deleted_at is null
    and status = 'ACTIVE'
    and (select authz.is_active())
    and (select authz.scope_for('users.create')) = 'GLOBAL'
  );

comment on policy departments_select_inviter on public.departments is
  'Lets a GLOBAL users.create holder see every ACTIVE department, so the invite '
  'dialog can place the invitee. SELECT only; membership management is unchanged.';
