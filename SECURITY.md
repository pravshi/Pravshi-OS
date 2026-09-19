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

Since Task 1.16, `people`, `engagements` and `engagement_events` follow the database.md §4.2
template: `authz.scope_for()` decides GLOBAL, DEPARTMENT (through the live engagement's
department, via `authz.in_my_departments()`), TEAM (through `authz.reports_to_me()`) and SELF,
with PROJECT false until Phase 4. Seeing **yourself** is never gated on `authz.is_active()`;
seeing **anybody else** always is.

**A subquery inside a policy is itself subject to RLS.** It runs as `app_user` like any other
query, so a policy that reads another table sees only what that table's policy allows. This is
why both widening branches on `people` go through definer helpers instead of reading
`engagements` inline: the inline version returned the caller's own engagement and nothing else,
so it would have read as correct and hidden the whole department.

RLS filters rows, not columns. So `date_of_birth`, `personal_email` and `phone` sit outside
`app_user`'s grant on `people` entirely: widening a row can never widen those fields, which is
what §2 footnote 2 requires when a DEPARTMENT holder sees a colleague. Only a definer function,
running as the owner, reads them.

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

| Guard                                           | What it proves                                                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/guards/rls-enabled.test.ts`              | Every table in `public` has RLS enabled **and forced**                                                                                         |
| `tests/guards/runtime-role.test.ts`             | The runtime role has no `BYPASSRLS`, is not superuser, owns no tables                                                                          |
| `tests/guards/single-db-path.test.ts`           | Nothing bypasses `withAuthorizedDb()` or the cold-start retry                                                                                  |
| `tests/guards/no-keepalive.test.ts`             | No cron, heartbeat or warm-up defeats Neon autosuspend                                                                                         |
| `tests/guards/require-permission-first.test.ts` | Every protected Route Handler is built with `withPermission()`, and every Server Action awaits `requirePermission()` first                     |
| `tests/db/authorized.test.ts`                   | Context does not leak across pooled connections; fail-closed holds                                                                             |
| `tests/health/no-db-in-health.test.ts`          | `/health` never touches the database                                                                                                           |
| `scripts/guards/secret-scan.mjs`                | No credential-shaped string enters the repository                                                                                              |
| `scripts/guards/workflow-secret-flow.mjs`       | No workflow feeds a GitHub secret into a `DATABASE_URL*` variable, and none names the bootstrap credential or runs the bootstrap script at all |

## Application authorization — `requirePermission()`

`src/lib/authz/require-permission.ts` is the one application-layer authorization boundary. It adds
no second model: every answer comes from Better Auth, `withAuthorizedDb()`, an existing `authz.*`
helper, or a table's own RLS policy. It orders the questions, turns the answers into one outcome,
and records refusals.

| Step | Question                                  | Answered by                                                   | Refusal                |
| ---- | ----------------------------------------- | ------------------------------------------------------------- | ---------------------- |
| 1    | Who is asking?                            | Better Auth session, through `resolveAuthContext()`           | 401 `UNAUTHENTICATED`  |
| 2    | Does the database still accept them?      | `authz.person_id()`, `authz.org_id()` in `withAuthorizedDb()` | 401 `UNAUTHENTICATED`  |
| 3    | Engaged, in an active organization?       | `authz.is_active()`                                           | 403 `FORBIDDEN`        |
| 4    | Assured, if MFA is mandatory for them?    | `authz.aal()`                                                 | 403 `STEP_UP_REQUIRED` |
| 5    | Does any live role grant the permission?  | `authz.scope_for()`                                           | 403 `FORBIDDEN`        |
| 6    | Broad enough, when the operation needs it | the `access_scope` enum order                                 | 403 `SCOPE_DENIED`     |
| 7    | Is the target visible?                    | the table's RLS policy, probed under the same identity        | 404 `NOT_FOUND`        |

Steps 1–6 never look at the target, so a 401 or 403 cannot reveal whether a record exists, and a
missing, out-of-scope or other-tenant record all answer the same 404. The caller's work then runs
through `withAuthorizedDb(authorization.ctx)`, where every policy re-derives identity, engagement
and scope: RLS stays the backstop, and a suspension between the check and the work still holds.

**Mandatory MFA.** A person needs a verified `aal2` session for every protected request when any
live role gives them a sensitive permission (`permissions.is_sensitive`) at `GLOBAL` scope. With
the seeded roles that is exactly SUPER_ADMIN, ADMIN, HR_ADMIN and FINANCE; no role name appears in
code, and a custom role carrying the same capability inherits the rule. It is per person — a
second, non-privileged role cannot lower it. Since migration `0016`, `authz.aal()` honours `aal2`
only when the session claims it and the person holds a verified factor. A step-up is a 403 whose
envelope carries `"code": "STEP_UP_REQUIRED"` and `"assurance": { "required": "aal2", "current": "aal1" }`;
stepping up is Better Auth's enrolment or TOTP sign-in, which is never behind `requirePermission()`.

**Record grants.** Never evaluated in application code. A grant reaches a record only through a
table's RLS policy, after steps 2–6 have passed, so it cannot create a missing permission, widen
the returned scope, satisfy a minimum scope, skip eligibility or MFA, or confer role or permission
management.

**Denials are audited.** Every refusal from step 3 onward — every 403 and 404 — writes one `DENIED`
entry: the permission key as the action, the reason and any scope or assurance detail in metadata,
the request id, the client address and the user agent. It is written in its own transaction, so the
refused request cannot roll it back; if the write itself fails, the request is refused anyway and
the failure is reported without the driver's message. A refusal with no usable identity (steps 1
and 2) has no actor to record against, and neither has `withPermission()`'s cross-origin refusal,
which comes before identity: those go to the server log only, until `login_events` exists. No
cookie, token, password, factor secret or request body is ever written.

**Enforced in CI.** `tests/guards/require-permission-first.test.ts` fails the build for any Route
Handler not built as `export const METHOD = withPermission(...)`, any Server Action whose first
statement does not await `requirePermission()`, and any Server Action declared outside a module
that starts with `'use server'`. It fails closed: an export shape it cannot read is a failure, not
a pass. The only exceptions are four pre-authentication routes — `/api/auth/[...all]`,
`/api/bootstrap/complete`, `/health` and `/health/db` — and there is no annotation that adds a fifth.

### What `requirePermission()` does not complete

It is the central authorization engine, not the whole Phase 1 backend. Still to come, explicitly:

- invitations, and `login_events` (including refusing sign-in to people who are not access-eligible)
- the §4.2 template on the Phase 1 tables it has not reached: `internships` has no catalogue key
  at all, and `departments`, `teams`, `team_members` and `person_departments` stay
  relationship-scoped because `departments.view` and `teams.view` reach nobody but SUPER_ADMIN
- `engagements.view` in the §2 matrix: HR_MANAGER may transition an engagement at DEPARTMENT but
  holds no key to read one, so the Task 1.16 policy reaches SUPER_ADMIN alone
- `authz.is_project_member()` and PROJECT scope (Phase 4). Effective scope is one value, so a
  person granted a permission at both PROJECT and SELF resolves to PROJECT and their own rows fail
  closed until that helper exists (`tests/authz/scopes-and-grants.test.ts` records it)
- admin services, and the record-grant issuing path
- the breach-list password check, and appropriate rate limits for application routes and actions
- per-permission step-up for people who are not privileged (Phase 2)
- dev fixture accounts and Playwright role journeys
- the NOTICE_PERIOD access decision
- reconciling security.md §2, which prints `S` for SUPER_ADMIN's `policies.acknowledge`, with the
  seed, which grants SUPER_ADMIN the whole catalogue at `GLOBAL` (`tests/authz/matrix.test.ts`
  pins the seed and fails if the document changes without it)
- operational cleanup of local environments: no local `.env` may point at `production`

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
