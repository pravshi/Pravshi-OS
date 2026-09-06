-- PRAVSHI OS — RLS proof, part 1 of 3 (setup). Run as app_owner. Idempotent.

drop table if exists public._rls_probe;

create table public._rls_probe (
  id              int primary key,
  owner_person_id text not null
);

alter table public._rls_probe enable row level security;
alter table public._rls_probe force  row level security;

create policy probe_select on public._rls_probe
  for select to app_user
  using (owner_person_id = current_setting('app.person_id', true));

grant select on public._rls_probe to app_user;

insert into public._rls_probe (id, owner_person_id)
values (1, 'alice'), (2, 'bob');
