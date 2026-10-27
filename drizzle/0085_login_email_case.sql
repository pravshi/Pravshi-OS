-- ═════════════════════════════════════════════════════════════════════════════
-- 0085_login_email_case — one login address, one identity, whatever the case (LOCK-1)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT. Inside a SECURITY DEFINER function whose search_path is empty, citext's
-- case-insensitive "=" (schema public) is not visible, and "citext_column = text" silently
-- compares as text, case-sensitively. The sign-in lockout (0027: check_login_lockout,
-- record_login_failure, clear_login_lockout) and the password-reset request (0024) look a login
-- up by "u.email = lower(p_email)". Logins created by invitation acceptance (0019/0031) and by
-- the bootstrap setup (0015) stored the address as typed. So a login stored as
-- "Asha.Rao@Example.test" never matched: its failed sign-ins were not recorded, it was never
-- locked out, and a reset request for it found nothing. Reproduced end to end before this
-- migration (tests/integration/login-email-case.test.ts: five failures, zero recorded).
--
-- THE FIX. The login address is stored lower-cased, always:
--   PART 1  refuse if two logins differ only in case (cannot happen today: the address is
--           citext UNIQUE, which is case-insensitive — asserted, never merged)
--   PART 2  normalise every existing login address to lower case (an UPDATE of the address only;
--           the login, its sessions, factors, lockout row and person stay as they are)
--   PART 3  a trigger lower-cases the address on every INSERT and UPDATE, whoever writes it
--           (Better Auth, invitation acceptance, bootstrap, platform setup)
--   PART 4  a CHECK that every stored address is lower-case
--   PART 5  the pre-authentication organization lookup compares case-insensitively
--   PART 6  verification
-- With every stored address lower-case, the existing "u.email = lower(p_email)" lookups are
-- exact for any spelling the user types: the lockout, the reset request and the bootstrap and
-- invitation duplicate checks need no change. The lockout ledger is keyed by login id, so one
-- login has one counter. Rate limits are keyed by client IP and route (src/lib/auth/rate-limit.ts,
-- Better Auth's customRules), never by email, so they are unaffected.
--
-- Not changed: people.work_email, invitations.email and platform.admins.email keep the case
-- people typed (they are display data, compared with citext or explicitly). Rollback restores
-- the old function and drops the trigger and CHECK; the original case of an address is not kept
-- (citext treats the spellings as equal, so nothing depends on it).
-- ═════════════════════════════════════════════════════════════════════════════

-- PART 1 — no two logins may differ only in case.
do $$
declare
  v_groups integer;
begin
  select count(*) into v_groups
  from (select 1 from auth.auth_users u group by lower(u.email::text) having count(*) > 1) g;
  if v_groups > 0 then
    raise exception '0085: % login address(es) exist in more than one case; resolve them by hand (never merged automatically)', v_groups;
  end if;
end;
$$;

-- PART 2 — normalise existing addresses.
do $$
declare
  v_changed integer;
begin
  update auth.auth_users u
  set email = lower(u.email::text)::public.citext
  where u.email::text <> lower(u.email::text);
  get diagnostics v_changed = row_count;
  raise notice '0085: % login address(es) lower-cased', v_changed;
end;
$$;

-- PART 3 — every writer stores the lower-case address.
create function auth.normalize_login_email() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email := lower(new.email::text)::public.citext;
  return new;
end;
$$;

comment on function auth.normalize_login_email() is
  'BEFORE INSERT/UPDATE OF email on auth.auth_users (0085, LOCK-1): the login address is stored '
  'lower-cased, so every lookup by lower(email) finds it whatever the case typed.';

revoke all on function auth.normalize_login_email() from public;

create trigger auth_users_normalize_email
  before insert or update of email on auth.auth_users
  for each row execute function auth.normalize_login_email();

-- PART 4 — and the database says so.
alter table auth.auth_users
  add constraint auth_users_email_lowercase check (email::text = lower(email::text));

-- PART 5 — 0020's function, verbatim except its comparison, which now names citext's operator.
create or replace function public.resolve_login_org(p_email public.citext)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  -- The same address can exist in two orgs only by administrative accident; prefer the
  -- person who actually holds a login, then the oldest row. A login event attributed
  -- to the wrong org is a misfiled security signal, so the preference is explicit.
  select p.org_id
  from public.people p
  where p.work_email operator(public.=) p_email
    and p.deleted_at is null
  order by (p.auth_user_id is null), p.created_at
  limit 1;
$$;

-- PART 6 — verification.
do $$
begin
  if exists (select 1 from auth.auth_users u where u.email::text <> lower(u.email::text)) then
    raise exception '0085: a login address is not lower-case';
  end if;
  if not exists (select 1 from pg_trigger t where t.tgname = 'auth_users_normalize_email'
                   and t.tgrelid = 'auth.auth_users'::regclass) then
    raise exception '0085: the normalising trigger is missing';
  end if;
  if position('operator(public.=)' in pg_get_functiondef('public.resolve_login_org(public.citext)'::regprocedure)) = 0 then
    raise exception '0085: resolve_login_org still compares case-sensitively';
  end if;
  if exists (
    select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.oid = 'auth.normalize_login_email()'::regprocedure and a.grantee = 0
  ) then
    raise exception '0085: auth.normalize_login_email() is executable by PUBLIC';
  end if;
end;
$$;
