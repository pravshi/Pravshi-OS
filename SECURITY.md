# Security

## Database roles

Postgres does not enforce RLS against a table's owner, or against any role holding
`BYPASSRLS`. An application connected as either one has policies that look correct, review
as correct, and do nothing at all. The role split exists so that failure cannot happen.

| Role        | Purpose                                                                                  | Owns tables | Credential lives in                                    |
| ----------- | ---------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------ |
| `app_owner` | Schema owner, migrations only                                                            | Yes         | GitHub Actions and local machines ONLY                 |
| `app_user`  | **Application runtime**                                                                  | **No**      | `DATABASE_URL` — local, and Vercel when it exists      |
| `app_admin` | First-run bootstrap only: EXECUTE on `public.bootstrap_organization()`, and nothing else | No          | `DATABASE_URL_BOOTSTRAP` — the operator's machine only |

All three are created `login nobypassrls`, and `roles.sql` asserts that none holds
`BYPASSRLS`, `SUPERUSER`, `CREATEROLE` or `CREATEDB`. The assertion raises and aborts if any
does. `CREATEROLE` and `CREATEDB` are asserted as defence in depth, not as known RLS
bypasses.

`app_owner` additionally holds `CREATE` **on the database**. That is a database-level grant,
not a role attribute, and it exists because Drizzle's migrator unconditionally runs
`CREATE SCHEMA IF NOT EXISTS` before its bookkeeping — Postgres evaluates that privilege
before the `IF NOT EXISTS` short-circuit, so no migration can run without it.

### Why `app_user` has no `BYPASSRLS`

It is the role the deployed application connects as. If it could bypass RLS, every policy in
the system would be advisory. It owns no tables for the same reason: ownership is its own
bypass. `revoke create on schema public from app_user, app_admin, public` keeps it that way.

### Why the application never holds `app_owner`

`app_owner` owns the schema, so RLS does not constrain it. A runtime holding that credential
has an authorization model that is decorative. See [ENVIRONMENT.md](ENVIRONMENT.md).

## RLS

Every table carries `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY`. `FORCE`
is the half people forget: without it, the table owner is exempt from its own policies.

Identity is set **inside the transaction only**, with transaction-scoped `set_config`.
Session-scoped `SET` is banned — pooled connections are reused, and a session setting would
carry one person's identity into the next person's query.

## withAuthorizedDb() — the only path to Postgres

```
connect via connectWithWake()   retries the CONNECT only, never the work
  -> open transaction           SET LOCAL needs a transaction to live in
  -> set identity               transaction-scoped, dies with the transaction
  -> run the callback
  -> commit / rollback          context cannot outlive the transaction
  -> release                    always, including after a rollback
```

Two absolutes: the business work is never retried (a connection lost mid-COMMIT is ambiguous,
and replaying it can double-write), and no query runs outside the helper. Without context
every policy evaluates false and the query returns **zero rows** — fail-closed.

## CI guards

Each proves one property the rest of the system assumes. **A guard failure is a security
failure, not a test failure.** Fix the cause; never weaken the guard to make CI green.

| Guard                                     | What it proves                                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/guards/rls-enabled.test.ts`        | Every table in `public` has RLS enabled **and forced**                                                                                         |
| `tests/guards/runtime-role.test.ts`       | The runtime role has no `BYPASSRLS`, is not superuser, owns no tables                                                                          |
| `tests/guards/single-db-path.test.ts`     | Nothing bypasses `withAuthorizedDb()` or the cold-start retry                                                                                  |
| `tests/guards/no-keepalive.test.ts`       | No cron, heartbeat or warm-up defeats Neon autosuspend                                                                                         |
| `tests/db/authorized.test.ts`             | Context does not leak across pooled connections; fail-closed holds                                                                             |
| `tests/health/no-db-in-health.test.ts`    | `/health` never touches the database                                                                                                           |
| `scripts/guards/secret-scan.mjs`          | No credential-shaped string enters the repository                                                                                              |
| `scripts/guards/workflow-secret-flow.mjs` | No workflow feeds a GitHub secret into a `DATABASE_URL*` variable, and none names the bootstrap credential or runs the bootstrap script at all |

## First-run bootstrap

The first SUPER_ADMIN is created once per database by `scripts/bootstrap/run.mjs`, calling
`public.bootstrap_organization()` as `app_admin` (`drizzle/0015_bootstrap.sql`). The chain, and
what closes each link:

| Link                   | Closed by                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `app_admin` credential | Operator machine only; refused by `src/env.ts` in production and by the CI workflow guard |
| the bootstrap function | EXECUTE granted to `app_admin` alone; `app_user` refused by privilege and by the function |
| `bootstrap_state`      | The first write; a singleton no role can update, delete or truncate                       |
| the SUPER_ADMIN grant  | The protected-role genesis branch, which closes the moment the organization has a holder  |
| the setup token        | SHA-256 digest only, 60-minute ceiling, consumed once under a row lock, never re-issued   |

Nothing in `audit_logs` is written during bootstrap, because no person acts and the audit log
has no system actor. The origin is `bootstrap_state`; the first audit entry is the owner
completing setup, and it carries the origin — `granted_by: null` — in its metadata. See
[scripts/bootstrap/README.md](scripts/bootstrap/README.md).

## What GitHub Free does not give us

This repository is private on **GitHub Free**, which means the following do **not** exist:

- branch protection and repository rulesets
- required status checks — CI is green on every PR, but GitHub will not block a merge
- enforced CODEOWNERS review — `.github/CODEOWNERS` **auto-requests** reviewers, nothing more
- secret scanning and push protection
- CodeQL
- `production` environment required reviewers

Two compensating controls exist, and both are **detection, not prevention**:

- `scripts/guards/secret-scan.mjs` stands in for push protection, running on every PR.
- `.github/workflows/direct-push-audit.yml` fails a run when a commit reaches `main` without
  arriving through a merged pull request. It decides from GitHub's PR-association data, never
  from a commit subject such as `(#123)`, which anyone can forge. It cannot stop the push.

Everything else is policy, enforced by people. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Storage object keys

`objectKey()` produces `<orgId>/<documentId>/<versionNo>/<random uuid>`.

- The **prefix is determined by its inputs**, so a bucket listing is enumerable per org and
  per document. The **leaf is random**, so an individual object is not guessable.
- The **file name is never part of the key.** A key is an address; a leaked address must
  reveal nothing about the document. Display names live in the database.
- `orgId` and `documentId` are validated as UUIDs, because both are interpolated into a path
  and an unvalidated value such as `../..` would build a key that escapes its own prefix into
  another tenant's namespace.

**The object key is not an authorization mechanism.** Authorization stays application-layer.
Validation only ensures a key cannot address something its inputs did not name.

## Credential rotation

Rotate immediately when a credential reaches a terminal, a log, a screenshot or a chat
transcript. Treat "it was only briefly visible" as compromised.

1. **Rotate the role's password on every Neon branch that has it.** Neon's per-branch password
   reset is branch-scoped: resetting on a child leaves the parent working.
2. **Verify the old credential is actively rejected**, not merely superseded. A rotation you
   have not negatively tested is a rotation you have not done.
3. **Verify the new credential works** through the pooled endpoint the application uses.
4. **Re-assert the role invariants** — `NOBYPASSRLS`, `NOSUPERUSER`, `NOCREATEDB`,
   `NOCREATEROLE`, owns zero tables.
5. **Update `.env`.** Do not print the value while doing so.
6. **Check whether the credential lived anywhere else** — GitHub Actions secrets, CI logs,
   Vercel. Database URLs are deliberately absent from Actions, so usually there is nothing.

Rotating an ephemeral CI credential is never necessary: CI resets the role password on each
throwaway branch, and the branch is destroyed at the end of the run.

## Reporting a security problem

Report privately to the founder. Do not open a public issue, and do not describe the problem
in a pull request title. Include what you observed, how to reproduce it, and which credential
you believe is exposed — but never paste the credential itself.
