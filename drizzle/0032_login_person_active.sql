-- ── 0032: login_person_active ────────────────────────────────────────────────
--
-- BUG-002 FIX, PART 1 (database half). suspendUser() sets person_status='INACTIVE',
-- and resolve_auth_identity() (0013) already refuses such people on every request —
-- existing sessions die on their next resolution. But the LOGIN ROUTE minted the
-- session without asking: a suspended user got a valid session cookie plus a
-- misleading LOGIN_SUCCESS event.
--
-- The login and MFA-verify routes run pre-auth as app_user, whose RLS view of
-- public.people is deliberately narrow, so the status question goes through this
-- narrow SECURITY DEFINER function — the same pattern as resolve_login_org()
-- and authz.mfa_enrollment_required() (0027). It answers one question: is there
-- a person row for this login that is deleted or INACTIVE? If yes, the session
-- must not be minted. If no person row exists (unprovisioned login), the session
-- is allowed — resolve_auth_identity() will return null for it, and the
-- provisioning flow handles the rest.
--
-- PART 2 (application half) lives in src/lib/auth/login-person-check.ts and the
-- session.create.before hook in src/lib/auth/server.ts. On false the hook returns
-- false, which Better Auth turns into 401 UNAUTHORIZED (FAILED_TO_CREATE_SESSION);
-- the mediated routes then record their normal failure events and answer the
-- deliberately generic 401 — the same answer as a wrong password, so suspension
-- is not distinguishable from bad credentials.

create or replace function authz.login_person_active(p_auth_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- False only when a person row exists AND it is deleted or not ACTIVE.
  -- No person row (unprovisioned login) returns true; the identity resolution
  -- layer handles the null case, and blocking here would break the
  -- invitation/provisioning flows that mint sessions before the person exists.
  return not exists (
    select 1
    from public.people p
    where p.auth_user_id = p_auth_user_id
      and (p.deleted_at is not null or p.person_status <> 'ACTIVE')
  );
end;
$$;

comment on function authz.login_person_active(uuid) is
  'Pre-auth liveness gate for session minting: false only when the login maps to '
  'a deleted or non-ACTIVE person. A login with no person row (unprovisioned) '
  'returns true; resolve_auth_identity() handles the null. Called by the '
  'session.create.before hook; fail closed on database error.';

revoke all on function authz.login_person_active(uuid) from public;
grant execute on function authz.login_person_active(uuid) to app_user;
