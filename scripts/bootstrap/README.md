# First-run bootstrap

`scripts/bootstrap/run.mjs` creates the first organization and its first SUPER_ADMIN. It runs
**once per database**, and the database — not this script — is what enforces that: every later
attempt is refused, whoever makes it and with whatever credential.

Blueprint §29.4, Task 1.14. The SQL, with the reasoning for every decision, is
[`drizzle/0015_bootstrap.sql`](../../drizzle/0015_bootstrap.sql).

## What one run creates

In a single transaction, through `public.bootstrap_organization()`:

| Row                     | What                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrap_state`       | The one-time gate, written **first**, and the permanent origin record: which database role performed it, when, and every row below |
| `organizations`         | From `BOOTSTRAP_ORG_NAME` and `BOOTSTRAP_ORG_SLUG`. The fourteen system roles are seeded by the existing trigger                   |
| `departments`           | `EXEC` / `Executive`, because `engagements.department_id` is `NOT NULL`                                                            |
| `people`                | The owner: `ACTIVE`, `EMP-<year>-0001`, and **no login yet**                                                                       |
| `engagements`           | `EMPLOYEE`, `ACTIVE`, in `EXEC` — so `authz.is_active()` is true for them                                                          |
| `person_roles`          | SUPER_ADMIN with `granted_by = NULL`, because nobody granted it                                                                    |
| `bootstrap_setup_token` | The SHA-256 digest of the one-time setup token, expiring 60 minutes after issue                                                    |

If anything fails, none of it exists — including the gate, so a failed attempt does not use up
the one bootstrap.

## The trust boundary

```
app_admin credential            the operator's machine; never Vercel, never GitHub Actions
→ bootstrap_organization()      SECURITY DEFINER; EXECUTE granted to app_admin alone
→ bootstrap_state               the gate; a concurrent attempt waits here, then fails
→ organization → EXEC department → person → ACTIVE engagement
→ SUPER_ADMIN origin grant      through the protected-role genesis branch
→ setup token digest            the plaintext never reaches Postgres
```

None of it is a reusable capability:

- `bootstrap_state` can never be updated, deleted or truncated, by any role, and the function
  refuses once it holds a row.
- The SUPER_ADMIN grant satisfies the protected-role rule rather than bypassing it: the genesis
  branch of `may_manage_protected_roles()` (Task 1.7) admits the first grant into an organization
  with no `roles.manage` holder, from a non-runtime role, and closes the moment one exists.
- The setup token links one login to one person, once. There is no function that issues another.

## Before you run it

1. Every migration is applied to the target database, including `0015_bootstrap`.
2. `app_admin` has a password on that branch:
   `node scripts/db/run.mjs --as owner --set-passwords`.
3. The operator machine's `.env` holds:

   | Variable                 | Value                                                          |
   | ------------------------ | -------------------------------------------------------------- |
   | `DATABASE_URL_BOOTSTRAP` | `app_admin` on the **direct** endpoint of the target branch    |
   | `APP_URL`                | where the link should point — `https`, or `http` for localhost |
   | `BOOTSTRAP_ORG_NAME`     | the organization name                                          |
   | `BOOTSTRAP_ORG_SLUG`     | lower-case letters, digits and inner hyphens                   |
   | `BOOTSTRAP_OWNER_NAME`   | the owner's full legal name                                    |
   | `BOOTSTRAP_OWNER_EMAIL`  | the owner's work email, which becomes their login              |

4. **Check which branch `DATABASE_URL_BOOTSTRAP` names.** Bootstrap cannot be undone.

## Running it

```
node scripts/bootstrap/run.mjs
```

in an interactive terminal. Before it connects, it refuses to run in CI, refuses a stdout that
is redirected, piped or captured, refuses any role but `app_admin`, and refuses a pooled
endpoint. On success it prints the link once:

```
  https://os.pravshi.com/setup#token=<43 characters>
```

## The setup token

| Property  | How                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| Generated | 32 bytes from the OS CSPRNG, base64url — 43 characters — in the script's memory                                           |
| Stored    | Its SHA-256 digest, and nothing else. The plaintext never reaches Postgres, not as a row and not as a query parameter     |
| Delivered | Once, to the operator's terminal, in a URL **fragment** — never sent to a server, never in an access log or a Referer     |
| Lifetime  | 60 minutes from issue, the lifetime Better Auth gives its own reset tokens. A `CHECK` constraint makes it a ceiling       |
| Use       | Once. Consumption happens under a row lock, so a concurrent second use waits and then fails                               |
| Binding   | To the person `bootstrap_state` names. A caller supplies no email, person or organization — only the token and a password |
| Never     | Logged, written to a file, put in `audit_logs`, emitted to GitHub Actions, or re-issued                                   |

## Completing setup — the backend contract

The `/setup` page is frontend work and does not exist yet. It reads the token from the fragment
and calls:

```
POST /api/bootstrap/complete
Content-Type: application/json

{"token": "<43 characters>", "password": "<the owner's new password>"}
```

| Status | Body                                                                                                     | Meaning                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 200    | `{"status":"COMPLETED"}`                                                                                 | The login exists and is linked. Sign in normally                                        |
| 400    | `{"error":"SETUP_TOKEN_INVALID"}`                                                                        | Unknown, expired or already used — deliberately indistinguishable                       |
| 400    | `{"error":"PASSWORD_TOO_SHORT"}` / `PASSWORD_TOO_LONG`, with `minPasswordLength` and `maxPasswordLength` | Better Auth's password policy (12 to 128 today)                                         |
| 400    | `{"error":"INVALID_REQUEST"}`                                                                            | The body is not exactly a `token` string and a `password` string                        |
| 403    | `{"error":"FORBIDDEN_ORIGIN"}`                                                                           | A browser request from another origin                                                   |
| 409    | `{"error":"SETUP_CANNOT_COMPLETE"}`                                                                      | The person already has a login, or one exists for the email. The token was not consumed |
| 413    | `{"error":"INVALID_REQUEST"}`                                                                            | The body is over 4 KB                                                                   |
| 500    | `{"error":"INTERNAL"}`                                                                                   | Logged by SQLSTATE only                                                                 |

Completion creates a Better Auth user and a `credential` account holding the library's own
scrypt hash, points `people.auth_user_id` at it, and consumes the token — all or nothing.
`email_verified` stays `false`: a link printed in a terminal proves nothing about the mailbox.

It does not sign anybody in. The owner signs in through `/api/auth/sign-in/email`, receives an
`aal1` session, and enrols TOTP through `/api/auth/two-factor/enable` and `verify-totp` to reach
`aal2` — exactly like everyone else.

## What the audit log says

**Nothing is written to `audit_logs` during bootstrap, on purpose.** No person acts: the operator
holds a database credential rather than a `people` row, and the owner does not exist when the
transaction begins. The audit log has no system actor (Tasks 1.10 and 1.11), and inventing one —
or attributing the grant to the new owner — would make its one irreplaceable property untrue.

- **`bootstrap_state` is the origin record.** It names the database role that performed the
  bootstrap and when, and it can never change.
- **The first audit entries are the owner completing setup**, attributed to the owner, because
  consuming a credential bound to you is your act. `bootstrap.setup_completed` (`CRITICAL`)
  carries the origin in its metadata — `performed_by`, `bootstrapped_at` and
  `grant.granted_by: null` — and `person.updated` records the login being linked.
- Nothing in the audit log says the owner granted themselves SUPER_ADMIN, because they did not.

## When something goes wrong

| Symptom                                           | What it means                                                           | What to do                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `already been bootstrapped`                       | The gate holds a row                                                    | Nothing. That is the guarantee working                                                                  |
| `a login already exists for the owner work email` | An `auth_users` row uses that address                                   | Find out where it came from before doing anything else. Bootstrap will not attach SUPER_ADMIN to it     |
| `COMMIT was not acknowledged`                     | The connection dropped while committing; the outcome is unknown         | Run the command again. "Already bootstrapped" means the printed link is live; success means it is void  |
| The link expires unused                           | The database is bootstrapped, and its SUPER_ADMIN cannot be claimed     | There is no re-issue path. For a first-run deployment, discard the database branch and bootstrap afresh |
| `SETUP_CANNOT_COMPLETE`                           | A login for the address appeared after bootstrap, or the person has one | Investigate that login. The token was not consumed and stays usable until it expires                    |

## Deliberately not here

- **No re-issue.** A bounded, pre-completion re-issue would be a new founder decision.
- **No rate limit on the completion endpoint.** The token carries 256 bits; malformed and dead
  tokens are refused before any password is hashed, so the endpoint is no CPU sink; and it is
  inert once the token is used or expired.
- **No breach-list password check.** Blueprint §25 requires one and it is not implemented
  anywhere yet; when it lands it must cover this path as well.
- **No MFA enforcement.** Mandatory TOTP for SUPER_ADMIN is enforced by `requirePermission()` in
  Task 1.15.
