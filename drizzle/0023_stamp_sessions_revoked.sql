-- ── 0023: stamp_sessions_revoked ─────────────────────────────────────────────
--
-- The second half of session revocation. Deleting auth_sessions rows kills the
-- sessions that exist now; stamping people.sessions_revoked_at means any session
-- that somehow survives (issued in a race, restored from a backup) fails its next
-- resolution — resolve_auth_identity() (0013) refuses sessions created before the
-- stamp. Blueprint section 25.
--
-- app_user holds only a SELECT policy on public.people, so the application cannot
-- write the stamp directly. This narrow SECURITY DEFINER function is the only
-- writer, granted to app_user alone. It stamps by auth_user_id (not person_id)
-- because revocation is keyed to the login, and a login maps to exactly one person
-- via the people_auth_user_unique index.

create function authz.stamp_sessions_revoked(p_auth_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.people
  set sessions_revoked_at = now(),
      updated_at = now()
  where auth_user_id = p_auth_user_id;
end;
$$;

comment on function authz.stamp_sessions_revoked(uuid) is
  'Bulk session invalidation: stamps sessions_revoked_at for the person holding this login. '
  'The only write path app_user has to that column; called by revokeSessionsFor().';

revoke all on function authz.stamp_sessions_revoked(uuid) from public;
grant execute on function authz.stamp_sessions_revoked(uuid) to app_user;
