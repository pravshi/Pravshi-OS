-- PRAVSHI OS — Phase 10 (Wave W-in): inbound endpoint-key storage + resolution.
--
-- PART 1 — public.integration_connections.inbound_endpoint_key_hash: the
--   SHA-256 hex digest of the connection's unguessable inbound endpoint key
--   (contract §4.4). Wave I's 0056 landed the connections table without a
--   home for this digest; the inbound receiver resolves org ONLY from this
--   hash, so it belongs on the connection row itself. Only the digest is
--   ever stored — the plaintext key is returned to the issuing admin exactly
--   once (the invitations precedent, migration 0019) and never reaches the
--   database, a log, or an audit entry. NULL means: no inbound endpoint has
--   been issued for this connection. Re-issuing overwrites the digest,
--   which is what makes rotation revoke the old key.
-- PART 2 — the partial UNIQUE index: one digest names at most one
--   connection, across all orgs, so resolution is never ambiguous. Partial
--   (WHERE ... IS NOT NULL) because most connections have no endpoint key.
-- PART 3 — public.integration_inbound_resolve_endpoint(): the pre-auth
--   resolution read (see the safety note at the function).
-- PART 4 — public.integration_inbound_find_receipt(): the pre-auth dedup
--   read (see the safety note at the function).
--
-- No RLS changes: the column lands on an existing RLS table and inherits
-- its policies; the 0056 identity-freeze trigger deliberately does not list
-- the new column, so the manage-gated UPDATE policy alone governs rotation.

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 1 — the endpoint-key digest column
-- ═════════════════════════════════════════════════════════════════════════════════

alter table public.integration_connections
  add column inbound_endpoint_key_hash text;

--> statement-breakpoint

comment on column public.integration_connections.inbound_endpoint_key_hash is
  'Phase 10 (0058): SHA-256 hex digest of the inbound endpoint key; the '
  'plaintext key is shown once at issuance and never stored. NULL = no '
  'inbound endpoint issued. Org resolution for inbound webhooks starts here '
  'and nowhere else (§4.4).';

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 2 — one digest, one connection
-- ═════════════════════════════════════════════════════════════════════════════════

create unique index integration_connections_inbound_endpoint_key_hash_unique
  on public.integration_connections (inbound_endpoint_key_hash)
  where inbound_endpoint_key_hash is not null;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 3 — pre-auth endpoint resolution
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- WHY SECURITY DEFINER, AND WHY IT IS SAFE
--
-- The inbound route is pre-authentication: no session exists, so no org
-- context exists, so the connections SELECT policy (org match +
-- integrations.view) can never be satisfied by the lookup that ESTABLISHES
-- the org — the same chicken-and-egg the invitations flow solved with
-- invitation_preview() (migration 0019), which this follows exactly.
--
-- The parameter is not an identity claim: it is the SHA-256 digest of a
-- 256-bit random key, and the function returns only the single row that
-- owns that digest — nothing about any other connection or organization is
-- reachable through any parameter value. §4.7's rule (a definer must not
-- trust caller-supplied org/person ids) is honoured in substance: no org
-- or person id is accepted at all; the org and the dispatch actor
-- (connected_by) are READ FROM the resolved row, never from the caller.
-- The returned config is the connection's own non-secret jsonb (§4.1) —
-- the handler needs inboundEnabled from it — and no credential column is
-- exposed: the digest itself is returned only so the handler can run the
-- §4.5 constant-time verification step against what was presented.

create function public.integration_inbound_resolve_endpoint(p_endpoint_key_hash text)
returns table (
  connection_id uuid,
  org_id uuid,
  provider_key text,
  status text,
  config jsonb,
  connected_by uuid,
  endpoint_key_hash text
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.org_id, c.provider_key, c.status, c.config, c.connected_by,
         c.inbound_endpoint_key_hash
  from public.integration_connections c
  where c.inbound_endpoint_key_hash = p_endpoint_key_hash;
$$;

comment on function public.integration_inbound_resolve_endpoint(text) is
  'Phase 10 (0058): pre-auth inbound endpoint resolution — the connection '
  'row owning one endpoint-key SHA-256 digest. Narrow by design (the '
  'invitation_preview precedent): returns no credential material and '
  'nothing about any other row.';

revoke all on function public.integration_inbound_resolve_endpoint(text) from public;
grant execute on function public.integration_inbound_resolve_endpoint(text) to app_user;

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 4 — pre-auth dedup read
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- WHY SECURITY DEFINER, AND WHY IT IS SAFE
--
-- Receipt writes run under the resolved org context through 0056's
-- tenant-only INSERT/UPDATE policies, exactly as designed there. Receipt
-- READS cannot: the 0056 SELECT policy additionally requires
-- integrations.view, which a pre-auth handler does not hold (its org
-- context carries no person identity). Dedup, however, must read — by
-- (connection, external event id) and by payload hash — before it may
-- write. This function is that read, kept as narrow as the resolution
-- read above: the caller must already know the connection id (learned
-- only from PART 3, i.e. only by presenting the endpoint key), and the
-- function returns one receipt's id and status, never its contents.
--
-- Match precedence: an external-event-id match wins ('external'); else a
-- payload-hash match inside the dedup window ('payload'). The window is
-- 24 hours and lives HERE — src/lib/integrations/inbound.ts mirrors it as
-- INBOUND_DEDUP_WINDOW_HOURS for documentation/tests; move them together.

create function public.integration_inbound_find_receipt(
  p_connection_id uuid,
  p_external_event_id text,
  p_payload_hash text
)
returns table (
  receipt_id uuid,
  receipt_status text,
  match_kind text
)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.status, 'external'::text
  from public.integration_inbound_events e
  where p_external_event_id is not null
    and e.connection_id = p_connection_id
    and e.external_event_id = p_external_event_id
  union all
  select e.id, e.status, 'payload'::text
  from public.integration_inbound_events e
  where not exists (
      select 1
      from public.integration_inbound_events x
      where p_external_event_id is not null
        and x.connection_id = p_connection_id
        and x.external_event_id = p_external_event_id
    )
    and e.connection_id = p_connection_id
    and e.payload_hash = p_payload_hash
    and e.status in ('RECEIVED', 'PROCESSED')
    and e.received_at > now() - interval '24 hours'
  order by 3
  limit 1;
$$;

comment on function public.integration_inbound_find_receipt(uuid, text, text) is
  'Phase 10 (0058): pre-auth inbound dedup read — the existing receipt for '
  '(connection, external event id), else a same-payload receipt inside '
  'the 24h dedup window. Returns id/status/match-kind only.';

revoke all on function public.integration_inbound_find_receipt(uuid, text, text) from public;
grant execute on function public.integration_inbound_find_receipt(uuid, text, text) to app_user;
