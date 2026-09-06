-- PRAVSHI OS — RLS proof, part 2 of 3 (assertions). Run as app_user.
-- Every assertion raises on failure. Silence means the guarantee holds.

-- 1. No identity set -> zero rows. This is fail-closed: a query issued outside
--    withAuthorizedDb() carries no identity, and must see nothing rather than everything.
do $$
declare n integer;
begin
  select count(*) into n from public._rls_probe;
  if n <> 0 then
    raise exception
      'FAIL: % row(s) visible with no identity set. app_user is bypassing RLS — check that it is not the table owner and does not hold BYPASSRLS.', n;
  end if;
end $$;

-- 2. Identity set inside a transaction -> exactly that person's row.
do $$
declare n integer; who text;
begin
  perform set_config('app.person_id', 'alice', true);
  select count(*) into n from public._rls_probe;
  if n <> 1 then
    raise exception 'FAIL: expected 1 row for alice, got %. The policy is not filtering as intended.', n;
  end if;
  select owner_person_id into who from public._rls_probe;
  if who <> 'alice' then
    raise exception 'FAIL: alice can see %s row instead of her own.', who;
  end if;
end $$;

-- 3. The connecting role itself cannot bypass RLS.
do $$
declare bypasses boolean; is_super boolean;
begin
  select rolbypassrls, rolsuper into bypasses, is_super
  from pg_roles where rolname = current_user;
  if bypasses then
    raise exception 'FAIL: role % holds BYPASSRLS. Every policy in the system is inert.', current_user;
  end if;
  if is_super then
    raise exception 'FAIL: role % is a superuser. Superusers bypass RLS unconditionally.', current_user;
  end if;
end $$;

-- 4. The connecting role owns no tables. An owner escapes RLS unless every table
--    is FORCE'd, and relying on that is one forgotten migration away from a breach.
do $$
declare n integer;
begin
  select count(*) into n
  from pg_class c join pg_roles r on r.oid = c.relowner
  where r.rolname = current_user and c.relkind = 'r';
  if n <> 0 then
    raise exception 'FAIL: role % owns % table(s). The application must never connect as an owner.', current_user, n;
  end if;
end $$;
