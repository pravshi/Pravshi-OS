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

| File                     | Run as                                                            | What it does                                                                                                       |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `roles.sql`              | branch owner (the role Neon gives you when the branch is created) | Creates `app_owner`, `app_user`, `app_admin`, and sets up base grants.                                             |
| `prove-rls-setup.sql`    | `app_owner`                                                       | Creates a throwaway probe table with RLS enabled _and forced_, one policy, and two rows owned by different people. |
| `prove-rls-assert.sql`   | `app_user`                                                        | Runs four assertions against the probe table. This is the file that proves the guarantee.                          |
| `prove-rls-teardown.sql` | `app_owner`                                                       | Drops the probe table.                                                                                             |

The probe table is named `public._rls_probe`, with a leading underscore, on purpose: Task 7's RLS
guard (which checks that every application table has a policy) excludes `_`-prefixed tables, so a
probe left behind by accident cannot make that unrelated guard fail for the wrong reason.

## The three roles

- **`app_owner`** owns the schema and every table in it, and is the role CI runs migrations as.
- **`app_user`** is what the running application connects as. It must never be able to bypass RLS
  and must never own a table — both `roles.sql` and the assertions in `prove-rls-assert.sql` exist
  to guarantee that.
- **`app_admin`** covers three narrow, audited paths only: bootstrap, provisioning, and the audit
  writer. It is not the application's runtime role.

`NOBYPASSRLS` is already Postgres's default for a new role. `roles.sql` sets it explicitly anyway,
because this file is where a future reader comes to confirm it — and a default that is never
written down is a default someone eventually changes without noticing what it protects.

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
