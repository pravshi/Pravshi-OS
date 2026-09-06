-- PRAVSHI OS — RLS proof, part 1 of 3 (setup). Run as app_owner. Idempotent.

drop table if exists public._rls_probe;

create table public._rls_probe (
  id              int primary key,
  owner_person_id text not null
);

alter table public._rls_probe enable row level security;

create policy probe_select on public._rls_probe
  for select to app_user
  using (owner_person_id = current_setting('app.person_id', true));

grant select on public._rls_probe to app_user;

-- Seeded BEFORE `force row level security`, and the order is load-bearing. FORCE applies
-- RLS to the table's owner too, and the only policy here is a SELECT policy granted to
-- app_user — so with FORCE already on, app_owner's own seed insert is matched against a
-- non-existent INSERT policy and denied ("new row violates row-level security policy for
-- table \"_rls_probe\"", SQLSTATE 42501). Task 3b hit exactly that on the first real
-- execution of this file. The alternative — adding a permissive INSERT policy for
-- app_owner — would put a second policy on the probe table for no reason the proof needs.
insert into public._rls_probe (id, owner_person_id)
values (1, 'alice'), (2, 'bob');

-- The end state is what the assertions run against: RLS enabled AND forced, one policy,
-- two rows owned by different people.
alter table public._rls_probe force row level security;
