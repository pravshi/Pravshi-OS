# Database roles and the RLS proof

This directory holds the SQL that establishes PRAVSHI OS's database roles and proves, against a
real Postgres server, that the application cannot bypass Row Level Security (RLS).

Postgres does not enforce RLS against a table's owner, or against any role holding `BYPASSRLS`. An
application connected as either one has policies that look correct, review as correct, and do
nothing at all — silently, until someone relies on them. Everything else in this system's
authorization model assumes that failure cannot happen here. These files are how that assumption
gets proven instead of assumed.

Authoring these files was Task 3a. Task 3b applied them to a real Neon branch (PostgreSQL 18.6,
Singapore) and ran the proof; everything below the "What `roles.sql` needs permission to do"
heading has since been corrected against what that branch actually did, rather than what the SQL
was expected to do. Rows that changed are called out inline.

## The files, and who must run each one

Running any of these as the wrong role makes the proof pass for the wrong reason, so read this
table before running anything.

| File                     | Run as                                                            | What it does                                                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roles.sql`              | branch owner (the role Neon gives you when the branch is created) | Creates `app_owner`, `app_user`, `app_admin`; asserts none of them holds `BYPASSRLS` or `SUPERUSER`; creates the `authz` schema; **reassigns ownership of the `public` schema to `app_owner`**; sets up base grants and default privileges. |
| `prove-rls-setup.sql`    | `app_owner`                                                       | Creates a throwaway probe table with RLS enabled _and forced_, one policy, and two rows owned by different people. The rows are seeded **before** `FORCE` is switched on, and the order is load-bearing — see the comment in the file.      |
| `prove-rls-assert.sql`   | `app_user`                                                        | Runs six assertions against the probe table and the catalog. This is the file that proves the guarantee.                                                                                                                                    |
| `prove-rls-teardown.sql` | `app_owner`                                                       | Drops the probe table.                                                                                                                                                                                                                      |

The probe table is named `public._rls_probe`, with a leading underscore, on purpose: Task 7's RLS
guard (which checks that every application table has a policy) excludes `_`-prefixed tables, so a
probe left behind by accident cannot make that unrelated guard fail for the wrong reason.

## The three roles

- **`app_owner`** owns the schema and every table in it, and is the role CI runs migrations as.
- **`app_user`** is what the running application connects as. It must never be able to bypass RLS,
  must never own a table, and **must never be granted membership in `app_owner`** — Postgres's
  ownership test is role membership with inheritance, not name equality, so granting `app_owner`
  to `app_user` silently makes `app_user` the effective owner of every `app_owner` table and
  exempts it from RLS on any table not marked `FORCE`. That grant is the most tempting "fix" when
  a migration or grant fails, which is why `prove-rls-assert.sql` tests for membership and not
  just ownership.
- **`app_admin`** covers three narrow, audited paths only: bootstrap, provisioning, and the audit
  writer. It is not the application's runtime role.

`NOBYPASSRLS` is already Postgres's default for a new role. `roles.sql` sets it explicitly anyway,
because this file is where a future reader comes to confirm it — and a default that is never
written down is a default someone eventually changes without noticing what it protects.

## What `roles.sql` needs permission to do

`roles.sql` is written against a plain Postgres superuser's abilities, but it is meant to be run
as a **Neon branch owner, which is not a superuser**. Several statements therefore depend on
privileges the branch owner may or may not hold. None of them are optional — they are the intended
end state — so the privilege gets fixed, never the statement.

What the Neon branch owner actually holds, measured on the branch Task 3b ran against:
`SUPERUSER = false`, but `CREATEROLE = true`, `CREATEDB = true`, **`BYPASSRLS = true`**, `INHERIT`
membership in `neon_superuser`, and `CREATE` on the database. It is also the database owner, so it
holds `pg_database_owner`'s privileges — which is what lets it re-own `public`, since on Neon
`public` is owned by `pg_database_owner` and not by the branch owner directly.

> **`neon_superuser` carries `BYPASSRLS`.** Confirmed on the real branch. Role attributes are not
> inherited through membership, so a role that is merely a _member_ of `neon_superuser` still reads
> `rolbypassrls = false` — and would pass both `roles.sql`'s attribute assertion and assertion 5 of
> the proof — while gaining the bypass the instant anything issues `SET ROLE neon_superuser`. This
> is why `app_user` must hold membership in **no role at all**, which is checked separately.

### `roles.sql` needs `createrole_self_grant` on PG16+

`roles.sql` is executed as a single simple-query string, which makes it one implicit transaction:
it applies completely or not at all. That rules out "run it, then grant, then re-run", because a
failed run rolls the roles back along with everything else — the memberships have to exist the
moment the roles do.

PG16+ splits role membership into `ADMIN` / `INHERIT` / `SET`, and a `CREATEROLE` non-superuser
that creates a role is auto-granted `ADMIN OPTION` and nothing else. `createrole_self_grant`
(default: empty, confirmed empty on Neon) is Postgres's own mechanism for widening that auto-grant.
So `roles.sql` is applied with it set for the session:

```
node scripts/db/run.mjs --as owner --file scripts/db/roles.sql --createrole-self-grant
```

which issues `set createrole_self_grant = 'set, inherit'` before the file. It is session-scoped, it
applies only to roles created later in that session, and it grants the **executing** role
membership in the roles it creates — it never grants anything to `app_user`.

| Statement                                                          | Requires                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | If it fails                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create role ... login nobypassrls`                                | `CREATEROLE`. `CREATE ROLE`'s `BYPASSRLS`/`SUPERUSER` check is value-gated, so the negative form is fine for a non-superuser.                                                                                                                                                                                                                                                                                                                                                        | The branch owner cannot create roles at all; nothing downstream can proceed.                                                                                                                                                                                                                                  |
| `create schema authz authorization app_owner`                      | `CREATE` on the database, and the ability to **`SET ROLE` to `app_owner`** — PG16+ calls `check_can_set_role()`, so plain membership is _not_ enough; the membership needs the `SET` option. **This is the statement that actually failed first on Neon**, with `must be able to SET ROLE "app_owner"` (SQLSTATE 42501).                                                                                                                                                             | Set `createrole_self_grant` as described above; do not drop the `authorization` clause. A bare `grant app_owner to <owner>` issued afterwards cannot help — the failed run has already rolled the roles back.                                                                                                 |
| `alter schema public owner to app_owner`                           | Ownership of `public` (via `pg_database_owner` on Neon, which the branch owner holds as database owner), the ability to **`SET ROLE` to `app_owner`** (`check_can_set_role()`, not plain membership), **and** `CREATE` on the current database — the last checked against the _executing_ role, not the new owner. (Postgres's source flags that database-level check as a deviation from other `ALTER ... OWNER TO` commands, which is why it's easy to miss.)                      | Predicted to be "the statement most likely to fail on Neon"; in practice it **succeeded** once `createrole_self_grant` was in place, because the branch owner already had `CREATE` on the database and `pg_database_owner`'s privileges. Still must not be skipped — it is what makes `app_user` a non-owner. |
| `alter default privileges for role app_owner in schema public ...` | Membership in `app_owner` **with inheritance** (`has_privs_of_role`, not just `is_member_of_role`). PG16+ auto-grants the `CREATEROLE` creator only ADMIN OPTION on a role it creates, not inherited privileges — that's controlled separately by `createrole_self_grant`, which defaults to empty — so this can still fail for the very role that created `app_owner`. Confirmed accurate; `createrole_self_grant` was observed empty on Neon.                                      | The `inherit` half of `createrole_self_grant` covers it. Granting membership after the fact does not, because the file is atomic.                                                                                                                                                                             |
| `revoke create on schema public from ...`                          | Ownership of `public` — which, once the `alter schema` above succeeds, means holding `app_owner`'s privileges through inherited membership, not merely having created `public`. This row gets _harder_ once that statement succeeds, not easier. Confirmed accurate. Note the `from public` part was already a no-op: since PG15, `PUBLIC` gets no `CREATE` on `public` by default, and Neon's ACL was observed as `pg_database_owner=UC/pg_database_owner \| =U/pg_database_owner`. | The `inherit` half of `createrole_self_grant` covers it.                                                                                                                                                                                                                                                      |

Note what is deliberately **not** in that list: there is no `alter role ... nobypassrls nosuperuser`.
`ALTER ROLE` checks the `SUPERUSER` and `BYPASSRLS` attributes on _mention_ rather than on value, so
even setting them to the negative requires superuser and would hard-fail on Neon. `roles.sql` asserts
those attributes instead — a `DO` block that raises if any of the three roles holds `BYPASSRLS` or
`SUPERUSER`. Asserting needs no privilege, covers `app_owner` and `app_admin` as well as `app_user`,
and fails loudly instead of being quietly deleted by whoever hits a permission error.

## Passwords are not in `roles.sql`

`roles.sql` creates all three roles without passwords. Task 3b's runner sets them afterward using
`format('alter role %I password %L', role_name, password)`, letting Postgres's own quoting (`%L`)
handle the password value. That's deliberate: a password embedded directly in a SQL string could
contain a quote character and break out of the statement, and a password committed to a file in
this repository would sit in git history forever, unrecoverable-not-secret from that point on. If
you are looking for where passwords get set, it is not here — it is in Task 3b's Node runner.

## No `psql` required

Older Postgres role-setup guides are almost all written for `psql`, but these files avoid every
piece of `psql`-only syntax on purpose: no `\set`, no `:'variable'` interpolation, no `\i`, no
`\gexec`, no backslash commands of any kind. Task 3b applies these scripts and runs the proof
through a Node Postgres client, not `psql`, so anything that only `psql` understands would simply
fail there.

## Running the proof

`scripts/db/run.mjs` is the runner. It reads `.env` itself, opens **one** `pg.Client` session per
invocation (never a Pool, never the `@neondatabase/serverless` HTTP driver), sends each file as one
simple-query string, stops at the first error with a non-zero exit, and refuses to connect to a
pooled host — a `-pooler` endpoint is PgBouncer in transaction mode, which can hand the statements
after `commit;` to a different backend and make the release assertion pass vacuously.

In order, against the same database:

```
node scripts/db/run.mjs --as owner     --file scripts/db/roles.sql --createrole-self-grant
node scripts/db/run.mjs --as owner     --set-passwords
node scripts/db/run.mjs --as owner     --verify-roles
node scripts/db/run.mjs --as app_owner --file scripts/db/prove-rls-setup.sql
node scripts/db/run.mjs --as app_user  --file scripts/db/prove-rls-assert.sql
node scripts/db/run.mjs --as app_owner --file scripts/db/prove-rls-teardown.sql
```

`--verify-roles` reports the checks the proof cannot make about itself: that `app_user` holds none
of `BYPASSRLS`/`SUPERUSER`/`CREATEROLE`/`CREATEDB`, owns no relation, and — the one that matters
most on Neon — holds membership in **no role at all**.

Every line the runner prints is passed through a redaction function built from the values in
`.env`, including caught exceptions and stack traces, so a connection error cannot leak a host or a
user. Do not add output that bypasses it.

### How `prove-rls-assert.sql` must be executed

The file asserts six things, in this order: that the connection is authenticated as `app_user`
(not merely `set role`'d to it); that no identity means no rows; that an identity set inside a
transaction shows exactly that person's row; that the identity **did not survive the commit** of
that transaction; that the connecting role holds neither `BYPASSRLS` nor `SUPERUSER`; and that it
neither owns nor holds membership in the owner of any relation.

The fourth of those constrains the runner, because `set_config(name, value, true)` is
transaction-local and a `DO` block does not open a transaction — it runs in the caller's. So:

- Run the file on **one** connection, in **file order**, stopping at the first exception.
- Do **not** wrap it in a caller-opened transaction. The file contains its own `begin;`/`commit;`,
  and if those merely join an outer transaction, the release-at-transaction-end assertion stops
  testing what it claims to test.

That release property is the reason session-scoped `SET` is banned project-wide: a pooled
connection must not carry one person's identity into the next person's query. The file proves it
rather than assuming it, and the contract above is restated in a comment at the top of the file so
a future runner change cannot silently invalidate it.

**Expected result:** `prove-rls-assert.sql` produces no output and raises no exception. That
silence is the pass condition — every assertion in that file raises an exception on failure, so
there is no output for a person or a script to misread. Any exception raised while running it is a
genuine failure of the authorization model, and nothing downstream of it may proceed until it is
fixed. In particular, do not proceed past a failure by relaxing the assertion — fix the role or
grant that caused it.

Silence is only worth something if the assertions can actually speak, so Task 3b checked that they
do, with three deliberately broken runs against the real branch: changing assertion 3's
`set_config(..., true)` to `false` tripped assertion 4; running the file as `app_owner` tripped
assertion 1; and a temporary `grant app_owner to app_user` tripped assertion 6. All three raised,
the runner exited non-zero, and the grant was revoked and re-verified afterwards. Re-do that check
if you ever change how the file is executed — a runner that swallows exceptions looks identical to
a passing proof.

## Where this must run

These four scripts must be applied, in order, against **every** Neon branch that carries
application data — not just the first one created. A branch that never received `roles.sql` and
the proof has an unverified authorization model, whatever branches it was copied or forked from.
