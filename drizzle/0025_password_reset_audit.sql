-- ── 0025: password-reset audit ─────────────────────────────────────────────────
--
-- The audit entry for a completed password reset. Pre-auth the application runs as
-- app_user, which holds no INSERT grant on public.audit_logs, and
-- public.write_audit_log() derives its actor from the transaction identity — which
-- does not exist before authentication. This narrow SECURITY DEFINER function is the
-- only pre-auth write path to the audit trail for the reset flow, granted to
-- app_user alone. It attributes the entry to the person being reset (the actor of
-- this event), looked up by their login id; a login maps to exactly one person via
-- the people_auth_user_unique index.
--
-- The login-event trail (PASSWORD_RESET_REQUESTED / PASSWORD_RESET_COMPLETED via
-- public.record_login_event()) is the auth-outcome evidence the login route pattern
-- uses; this audit entry is the security-event evidence: a credential changed hands.

create function authz.record_password_reset_audit(
  p_auth_user_id uuid,
  p_ip inet,
  p_user_agent text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person_id uuid;
  v_org_id uuid;
  v_email text;
begin
  select u.email into v_email
  from auth.auth_users u
  where u.id = p_auth_user_id;

  select p.id, p.org_id into v_person_id, v_org_id
  from public.people p
  where p.auth_user_id = p_auth_user_id
    and p.deleted_at is null
  limit 1;

  -- org_id is NOT NULL on audit_logs. Every login minted by bootstrap or the
  -- invitation flow has a person row; if one somehow does not, there is no tenant
  -- to attribute the entry to, so skip rather than fail — the login event already
  -- recorded the outcome.
  if v_org_id is null then
    return;
  end if;

  insert into public.audit_logs (
    org_id, actor_person_id, actor_email_snapshot, actor_ip, user_agent,
    action, entity_type, entity_id, severity, result, metadata
  )
  values (
    v_org_id, v_person_id, v_email, p_ip, p_user_agent,
    'auth.password_reset', 'auth_user', p_auth_user_id, 'HIGH', 'SUCCESS',
    jsonb_build_object('sessions_revoked', true)
  );
end;
$$;

comment on function authz.record_password_reset_audit(uuid, inet, text) is
  'Audit entry for a completed password reset, attributed to the person being '
  'reset. The only pre-auth write path app_user has to audit_logs for this flow.';

revoke all on function authz.record_password_reset_audit(uuid, inet, text) from public;
grant execute on function authz.record_password_reset_audit(uuid, inet, text) to app_user;
