-- PRAVSHI OS — Phase 10: Integrations Platform — schema tranche.
--
-- PART 1 — public.integration_connections: one org's connection to one
--   provider (contract §4.1). Provider definitions are CODE (the registry in
--   src/lib/integrations/providers/, the Phase 9 AI precedent); the database
--   holds org state only, so there is deliberately no providers table.
--   `config` is non-secret configuration only; credentials live in the §4.3
--   columns: Tier V vault ciphertext (credential_ciphertext / _nonce /
--   _key_version) or a Tier E env reference (credential_ref). No raw secret,
--   token, prompt or content column exists on this table — by design.
-- PART 2 — public.integration_webhook_subscriptions: outbound subscriptions.
--   Per-endpoint signing secrets are generated server-side, shown exactly
--   once, and stored only as Tier V ciphertext (§4.3).
-- PART 3 — public.integration_webhook_deliveries: the queryable link between
--   a subscription and the job that delivered it. Jobs remain the system of
--   record for attempts/retries; this table exists because jobs.payload is
--   not indexable per subscription. Append-only.
-- PART 4 — public.integration_inbound_events: inbound receipt + processing
--   record. The raw body is NOT stored in V1 — only its SHA-256
--   (payload_hash). endpoint_key stores the per-connection URL token's hash,
--   never the token (the invitations precedent). org is resolved ONLY from
--   the endpoint key (§4.4); a payload-supplied org id is never trusted.
-- PART 5 — public.integration_sync_checkpoints: schema only in V1 — the
--   sync engine is deferred (§4.6); landing the table now avoids a second
--   schema migration when the first sync provider is confirmed. No service
--   writes it in V1.
-- PART 6 — verification DO blocks (the 0047 pattern): fail closed.
--
-- Identity columns (org_id, provider_key / parent FKs, created_by /
-- connected_by, created_at) are frozen on UPDATE by BEFORE UPDATE integrity
-- triggers — the 0010/0018 enforce_*_integrity pattern, which is how this
-- repository freezes identity (RLS policies cannot reference OLD). The RLS
-- UPDATE policies below additionally gate WHO may update at all.

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 1 — public.integration_connections
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  -- Must exist in the code provider registry — enforced in the service,
  -- not a FK (providers are code, §4.1 decision).
  provider_key text not null,
  display_name text not null,

  status text not null default 'NOT_CONFIGURED'
    constraint integration_connections_status_check check (status in (
      'CONNECTED', 'DISCONNECTED', 'ERROR', 'NOT_CONFIGURED'
    )),

  -- Non-secret configuration only (base URLs, region, feature flags).
  -- Secrets NEVER live here; see the credential columns below.
  config jsonb not null default '{}'::jsonb,

  -- §4.3 Tier V vault: AES-256-GCM envelope parts, base64 text. All null
  -- when the connection holds no org-entered credential.
  credential_ciphertext text,
  credential_nonce text,
  credential_key_version int,
  -- §4.3 Tier E: the NAME of the deployment env credential this connection
  -- references (e.g. an env-ref key), never the credential itself.
  credential_ref text,

  connected_by uuid references public.people (id),
  last_health_at timestamptz,
  -- Normalized error code only; never a raw provider error (§4.3 redaction).
  last_error_code text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

--> statement-breakpoint

create index integration_connections_org_provider_idx
  on public.integration_connections (org_id, provider_key);

--> statement-breakpoint

create index integration_connections_org_status_idx
  on public.integration_connections (org_id, status);

--> statement-breakpoint

create trigger integration_connections_set_updated_at
  before update on public.integration_connections
  for each row execute function public.set_updated_at();

--> statement-breakpoint

comment on table public.integration_connections is
  'Phase 10: one org''s connection to one code-registered provider. config '
  'is non-secret only; credentials exist solely as Tier V vault ciphertext '
  'or a Tier E credential_ref (§4.3). Disconnect destroys the ciphertext.';

--> statement-breakpoint

-- ── RLS: ENABLED + FORCED (the 0047/0052 template) ────────────────────────────

alter table public.integration_connections enable row level security;
alter table public.integration_connections force row level security;

create policy integration_connections_owner_all on public.integration_connections
  for all to app_owner using (true) with check (true);

--> statement-breakpoint

create policy integration_connections_select on public.integration_connections
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.has('integrations.view'))
  );

--> statement-breakpoint

-- The actor comes from the transaction identity, never from a column the
-- caller supplies (the 0006/0010 rule): connected_by must be the creator.
create policy integration_connections_insert on public.integration_connections
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.has('integrations.manage'))
    and connected_by = (select authz.person_id())
  );

--> statement-breakpoint

create policy integration_connections_update on public.integration_connections
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.has('integrations.manage'))
  )
  with check (
    org_id = (select authz.org_id())
    and (select authz.has('integrations.manage'))
  );

--> statement-breakpoint

-- Disconnect (§4.4 DELETE) is a hard action distinct from status edits:
-- the service destroys the credential ciphertext, then deletes the row.
create policy integration_connections_delete on public.integration_connections
  for delete to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.has('integrations.manage'))
  );

--> statement-breakpoint

-- ── tenant guards: the 0047/0054 org-guard pattern ────────────────────────────

create or replace function public.integration_connections_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null then
    raise exception 'integration_connections.org_id must not be null'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.organizations o where o.id = new.org_id) then
    raise exception 'integration_connections.org_id does not reference a valid organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.integration_connections_org_guard() is
  'BEFORE INSERT/UPDATE on integration_connections: org_id must reference a '
  'valid organization. Defense-in-depth behind the FK; raises 42501.';

revoke all on function public.integration_connections_org_guard() from public;

drop trigger if exists integration_connections_org_guard on public.integration_connections;
create trigger integration_connections_org_guard
  before insert or update on public.integration_connections
  for each row execute function public.integration_connections_org_guard();

--> statement-breakpoint

create or replace function public.integration_connections_person_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_org uuid;
begin
  if new.connected_by is null then
    return new;
  end if;
  select p.org_id into v_person_org
  from public.people p
  where p.id = new.connected_by;
  if v_person_org is distinct from new.org_id then
    raise exception 'integration_connections.connected_by must belong to the connection''s organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.integration_connections_person_org_guard() is
  'BEFORE INSERT/UPDATE on integration_connections: connected_by must belong '
  'to the row''s org_id. Closes the cross-org attribution hole; raises 42501.';

revoke all on function public.integration_connections_person_org_guard() from public;

drop trigger if exists integration_connections_person_org_guard on public.integration_connections;
create trigger integration_connections_person_org_guard
  before insert or update on public.integration_connections
  for each row execute function public.integration_connections_person_org_guard();

--> statement-breakpoint

-- ── identity freeze: the 0010/0018 enforce_*_integrity pattern ────────────────

create or replace function public.integration_connections_identity_freeze() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.provider_key is distinct from old.provider_key
     or new.connected_by is distinct from old.connected_by
     or new.created_at is distinct from old.created_at then
    raise exception
      'an integration connection is identified by its org, provider and connector; those columns are immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.integration_connections_identity_freeze() is
  'BEFORE UPDATE on integration_connections: identity columns (id, org_id, '
  'provider_key, connected_by, created_at) are frozen; raises 23514. Status, '
  'config and credential rotation remain mutable through the service.';

revoke all on function public.integration_connections_identity_freeze() from public;

drop trigger if exists integration_connections_identity_freeze on public.integration_connections;
create trigger integration_connections_identity_freeze
  before update on public.integration_connections
  for each row execute function public.integration_connections_identity_freeze();

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 2 — public.integration_webhook_subscriptions
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.integration_webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  url text not null,
  -- Event keys from the §4.5 catalogue.
  events text[] not null default '{}'::text[],
  -- Disabling is active=false (recoverable); deletion is separate (§4.1).
  active boolean not null default true,

  -- §4.3 Tier V vault parts for the per-endpoint signing secret. The secret
  -- itself is generated server-side, shown once, never stored in plaintext.
  signing_secret_ciphertext text,
  signing_secret_nonce text,
  signing_secret_key_version int,

  created_by uuid references public.people (id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

--> statement-breakpoint

create index integration_webhook_subscriptions_org_active_idx
  on public.integration_webhook_subscriptions (org_id, active);

--> statement-breakpoint

create trigger integration_webhook_subscriptions_set_updated_at
  before update on public.integration_webhook_subscriptions
  for each row execute function public.set_updated_at();

--> statement-breakpoint

comment on table public.integration_webhook_subscriptions is
  'Phase 10: outbound webhook subscriptions. Signing secrets are generated '
  'server-side, shown exactly once, and stored only as Tier V ciphertext '
  '(§4.3); handlers resolve them from the vault — never via jobs.payload.';

--> statement-breakpoint

alter table public.integration_webhook_subscriptions enable row level security;
alter table public.integration_webhook_subscriptions force row level security;

create policy integration_webhook_subscriptions_owner_all on public.integration_webhook_subscriptions
  for all to app_owner using (true) with check (true);

--> statement-breakpoint

create policy integration_webhook_subscriptions_select on public.integration_webhook_subscriptions
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.has('integrations.view'))
  );

--> statement-breakpoint

create policy integration_webhook_subscriptions_insert on public.integration_webhook_subscriptions
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.has('integrations.manage'))
    and created_by = (select authz.person_id())
  );

--> statement-breakpoint

create policy integration_webhook_subscriptions_update on public.integration_webhook_subscriptions
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.has('integrations.manage'))
  )
  with check (
    org_id = (select authz.org_id())
    and (select authz.has('integrations.manage'))
  );

--> statement-breakpoint

create policy integration_webhook_subscriptions_delete on public.integration_webhook_subscriptions
  for delete to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.has('integrations.manage'))
  );

--> statement-breakpoint

create or replace function public.integration_webhook_subscriptions_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null then
    raise exception 'integration_webhook_subscriptions.org_id must not be null'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.organizations o where o.id = new.org_id) then
    raise exception 'integration_webhook_subscriptions.org_id does not reference a valid organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.integration_webhook_subscriptions_org_guard() is
  'BEFORE INSERT/UPDATE on integration_webhook_subscriptions: org_id must '
  'reference a valid organization. Defense-in-depth behind the FK; 42501.';

revoke all on function public.integration_webhook_subscriptions_org_guard() from public;

drop trigger if exists integration_webhook_subscriptions_org_guard on public.integration_webhook_subscriptions;
create trigger integration_webhook_subscriptions_org_guard
  before insert or update on public.integration_webhook_subscriptions
  for each row execute function public.integration_webhook_subscriptions_org_guard();

--> statement-breakpoint

create or replace function public.integration_webhook_subscriptions_person_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person_org uuid;
begin
  if new.created_by is null then
    return new;
  end if;
  select p.org_id into v_person_org
  from public.people p
  where p.id = new.created_by;
  if v_person_org is distinct from new.org_id then
    raise exception 'integration_webhook_subscriptions.created_by must belong to the subscription''s organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.integration_webhook_subscriptions_person_org_guard() is
  'BEFORE INSERT/UPDATE on integration_webhook_subscriptions: created_by must '
  'belong to the row''s org_id; raises 42501.';

revoke all on function public.integration_webhook_subscriptions_person_org_guard() from public;

drop trigger if exists integration_webhook_subscriptions_person_org_guard on public.integration_webhook_subscriptions;
create trigger integration_webhook_subscriptions_person_org_guard
  before insert or update on public.integration_webhook_subscriptions
  for each row execute function public.integration_webhook_subscriptions_person_org_guard();

--> statement-breakpoint

create or replace function public.integration_webhook_subscriptions_identity_freeze() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception
      'a webhook subscription is identified by its org and creator; those columns are immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.integration_webhook_subscriptions_identity_freeze() is
  'BEFORE UPDATE on integration_webhook_subscriptions: identity columns (id, '
  'org_id, created_by, created_at) are frozen; raises 23514. URL, events, '
  'active and secret rotation remain mutable through the service.';

revoke all on function public.integration_webhook_subscriptions_identity_freeze() from public;

drop trigger if exists integration_webhook_subscriptions_identity_freeze on public.integration_webhook_subscriptions;
create trigger integration_webhook_subscriptions_identity_freeze
  before update on public.integration_webhook_subscriptions
  for each row execute function public.integration_webhook_subscriptions_identity_freeze();

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 3 — public.integration_webhook_deliveries
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.integration_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  subscription_id uuid not null references public.integration_webhook_subscriptions (id),
  -- Jobs remain the system of record for attempts/retries (§4.1).
  job_id uuid not null references public.jobs (id),
  event_key text not null,

  created_at timestamptz not null default now()
);

--> statement-breakpoint

create index integration_webhook_deliveries_subscription_created_idx
  on public.integration_webhook_deliveries (subscription_id, created_at desc);

--> statement-breakpoint

create index integration_webhook_deliveries_org_created_idx
  on public.integration_webhook_deliveries (org_id, created_at desc);

--> statement-breakpoint

create index integration_webhook_deliveries_job_idx
  on public.integration_webhook_deliveries (job_id);

--> statement-breakpoint

comment on table public.integration_webhook_deliveries is
  'Phase 10: the subscription↔job delivery link, written at enqueue time by '
  'the fan-out service. Append-only; delivery attempts and retries live on '
  'the jobs row it points at.';

--> statement-breakpoint

alter table public.integration_webhook_deliveries enable row level security;
alter table public.integration_webhook_deliveries force row level security;

create policy integration_webhook_deliveries_owner_all on public.integration_webhook_deliveries
  for all to app_owner using (true) with check (true);

--> statement-breakpoint

create policy integration_webhook_deliveries_select on public.integration_webhook_deliveries
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.has('integrations.view'))
  );

--> statement-breakpoint

-- Written by the fan-out service inside whatever authorized request raised
-- the domain event — that actor holds no integrations permission, so the
-- check is tenant-only (the notifications system-write precedent). Tenancy
-- is still enforced three ways: this check, the FKs, and the parent guard.
create policy integration_webhook_deliveries_insert on public.integration_webhook_deliveries
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
  );

--> statement-breakpoint

-- No UPDATE or DELETE policy for app_user: link rows are append-only from
-- the runtime role; purges run through a cleanup job as the owner.

create or replace function public.integration_webhook_deliveries_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null then
    raise exception 'integration_webhook_deliveries.org_id must not be null'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.organizations o where o.id = new.org_id) then
    raise exception 'integration_webhook_deliveries.org_id does not reference a valid organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.integration_webhook_deliveries_org_guard() is
  'BEFORE INSERT/UPDATE on integration_webhook_deliveries: org_id must '
  'reference a valid organization. Defense-in-depth behind the FK; 42501.';

revoke all on function public.integration_webhook_deliveries_org_guard() from public;

drop trigger if exists integration_webhook_deliveries_org_guard on public.integration_webhook_deliveries;
create trigger integration_webhook_deliveries_org_guard
  before insert or update on public.integration_webhook_deliveries
  for each row execute function public.integration_webhook_deliveries_org_guard();

--> statement-breakpoint

create or replace function public.integration_webhook_deliveries_parent_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subscription_org uuid;
  v_job_org uuid;
begin
  select s.org_id into v_subscription_org
  from public.integration_webhook_subscriptions s
  where s.id = new.subscription_id;
  if v_subscription_org is distinct from new.org_id then
    raise exception 'integration_webhook_deliveries.subscription_id must belong to the delivery''s organization'
      using errcode = '42501';
  end if;
  select j.org_id into v_job_org
  from public.jobs j
  where j.id = new.job_id;
  if v_job_org is distinct from new.org_id then
    raise exception 'integration_webhook_deliveries.job_id must belong to the delivery''s organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.integration_webhook_deliveries_parent_org_guard() is
  'BEFORE INSERT/UPDATE on integration_webhook_deliveries: the subscription '
  'and the job must both belong to the row''s org_id; raises 42501.';

revoke all on function public.integration_webhook_deliveries_parent_org_guard() from public;

drop trigger if exists integration_webhook_deliveries_parent_org_guard on public.integration_webhook_deliveries;
create trigger integration_webhook_deliveries_parent_org_guard
  before insert or update on public.integration_webhook_deliveries
  for each row execute function public.integration_webhook_deliveries_parent_org_guard();

--> statement-breakpoint

create or replace function public.integration_webhook_deliveries_identity_freeze() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.subscription_id is distinct from old.subscription_id
     or new.job_id is distinct from old.job_id
     or new.event_key is distinct from old.event_key
     or new.created_at is distinct from old.created_at then
    raise exception
      'a webhook delivery link is written once at enqueue time; every column is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.integration_webhook_deliveries_identity_freeze() is
  'BEFORE UPDATE on integration_webhook_deliveries: the row is append-only — '
  'all columns are frozen; raises 23514.';

revoke all on function public.integration_webhook_deliveries_identity_freeze() from public;

drop trigger if exists integration_webhook_deliveries_identity_freeze on public.integration_webhook_deliveries;
create trigger integration_webhook_deliveries_identity_freeze
  before update on public.integration_webhook_deliveries
  for each row execute function public.integration_webhook_deliveries_identity_freeze();

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 4 — public.integration_inbound_events
-- ═════════════════════════════════════════════════════════════════════════════════

create table public.integration_inbound_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  -- Nullable until resolved (§4.1): the endpoint resolves to a connection,
  -- but a rejected receipt may be recorded before/without one. Org is NEVER
  -- taken from the payload (§4.5) — it comes from the endpoint resolution.
  connection_id uuid references public.integration_connections (id),
  provider_key text not null,
  -- SHA-256 hash of the unguessable per-connection URL token; never the
  -- token itself (the invitations precedent, §2.4).
  endpoint_key text not null,
  external_event_id text,
  -- SHA-256 of the raw body. The body itself is NOT stored in V1.
  payload_hash text not null,

  status text not null default 'RECEIVED'
    constraint integration_inbound_events_status_check check (status in (
      'RECEIVED', 'PROCESSED', 'REJECTED_SIGNATURE',
      'REJECTED_VALIDATION', 'DUPLICATE', 'FAILED'
    )),

  received_at timestamptz not null default now(),
  processed_at timestamptz
);

--> statement-breakpoint

-- Idempotency (§4.5): one row per (connection, external event id); providers
-- without event ids fall back to the payload-hash window check in the
-- service, backed by the index below.
create unique index integration_inbound_events_connection_external_unique
  on public.integration_inbound_events (connection_id, external_event_id)
  where external_event_id is not null;

--> statement-breakpoint

-- Endpoint resolution happens before any org context exists: lookup by hash.
create index integration_inbound_events_endpoint_idx
  on public.integration_inbound_events (endpoint_key);

--> statement-breakpoint

create index integration_inbound_events_org_received_idx
  on public.integration_inbound_events (org_id, received_at desc);

--> statement-breakpoint

create index integration_inbound_events_connection_payload_idx
  on public.integration_inbound_events (connection_id, payload_hash, received_at desc);

--> statement-breakpoint

comment on table public.integration_inbound_events is
  'Phase 10: inbound webhook receipts. Metadata + payload hash only — the '
  'raw body is never stored in V1. Org is resolved from the hashed endpoint '
  'key alone; duplicates are recorded as DUPLICATE, never reprocessed.';

--> statement-breakpoint

alter table public.integration_inbound_events enable row level security;
alter table public.integration_inbound_events force row level security;

create policy integration_inbound_events_owner_all on public.integration_inbound_events
  for all to app_owner using (true) with check (true);

--> statement-breakpoint

create policy integration_inbound_events_select on public.integration_inbound_events
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.has('integrations.view'))
  );

--> statement-breakpoint

-- The inbound handler writes inside the org context resolved from the
-- endpoint key, with no person identity (pre-auth route, §4.4) — so the
-- write checks are tenant-only, exactly like the deliveries fan-out write.
create policy integration_inbound_events_insert on public.integration_inbound_events
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
  );

--> statement-breakpoint

-- Status transitions (RECEIVED → PROCESSED / DUPLICATE / FAILED) run in the
-- same resolved org context; the identity freeze trigger bounds what may
-- change to status + processed_at.
create policy integration_inbound_events_update on public.integration_inbound_events
  for update to app_user
  using (
    org_id = (select authz.org_id())
  )
  with check (
    org_id = (select authz.org_id())
  );

--> statement-breakpoint

-- No DELETE policy for app_user: receipts are the audit trail of the
-- inbound surface; retention purges run as the owner.

create or replace function public.integration_inbound_events_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null then
    raise exception 'integration_inbound_events.org_id must not be null'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.organizations o where o.id = new.org_id) then
    raise exception 'integration_inbound_events.org_id does not reference a valid organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.integration_inbound_events_org_guard() is
  'BEFORE INSERT/UPDATE on integration_inbound_events: org_id must reference '
  'a valid organization. Defense-in-depth behind the FK; raises 42501.';

revoke all on function public.integration_inbound_events_org_guard() from public;

drop trigger if exists integration_inbound_events_org_guard on public.integration_inbound_events;
create trigger integration_inbound_events_org_guard
  before insert or update on public.integration_inbound_events
  for each row execute function public.integration_inbound_events_org_guard();

--> statement-breakpoint

create or replace function public.integration_inbound_events_parent_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection_org uuid;
begin
  if new.connection_id is null then
    return new;
  end if;
  select c.org_id into v_connection_org
  from public.integration_connections c
  where c.id = new.connection_id;
  if v_connection_org is distinct from new.org_id then
    raise exception 'integration_inbound_events.connection_id must belong to the event''s organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.integration_inbound_events_parent_org_guard() is
  'BEFORE INSERT/UPDATE on integration_inbound_events: a resolved connection '
  'must belong to the row''s org_id; raises 42501.';

revoke all on function public.integration_inbound_events_parent_org_guard() from public;

drop trigger if exists integration_inbound_events_parent_org_guard on public.integration_inbound_events;
create trigger integration_inbound_events_parent_org_guard
  before insert or update on public.integration_inbound_events
  for each row execute function public.integration_inbound_events_parent_org_guard();

--> statement-breakpoint

create or replace function public.integration_inbound_events_identity_freeze() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.connection_id is distinct from old.connection_id
     or new.provider_key is distinct from old.provider_key
     or new.endpoint_key is distinct from old.endpoint_key
     or new.external_event_id is distinct from old.external_event_id
     or new.payload_hash is distinct from old.payload_hash
     or new.received_at is distinct from old.received_at then
    raise exception
      'an inbound event receipt is written once; only its status and processed_at may change'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.integration_inbound_events_identity_freeze() is
  'BEFORE UPDATE on integration_inbound_events: identity columns (id, '
  'org_id, connection_id, provider_key, endpoint_key, external_event_id, '
  'payload_hash, received_at) are frozen; raises 23514.';

revoke all on function public.integration_inbound_events_identity_freeze() from public;

drop trigger if exists integration_inbound_events_identity_freeze on public.integration_inbound_events;
create trigger integration_inbound_events_identity_freeze
  before update on public.integration_inbound_events
  for each row execute function public.integration_inbound_events_identity_freeze();

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 5 — public.integration_sync_checkpoints
-- ═════════════════════════════════════════════════════════════════════════════════
--
-- Schema only in V1 (§4.1/§4.6): no service writes this table yet. The
-- policies below exist so the table is never the unprotected one when the
-- first sync provider lands; they mirror the connections surface.

create table public.integration_sync_checkpoints (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  connection_id uuid not null references public.integration_connections (id),
  resource text not null,
  -- Opaque provider cursor; meaning is the future engine's, never parsed here.
  cursor text,
  last_synced_at timestamptz,
  -- No CHECK: §4.1 enumerates no status vocabulary for checkpoints, and the
  -- deferred engine owns it. Inventing one now would be contract drift.
  status text not null default 'PENDING',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One checkpoint per (connection, resource) — definitional, not a policy.
  constraint integration_sync_checkpoints_connection_resource_unique
    unique (connection_id, resource)
);

--> statement-breakpoint

create index integration_sync_checkpoints_org_connection_idx
  on public.integration_sync_checkpoints (org_id, connection_id);

--> statement-breakpoint

create trigger integration_sync_checkpoints_set_updated_at
  before update on public.integration_sync_checkpoints
  for each row execute function public.set_updated_at();

--> statement-breakpoint

comment on table public.integration_sync_checkpoints is
  'Phase 10: per-connection sync checkpoints. SCHEMA ONLY in V1 — the sync '
  'engine is deferred (§4.6); no service writes this table yet.';

--> statement-breakpoint

alter table public.integration_sync_checkpoints enable row level security;
alter table public.integration_sync_checkpoints force row level security;

create policy integration_sync_checkpoints_owner_all on public.integration_sync_checkpoints
  for all to app_owner using (true) with check (true);

--> statement-breakpoint

create policy integration_sync_checkpoints_select on public.integration_sync_checkpoints
  for select to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.has('integrations.view'))
  );

--> statement-breakpoint

create policy integration_sync_checkpoints_insert on public.integration_sync_checkpoints
  for insert to app_user
  with check (
    org_id = (select authz.org_id())
    and (select authz.has('integrations.manage'))
  );

--> statement-breakpoint

create policy integration_sync_checkpoints_update on public.integration_sync_checkpoints
  for update to app_user
  using (
    org_id = (select authz.org_id())
    and (select authz.has('integrations.manage'))
  )
  with check (
    org_id = (select authz.org_id())
    and (select authz.has('integrations.manage'))
  );

--> statement-breakpoint

-- No DELETE policy for app_user: checkpoints die with their connection,
-- through the owner.

create or replace function public.integration_sync_checkpoints_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is null then
    raise exception 'integration_sync_checkpoints.org_id must not be null'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.organizations o where o.id = new.org_id) then
    raise exception 'integration_sync_checkpoints.org_id does not reference a valid organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.integration_sync_checkpoints_org_guard() is
  'BEFORE INSERT/UPDATE on integration_sync_checkpoints: org_id must '
  'reference a valid organization. Defense-in-depth behind the FK; 42501.';

revoke all on function public.integration_sync_checkpoints_org_guard() from public;

drop trigger if exists integration_sync_checkpoints_org_guard on public.integration_sync_checkpoints;
create trigger integration_sync_checkpoints_org_guard
  before insert or update on public.integration_sync_checkpoints
  for each row execute function public.integration_sync_checkpoints_org_guard();

--> statement-breakpoint

create or replace function public.integration_sync_checkpoints_parent_org_guard() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection_org uuid;
begin
  select c.org_id into v_connection_org
  from public.integration_connections c
  where c.id = new.connection_id;
  if v_connection_org is distinct from new.org_id then
    raise exception 'integration_sync_checkpoints.connection_id must belong to the checkpoint''s organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.integration_sync_checkpoints_parent_org_guard() is
  'BEFORE INSERT/UPDATE on integration_sync_checkpoints: the connection must '
  'belong to the row''s org_id; raises 42501.';

revoke all on function public.integration_sync_checkpoints_parent_org_guard() from public;

drop trigger if exists integration_sync_checkpoints_parent_org_guard on public.integration_sync_checkpoints;
create trigger integration_sync_checkpoints_parent_org_guard
  before insert or update on public.integration_sync_checkpoints
  for each row execute function public.integration_sync_checkpoints_parent_org_guard();

--> statement-breakpoint

create or replace function public.integration_sync_checkpoints_identity_freeze() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.connection_id is distinct from old.connection_id
     or new.resource is distinct from old.resource
     or new.created_at is distinct from old.created_at then
    raise exception
      'a sync checkpoint is identified by its org, connection and resource; those columns are immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.integration_sync_checkpoints_identity_freeze() is
  'BEFORE UPDATE on integration_sync_checkpoints: identity columns (id, '
  'org_id, connection_id, resource, created_at) are frozen; raises 23514. '
  'Cursor, status and last_synced_at are the mutable engine state.';

revoke all on function public.integration_sync_checkpoints_identity_freeze() from public;

drop trigger if exists integration_sync_checkpoints_identity_freeze on public.integration_sync_checkpoints;
create trigger integration_sync_checkpoints_identity_freeze
  before update on public.integration_sync_checkpoints
  for each row execute function public.integration_sync_checkpoints_identity_freeze();

--> statement-breakpoint

-- ═════════════════════════════════════════════════════════════════════════════════
-- PART 6 — verification: fail the migration rather than leave a half-built schema
-- ═════════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_problems text;
begin
  select string_agg(p, '; ') into v_problems
  from (values
    -- ── integration_connections ──────────────────────────────────────────────
    ('integration_connections table missing',
      exists (select 1 from pg_tables
              where schemaname = 'public' and tablename = 'integration_connections')),
    ('integration_connections RLS not forced',
      coalesce((select relrowsecurity and relforcerowsecurity from pg_class
                where relname = 'integration_connections'), false)),
    ('integration_connections column set drifted from the contract',
      coalesce((select string_agg(column_name, ',' order by column_name)
                from information_schema.columns
                where table_schema = 'public' and table_name = 'integration_connections'), '')
        = 'config,connected_by,created_at,credential_ciphertext,credential_key_version,credential_nonce,credential_ref,display_name,id,last_error_code,last_health_at,org_id,provider_key,status,updated_at'),
    ('integration_connections credential/content column present (§4.3 violation)',
      not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'integration_connections'
                    and column_name in ('secret', 'password', 'api_key', 'access_token',
                                        'refresh_token', 'prompt', 'response', 'content'))),
    ('integration_connections status check missing',
      exists (select 1 from pg_constraint where conname = 'integration_connections_status_check')),
    ('integration_connections_org_provider_idx missing',
      exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'integration_connections_org_provider_idx')),
    ('integration_connections_org_status_idx missing',
      exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'integration_connections_org_status_idx')),
    ('integration_connections_select policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'integration_connections'
                and policyname = 'integration_connections_select')),
    ('integration_connections_insert policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'integration_connections'
                and policyname = 'integration_connections_insert')),
    ('integration_connections_update policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'integration_connections'
                and policyname = 'integration_connections_update')),
    ('integration_connections_delete policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'integration_connections'
                and policyname = 'integration_connections_delete')),
    ('integration_connections guard triggers missing',
      exists (select 1 from pg_trigger where tgname = 'integration_connections_org_guard')
      and exists (select 1 from pg_trigger where tgname = 'integration_connections_person_org_guard')),
    ('integration_connections identity freeze missing',
      exists (select 1 from pg_trigger where tgname = 'integration_connections_identity_freeze')),
    -- ── integration_webhook_subscriptions ────────────────────────────────────
    ('integration_webhook_subscriptions table missing',
      exists (select 1 from pg_tables
              where schemaname = 'public' and tablename = 'integration_webhook_subscriptions')),
    ('integration_webhook_subscriptions RLS not forced',
      coalesce((select relrowsecurity and relforcerowsecurity from pg_class
                where relname = 'integration_webhook_subscriptions'), false)),
    ('integration_webhook_subscriptions column set drifted from the contract',
      coalesce((select string_agg(column_name, ',' order by column_name)
                from information_schema.columns
                where table_schema = 'public' and table_name = 'integration_webhook_subscriptions'), '')
        = 'active,created_at,created_by,events,id,org_id,signing_secret_ciphertext,signing_secret_key_version,signing_secret_nonce,updated_at,url'),
    ('integration_webhook_subscriptions plaintext secret column present (§4.3 violation)',
      not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'integration_webhook_subscriptions'
                    and column_name in ('signing_secret', 'secret', 'password', 'api_key'))),
    ('integration_webhook_subscriptions_org_active_idx missing',
      exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'integration_webhook_subscriptions_org_active_idx')),
    ('integration_webhook_subscriptions_select policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'integration_webhook_subscriptions'
                and policyname = 'integration_webhook_subscriptions_select')),
    ('integration_webhook_subscriptions_insert policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'integration_webhook_subscriptions'
                and policyname = 'integration_webhook_subscriptions_insert')),
    ('integration_webhook_subscriptions_update policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'integration_webhook_subscriptions'
                and policyname = 'integration_webhook_subscriptions_update')),
    ('integration_webhook_subscriptions_delete policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'integration_webhook_subscriptions'
                and policyname = 'integration_webhook_subscriptions_delete')),
    ('integration_webhook_subscriptions guard triggers missing',
      exists (select 1 from pg_trigger where tgname = 'integration_webhook_subscriptions_org_guard')
      and exists (select 1 from pg_trigger where tgname = 'integration_webhook_subscriptions_person_org_guard')),
    ('integration_webhook_subscriptions identity freeze missing',
      exists (select 1 from pg_trigger where tgname = 'integration_webhook_subscriptions_identity_freeze')),
    -- ── integration_webhook_deliveries ───────────────────────────────────────
    ('integration_webhook_deliveries table missing',
      exists (select 1 from pg_tables
              where schemaname = 'public' and tablename = 'integration_webhook_deliveries')),
    ('integration_webhook_deliveries RLS not forced',
      coalesce((select relrowsecurity and relforcerowsecurity from pg_class
                where relname = 'integration_webhook_deliveries'), false)),
    ('integration_webhook_deliveries column set drifted from the contract',
      coalesce((select string_agg(column_name, ',' order by column_name)
                from information_schema.columns
                where table_schema = 'public' and table_name = 'integration_webhook_deliveries'), '')
        = 'created_at,event_key,id,job_id,org_id,subscription_id'),
    ('integration_webhook_deliveries_subscription_created_idx missing',
      exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'integration_webhook_deliveries_subscription_created_idx')),
    ('integration_webhook_deliveries_org_created_idx missing',
      exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'integration_webhook_deliveries_org_created_idx')),
    ('integration_webhook_deliveries_job_idx missing',
      exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'integration_webhook_deliveries_job_idx')),
    ('integration_webhook_deliveries_select policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'integration_webhook_deliveries'
                and policyname = 'integration_webhook_deliveries_select')),
    ('integration_webhook_deliveries_insert policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'integration_webhook_deliveries'
                and policyname = 'integration_webhook_deliveries_insert')),
    ('integration_webhook_deliveries must have no app_user update/delete policy',
      not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'integration_webhook_deliveries'
                    and 'app_user' = any (roles) and cmd in ('UPDATE', 'DELETE'))),
    ('integration_webhook_deliveries guard triggers missing',
      exists (select 1 from pg_trigger where tgname = 'integration_webhook_deliveries_org_guard')
      and exists (select 1 from pg_trigger where tgname = 'integration_webhook_deliveries_parent_org_guard')),
    ('integration_webhook_deliveries identity freeze missing',
      exists (select 1 from pg_trigger where tgname = 'integration_webhook_deliveries_identity_freeze')),
    -- ── integration_inbound_events ───────────────────────────────────────────
    ('integration_inbound_events table missing',
      exists (select 1 from pg_tables
              where schemaname = 'public' and tablename = 'integration_inbound_events')),
    ('integration_inbound_events RLS not forced',
      coalesce((select relrowsecurity and relforcerowsecurity from pg_class
                where relname = 'integration_inbound_events'), false)),
    ('integration_inbound_events column set drifted from the contract',
      coalesce((select string_agg(column_name, ',' order by column_name)
                from information_schema.columns
                where table_schema = 'public' and table_name = 'integration_inbound_events'), '')
        = 'connection_id,endpoint_key,external_event_id,id,org_id,payload_hash,processed_at,provider_key,received_at,status'),
    ('integration_inbound_events raw body column present (V1 stores hashes only)',
      not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'integration_inbound_events'
                    and column_name in ('payload', 'body', 'raw_body', 'content'))),
    ('integration_inbound_events status check missing',
      exists (select 1 from pg_constraint where conname = 'integration_inbound_events_status_check')),
    ('integration_inbound_events partial unique index missing',
      exists (select 1 from pg_indexes
              where schemaname = 'public'
                and indexname = 'integration_inbound_events_connection_external_unique')),
    ('integration_inbound_events partial unique index lost its predicate',
      coalesce((select indexdef from pg_indexes
                where schemaname = 'public'
                  and indexname = 'integration_inbound_events_connection_external_unique'), '')
        ilike '%where%external_event_id is not null%'),
    ('integration_inbound_events_endpoint_idx missing',
      exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'integration_inbound_events_endpoint_idx')),
    ('integration_inbound_events_org_received_idx missing',
      exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'integration_inbound_events_org_received_idx')),
    ('integration_inbound_events_connection_payload_idx missing',
      exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'integration_inbound_events_connection_payload_idx')),
    ('integration_inbound_events_select policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'integration_inbound_events'
                and policyname = 'integration_inbound_events_select')),
    ('integration_inbound_events_insert policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'integration_inbound_events'
                and policyname = 'integration_inbound_events_insert')),
    ('integration_inbound_events_update policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'integration_inbound_events'
                and policyname = 'integration_inbound_events_update')),
    ('integration_inbound_events guard triggers missing',
      exists (select 1 from pg_trigger where tgname = 'integration_inbound_events_org_guard')
      and exists (select 1 from pg_trigger where tgname = 'integration_inbound_events_parent_org_guard')),
    ('integration_inbound_events identity freeze missing',
      exists (select 1 from pg_trigger where tgname = 'integration_inbound_events_identity_freeze')),
    -- ── integration_sync_checkpoints ─────────────────────────────────────────
    ('integration_sync_checkpoints table missing',
      exists (select 1 from pg_tables
              where schemaname = 'public' and tablename = 'integration_sync_checkpoints')),
    ('integration_sync_checkpoints RLS not forced',
      coalesce((select relrowsecurity and relforcerowsecurity from pg_class
                where relname = 'integration_sync_checkpoints'), false)),
    ('integration_sync_checkpoints column set drifted from the contract',
      coalesce((select string_agg(column_name, ',' order by column_name)
                from information_schema.columns
                where table_schema = 'public' and table_name = 'integration_sync_checkpoints'), '')
        = 'connection_id,created_at,cursor,id,last_synced_at,org_id,resource,status,updated_at'),
    ('integration_sync_checkpoints unique (connection_id, resource) missing',
      exists (select 1 from pg_constraint
              where conname = 'integration_sync_checkpoints_connection_resource_unique')),
    ('integration_sync_checkpoints_org_connection_idx missing',
      exists (select 1 from pg_indexes
              where schemaname = 'public' and indexname = 'integration_sync_checkpoints_org_connection_idx')),
    ('integration_sync_checkpoints_select policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'integration_sync_checkpoints'
                and policyname = 'integration_sync_checkpoints_select')),
    ('integration_sync_checkpoints_insert policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'integration_sync_checkpoints'
                and policyname = 'integration_sync_checkpoints_insert')),
    ('integration_sync_checkpoints_update policy missing',
      exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'integration_sync_checkpoints'
                and policyname = 'integration_sync_checkpoints_update')),
    ('integration_sync_checkpoints guard triggers missing',
      exists (select 1 from pg_trigger where tgname = 'integration_sync_checkpoints_org_guard')
      and exists (select 1 from pg_trigger where tgname = 'integration_sync_checkpoints_parent_org_guard')),
    ('integration_sync_checkpoints identity freeze missing',
      exists (select 1 from pg_trigger where tgname = 'integration_sync_checkpoints_identity_freeze'))
  ) as checks(p, ok)
  where not ok;

  if v_problems is not null then
    raise exception 'integrations schema migration verification failed: %', v_problems;
  end if;
end;
$$;
