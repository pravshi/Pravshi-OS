-- PRAVSHI OS — Phase 10 (CI fix wave 2): the integrations write plane —
-- DELETE privilege for app_user, and definer-mediated inbound receipt
-- writes. No tables, no data changes; applies identically on fresh and
-- upgraded chains.
--
-- PART 1 — DELETE privilege on the five integration_* tables. The platform
--   model (scripts/db/roles.sql) grants app_user SELECT/INSERT/UPDATE on
--   public tables and never DELETE; revocation-style flows that do delete
--   take a scoped exception in a migration instead (the 0013 auth-tables
--   precedent). Phase 10 ships two such flows — disconnectConnection and
--   deleteSubscription hard-delete their rows — and 0056 already wrote
--   their DELETE policies, but a policy can only gate a privilege the role
--   holds: without the grant, every DELETE raises 42501 at the privilege
--   layer before RLS is consulted. The grant is therefore extended to all
--   five tables uniformly. The privilege is the COARSE gate only; the
--   0056 RLS policies remain the real gate: connections/subscriptions
--   deletes stay integrations.manage-gated inside the caller's org, and
--   deliveries / inbound events / checkpoints have NO delete policy at
--   all, so a DELETE there matches zero rows (their append-only /
--   audit-trail posture is unchanged — it is now enforced by policy
--   rather than by a misleading privilege error).
-- PART 2 — public.integration_inbound_write_receipt(): the inbound
--   receipt INSERT, mediated (see the safety note at the function).
-- PART 3 — public.integration_inbound_set_receipt_status(): the receipt
--   status transitions, mediated (same note).
--
-- WHY THE WRITES NEED DEFINERS (PARTS 2–3)
--
-- 0056 designed receipt writes to run "inside the resolved org's RLS
-- context" through its tenant-only INSERT/UPDATE policies
-- (org_id = authz.org_id()). But authz.org_id() (0003) derives the org
-- FROM THE PERSON — it looks the person up in public.people — and the
-- pre-auth inbound context has no person (the nil UUID): org_id() is
-- NULL there, the WITH CHECK can never hold, and every receipt insert is
-- refused (status transitions silently touch zero rows for the same
-- reason). The reads on this plane already crossed the same wall through
-- 0058's narrow definers; the writes now cross it the same way, on the
-- notifications_insert (0047) pattern. Neither function accepts an org or
-- person id: the org is DERIVED inside, from the connection row (PART 2)
-- or the receipt row itself (PART 3).

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 1 — DELETE privilege (the 0013 scoped-exception pattern)
-- ═════════════════════════════════════════════════════════════════════════════════

grant delete on
  public.integration_connections,
  public.integration_webhook_subscriptions,
  public.integration_webhook_deliveries,
  public.integration_inbound_events,
  public.integration_sync_checkpoints
to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 2 — inbound receipt write
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The caller must already have resolved the endpoint (0058 PART 3) — this
-- function does not trust that it did: it re-verifies, inside, that
-- p_endpoint_key_hash equals the connection's stored digest and refuses
-- (42501, the guard triggers' code) when it does not, when the connection
-- holds no digest, or when the connection does not exist. org_id and
-- provider_key are read FROM THE CONNECTION ROW; endpoint_key stores the
-- verified digest. p_mark_processed mirrors the service's insert-time
-- distinction: terminal receipts (REJECTED_* / DUPLICATE) are stamped
-- processed_at at insert; the RECEIVED receipt is not.

create function public.integration_inbound_write_receipt(
  p_connection_id uuid,
  p_endpoint_key_hash text,
  p_external_event_id text,
  p_payload_hash text,
  p_status text,
  p_mark_processed boolean
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_provider_key text;
  v_id uuid;
begin
  select c.org_id, c.provider_key
    into v_org_id, v_provider_key
  from public.integration_connections c
  where c.id = p_connection_id
    and c.inbound_endpoint_key_hash = p_endpoint_key_hash;

  if v_org_id is null then
    raise exception 'integration inbound receipt: endpoint verification failed for connection %', p_connection_id
      using errcode = '42501';
  end if;

  insert into public.integration_inbound_events (
    org_id, connection_id, provider_key, endpoint_key,
    external_event_id, payload_hash, status, processed_at
  ) values (
    v_org_id, p_connection_id, v_provider_key, p_endpoint_key_hash,
    p_external_event_id, p_payload_hash, p_status,
    case when p_mark_processed then now() else null end
  )
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.integration_inbound_write_receipt(uuid, text, text, text, text, boolean) is
  'Phase 10 (0060): pre-auth inbound receipt write — inserts one receipt '
  'for a connection whose stored endpoint-key digest matches the '
  'presented digest, deriving org_id/provider_key from the connection '
  'row (the notifications_insert precedent). Exists because '
  'authz.org_id() derives from the person and the pre-auth context has '
  'none, so 0056''s tenant-only receipt policies can never admit this '
  'write directly.';

revoke all on function public.integration_inbound_write_receipt(uuid, text, text, text, text, boolean) from public;
grant execute on function public.integration_inbound_write_receipt(uuid, text, text, text, text, boolean) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 3 — inbound receipt status transition
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- The receipt id is the only locator; the row's org is read from the row
-- itself and the UPDATE is predicated on it, so no parameter can steer
-- the write into another tenant. Only status (and processed_at, when
-- p_mark_processed) changes — the 0056 identity-freeze trigger bounds the
-- definer exactly as it bounds any other writer. Returns whether the
-- receipt exists and was transitioned; a missing receipt is false, not
-- an error (the service's transitions are fire-and-forget by design).

create function public.integration_inbound_set_receipt_status(
  p_receipt_id uuid,
  p_status text,
  p_mark_processed boolean
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_updated integer;
begin
  select e.org_id into v_org_id
  from public.integration_inbound_events e
  where e.id = p_receipt_id;

  if v_org_id is null then
    return false;
  end if;

  update public.integration_inbound_events e
  set status = p_status,
      processed_at = case when p_mark_processed then now() else e.processed_at end
  where e.id = p_receipt_id
    and e.org_id = v_org_id;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

comment on function public.integration_inbound_set_receipt_status(uuid, text, boolean) is
  'Phase 10 (0060): pre-auth inbound receipt status transition — derives '
  'the receipt''s org from its own row and updates only status (plus '
  'processed_at when asked). Companion to '
  'integration_inbound_write_receipt; exists for the same reason '
  '(authz.org_id() is NULL without a person).';

revoke all on function public.integration_inbound_set_receipt_status(uuid, text, boolean) from public;
grant execute on function public.integration_inbound_set_receipt_status(uuid, text, boolean) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 4 — verification: fail the migration rather than leave a
-- half-built write plane (the 0047 pattern)
-- ═════════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_problems text;
begin
  select string_agg(p, '; ') into v_problems
  from (values
    ('app_user DELETE missing on integration_connections',
      has_table_privilege('app_user', 'public.integration_connections', 'DELETE')),
    ('app_user DELETE missing on integration_webhook_subscriptions',
      has_table_privilege('app_user', 'public.integration_webhook_subscriptions', 'DELETE')),
    ('app_user DELETE missing on integration_webhook_deliveries',
      has_table_privilege('app_user', 'public.integration_webhook_deliveries', 'DELETE')),
    ('app_user DELETE missing on integration_inbound_events',
      has_table_privilege('app_user', 'public.integration_inbound_events', 'DELETE')),
    ('app_user DELETE missing on integration_sync_checkpoints',
      has_table_privilege('app_user', 'public.integration_sync_checkpoints', 'DELETE')),
    ('integration_inbound_write_receipt missing or not SECURITY DEFINER',
      exists (select 1 from pg_proc
              where oid = to_regprocedure('public.integration_inbound_write_receipt(uuid, text, text, text, text, boolean)')
                and prosecdef)),
    ('integration_inbound_set_receipt_status missing or not SECURITY DEFINER',
      exists (select 1 from pg_proc
              where oid = to_regprocedure('public.integration_inbound_set_receipt_status(uuid, text, boolean)')
                and prosecdef))
  ) as checks(p, ok)
  where not ok;

  if v_problems is not null then
    raise exception 'integrations write-plane migration verification failed: %', v_problems;
  end if;
end;
$$;
