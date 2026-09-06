# Database roles and the RLS proof

This directory holds the SQL that establishes PRAVSHI OS's database roles and proves, against a
real Postgres server, that the application cannot bypass Row Level Security (RLS).

Postgres does not enforce RLS against a table's owner, or against any role holding `BYPASSRLS`. An
application connected as either one has policies that look correct, review as correct, and do
nothing at all — silently, until someone relies on them. Everything else in this system's
authorization model assumes that failure cannot happen here. These files are how that assumption
gets proven instead of assumed.

None of this has been run yet. Authoring these files is Task 3a. Applying them to a real Neon
branch and running the proof is Task 3b, which needs a connection string from the founder.

## The files, and who must run each one

Running any of these as the wrong role makes the proof pass for the wrong reason, so read this
table before running anything.

| File                     | Run as                                                            | What it does                                                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roles.sql`              | branch owner (the role Neon gives you when the branch is created) | Creates `app_owner`, `app_user`, `app_admin`; asserts none of them holds `BYPASSRLS` or `SUPERUSER`; creates the `authz` schema; **reassigns ownership of the `public` schema to `app_owner`**; sets up base grants and default privileges. |
| `prove-rls-setup.sql`    | `app_owner`                                                       | Creates a throwaway probe table with RLS enabled _and forced_, one policy, and two rows owned by different people.                                                                                                                          |
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
end state — but Task 3b must verify each one against the real branch rather than assuming the file
applies cleanly, and must fix the privilege rather than delete the statement.

| Statement                                                          | Requires                                                                                                                      | If it fails                                                                                                                         |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `create role ... login nobypassrls`                                | `CREATEROLE`. `CREATE ROLE`'s `BYPASSRLS`/`SUPERUSER` check is value-gated, so the negative form is fine for a non-superuser. | The branch owner cannot create roles at all; nothing downstream can proceed.                                                        |
| `create schema authz authorization app_owner`                      | `CREATE` on the database, and membership in `app_owner` (granting a schema to another role means granting it away).           | Grant the executing role membership in `app_owner` first; do not drop the `authorization` clause.                                   |
| `alter schema public owner to app_owner`                           | Ownership of `public` (or membership in its current owner) **and** membership in `app_owner`.                                 | This is the statement most likely to fail on Neon. It is also the one that makes `app_user` a non-owner, so it must not be skipped. |
| `alter default privileges for role app_owner in schema public ...` | Membership in `app_owner` — automatic for the creating role only on PG16+.                                                    | Grant the executing role membership in `app_owner`, run the statement, and consider revoking it again.                              |
| `revoke create on schema public from ...`                          | Ownership of `public` — i.e. it depends on the `alter schema` above having succeeded.                                         | Fix the ownership statement first; this one will follow.                                                                            |

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

In order, against the same database:

1. `roles.sql` — as the branch owner.
2. `prove-rls-setup.sql` — as `app_owner`.
3. `prove-rls-assert.sql` — as `app_user`.
4. `prove-rls-teardown.sql` — as `app_owner`, once you're done.

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

## Where this must run

These four scripts must be applied, in order, against **every** Neon branch that carries
application data — not just the first one created. A branch that never received `roles.sql` and
the proof has an unverified authorization model, whatever branches it was copied or forked from.
