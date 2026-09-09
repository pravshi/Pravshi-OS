-- PRAVSHI OS — Phase 1 Task 1.1: immutable human-readable identity codes.
--
-- Produces codes such as EMP-2026-0001. The mechanism is deliberately generic: the
-- code type is a parameter, not an enum, so INT-, CTR- and any later prefix work
-- without a migration. Nothing here is employee-specific.
--
-- The security shape of this table is unusual and deliberate: NO application role
-- may touch it directly. The only way to obtain a code is authz.next_identity_code(),
-- a SECURITY DEFINER function. A counter that ordinary users can UPDATE is a counter
-- that can be rewound to re-issue an existing code, which would break the immutability
-- guarantee that every later table's `code` column depends on.

create table public.identity_counters (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  code_type text not null,
  period text not null,
  next_value bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint identity_counters_code_type_valid check (code_type ~ '^[A-Z]{2,8}$'),
  constraint identity_counters_period_valid check (period ~ '^[0-9]{4}$'),
  constraint identity_counters_next_value_positive check (next_value >= 1),
  constraint identity_counters_unique unique (org_id, code_type, period)
);

-- org_id has no FK yet: `organizations` arrives in Task 1.2, which adds it. Task 1.1
-- is deliberately independent of every other Phase 1 table.

-- No `deleted_at`. The universal convention allows soft delete "where appropriate", and
-- here it is not: deleting a counter row would restart the sequence and re-issue codes
-- that already identify real records. A counter is append-only by nature.

comment on table public.identity_counters is
  'Per-organization, per-type, per-period sequence for immutable human-readable codes. '
  'Written only by authz.next_identity_code(); no application role holds table privileges.';

alter table public.identity_counters enable row level security;
alter table public.identity_counters force row level security;

-- FORCE ROW LEVEL SECURITY subjects the table OWNER to its own policies, so the
-- SECURITY DEFINER function below — which runs as app_owner — needs an explicit policy
-- or its writes are denied. This is the only policy on the table.
create policy identity_counters_owner_all on public.identity_counters
  for all to app_owner
  using (true)
  with check (true);

-- No policy exists for app_user or app_admin. RLS denies by default, so even if a grant
-- were reintroduced by accident, a direct query still returns zero rows and a direct
-- write is still refused. Two independent barriers, on purpose.

-- scripts/db/roles.sql sets DEFAULT PRIVILEGES granting select/insert/update on every
-- new table in `public` to app_user. That default is right for business tables and wrong
-- for this one, so it is revoked explicitly. Without this line the table would be
-- app_user-writable the moment it was created.
revoke all on public.identity_counters from app_user, app_admin;

-- ── the only way to obtain a code ────────────────────────────────────────────────
--
-- Atomic by construction. The INSERT ... ON CONFLICT DO UPDATE is a single statement:
-- concurrent callers serialise on the conflicting row's lock, so two transactions
-- cannot read the same value. There is no read-then-write window to race.
--
--   insert path: stores next_value = 2 and returns 1 (the value just consumed)
--   update path: stores old + 1     and returns old
--
-- Both return `next_value - 1` from the post-write row, which is the consumed value.
create function authz.next_identity_code(
  p_org_id uuid,
  p_code_type text,
  p_period text
) returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_seq bigint;
begin
  -- Fail closed on every input. Error messages name the parameter but never echo the
  -- value: it is caller-supplied and may be hostile or sensitive, and an exception
  -- string propagates into logs.
  if p_org_id is null then
    raise exception 'next_identity_code: org_id is required' using errcode = '22023';
  end if;
  if p_code_type is null or p_code_type !~ '^[A-Z]{2,8}$' then
    raise exception 'next_identity_code: code_type must be 2-8 uppercase letters'
      using errcode = '22023';
  end if;
  if p_period is null or p_period !~ '^[0-9]{4}$' then
    raise exception 'next_identity_code: period must be a four-digit year'
      using errcode = '22023';
  end if;

  insert into public.identity_counters as ic (org_id, code_type, period, next_value)
  values (p_org_id, p_code_type, p_period, 2)
  on conflict (org_id, code_type, period)
  do update set next_value = ic.next_value + 1, updated_at = now()
  returning ic.next_value - 1 into v_seq;

  -- Zero-padded to four digits, and simply longer past 9999 rather than wrapping.
  return p_code_type || '-' || p_period || '-' || lpad(v_seq::text, 4, '0');
end;
$$;

comment on function authz.next_identity_code(uuid, text, text) is
  'Allocates the next immutable identity code for (org, type, period). Atomic under '
  'concurrency. The only permitted writer of public.identity_counters.';

-- EXECUTE is not granted to PUBLIC. Only the application roles may call it, and calling
-- it is the entire extent of their access to the counter.
revoke all on function authz.next_identity_code(uuid, text, text) from public;
grant execute on function authz.next_identity_code(uuid, text, text) to app_user, app_admin;
