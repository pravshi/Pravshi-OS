-- PRAVSHI OS — RLS proof, part 2 of 3 (assertions). Run as app_user.
-- Every assertion raises on failure. Silence means the guarantee holds.
--
-- TRANSACTION CONTRACT — read this before changing how the runner executes this file.
-- `set_config(name, value, true)` is transaction-local, not block-local: a DO block does
-- not open a transaction, it runs in whatever transaction the caller already has. So this
-- file manages its own transaction boundaries explicitly, and depends on two things:
--   (a) the caller must NOT wrap this file in its own begin/commit. The `begin;`/`commit;`
--       below must open and close a transaction of their own; if they merely join a
--       caller's transaction, assertion 4 stops testing what it claims to test.
--   (b) statements must be executed in file order, on one connection, and the run must
--       stop at the first exception.
-- Assertion 3 sets an identity inside an explicit transaction and commits it; assertion 4
-- then proves, from a later transaction, that the identity did not survive that commit.
-- That release-at-transaction-end property is the whole reason session-scoped `SET` is
-- banned project-wide: a pooled connection must not carry one person's identity into the
-- next person's query. It is proven here, not assumed.

-- 1. This file is running on a connection authenticated as app_user — not merely one that
--    has reached app_user via SET ROLE. A privileged connection that did `set role app_user`
--    passes every assertion below while the connection itself remains privileged, which is
--    exactly the "passes for the wrong reason" case this proof exists to rule out.
do $$
begin
  if current_user <> 'app_user' or session_user <> 'app_user' then
    raise exception 'FAIL: prove-rls-assert.sql must be run on a connection authenticated as app_user (current_user=%, session_user=%).', current_user, session_user;
  end if;
end $$;

-- 2. No identity set -> zero rows. This is fail-closed: a query issued outside
--    withAuthorizedDb() carries no identity, and must see nothing rather than everything.
--    The precondition is asserted first: "zero rows visible" only proves fail-closed
--    behaviour if no identity is set at this point. A leftover GUC on a pooled connection,
--    an `alter role ... set app.person_id`, or a runner that sets it before executing would
--    otherwise make this pass while testing nothing.
do $$
declare n integer;
begin
  if current_setting('app.person_id', true) is not null
     and current_setting('app.person_id', true) <> '' then
    raise exception 'FAIL: app.person_id is already set (%) — assertion 2 cannot test fail-closed behaviour from this state.', current_setting('app.person_id', true);
  end if;
  select count(*) into n from public._rls_probe;
  if n <> 0 then
    raise exception
      'FAIL: % row(s) visible with no identity set. app_user is bypassing RLS — check that it is not the table owner and does not hold BYPASSRLS.', n;
  end if;
end $$;

-- 3. Identity set inside a transaction -> exactly that person's row.
--    The explicit begin/commit is load-bearing: it gives assertion 4 a transaction boundary
--    to observe. Do not collapse it into a bare DO block.
begin;

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

commit;

-- 4. The identity did not survive the commit. This runs in a new transaction, after the
--    one that set app.person_id ended. Row count is the primary assertion: a released GUC
--    may read back as '' rather than NULL, so both are treated as "no identity" when the
--    setting itself is inspected. If this fails, a pooled connection is carrying one
--    person's identity into the next person's query.
do $$
declare n integer; leftover text;
begin
  leftover := current_setting('app.person_id', true);
  select count(*) into n from public._rls_probe;
  if n <> 0 then
    raise exception
      'FAIL: % row(s) visible after the transaction that set app.person_id committed (app.person_id now reads as %). A transaction-local identity must not survive its transaction — check that nothing here used session-scoped SET, and that the runner is not wrapping this file in an outer transaction.',
      n, coalesce(quote_literal(leftover), 'NULL');
  end if;
  if leftover is not null and leftover <> '' then
    raise exception
      'FAIL: app.person_id still reads as % after its transaction committed. It was set session-wide rather than transaction-locally, and this connection would leak that identity to the next person who borrows it from the pool.', leftover;
  end if;
end $$;

-- 5. The connecting role itself cannot bypass RLS.
do $$
declare bypasses boolean; is_super boolean;
begin
  select rolbypassrls, rolsuper into bypasses, is_super
  from pg_roles where rolname = current_user;
  if not found or bypasses is null or is_super is null then
    raise exception 'FAIL: could not read the BYPASSRLS/SUPERUSER attributes of role % from pg_roles. This assertion proves nothing unless it reads a row; it must not pass by default.', current_user;
  end if;
  if bypasses then
    raise exception 'FAIL: role % holds BYPASSRLS. Every policy in the system is inert.', current_user;
  end if;
  if is_super then
    raise exception 'FAIL: role % is a superuser. Superusers bypass RLS unconditionally.', current_user;
  end if;
end $$;

-- 6. The connecting role neither owns, nor holds membership in the owner of, any relation.
--    Postgres's ownership test is has_privs_of_role() — membership with inheritance, not name
--    equality — so `grant app_owner to app_user` would make app_user the effective owner of
--    every app_owner table and bypass RLS on any table not marked FORCE. pg_has_role(...,
--    'USAGE') is the same test Postgres itself applies. relkind covers ordinary ('r'),
--    partitioned ('p'), materialized-view ('m') and foreign ('f') relations; the system
--    schemas are excluded because their contents are never the application's to own.
do $$
declare n integer;
begin
  select count(*) into n
  from pg_class c
  where pg_has_role(current_user, c.relowner, 'USAGE')
    and c.relkind in ('r', 'p', 'm', 'f')
    and c.relnamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace);
  if n <> 0 then
    raise exception 'FAIL: role % owns, or holds membership in the owner of, % relation(s). RLS is not enforced against a relation''s owner unless it is FORCE''d, and ownership follows role membership: a `grant app_owner to app_user` is the likeliest cause. The application must never connect as, or inherit the privileges of, an owner.', current_user, n;
  end if;
end $$;
