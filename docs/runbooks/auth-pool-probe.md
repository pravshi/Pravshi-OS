# WP-A1 auth pool probe — operator procedure

How to verify, through a **real Neon pooler**, that the `app_auth` and `app_worker` logins (and
`app_user`) each authenticate as themselves, and how the authentication pool behaves under load.
CI and local runs go through a local proxy and prove nothing about Neon's pooler; only this
procedure closes the gate in the [production migration runbook](./production-migration.md)
(step 3, "Authentication role" and "Worker role"). Results go in the
[run record](./auth-pool-probe-record.md).

**Rules.** A **non-production** Neon project only — never the production project, never a
production branch. Explicit approval before the run. No paid feature, no plan change. Every
credential stays on the operator's machine: never paste a password, a connection string or a full
hostname into chat, a ticket, a commit or the run record. The repository is public.

**What the probe does.** `scripts/ops/auth-pool-probe.mjs` sends only read-only statements
(`session_user`, `pg_roles`, `pg_auth_members`, `current_setting`, `pg_stat_activity`, and empty
transactions around `pg_sleep(0.5)`). It creates, changes and deletes nothing. It opens up to 80
client connections for about three and a half minutes (three 60-second phases), so it uses compute
on the branch it targets and keeps that compute awake while it runs.

## 1. Confirm the target in the Neon console

1. Open the **non-production** Neon project (development runs against a separate project from
   production — [DEPLOYMENT.md](../../DEPLOYMENT.md)). Check the project name before anything else.
2. Pick the branch to probe (a dedicated dev branch is best) and note its **name**.
3. Open that branch's compute and note its **endpoint ID** (it starts `ep-`). The pooled and the
   direct hostnames of this one compute differ only by `-pooler` after the endpoint ID; all four
   connection strings below must use this endpoint.
4. Note the compute size.

## 2. Prepare the roles — on that branch only

The identity checks need the four logins with passwords. Run each step against the branch
confirmed above, never production.

1. **Create the roles.** Follow [scripts/db/README.md](../../scripts/db/README.md):
   `node scripts/db/run.mjs --as owner --file scripts/db/roles.sql --createrole-self-grant`, with
   that branch's owner connection in the repository's `.env` (`NEON_OWNER_URL`; the file is
   git-ignored — remove the value afterwards). `roles.sql` is idempotent, creates `app_owner`,
   `app_user`, `app_admin`, `app_worker` and `app_auth` where missing, and stops if any of them has
   SUPERUSER, BYPASSRLS, CREATEROLE or CREATEDB.
2. **`app_owner` and `app_user` passwords:** `node scripts/db/run.mjs --as owner --set-passwords`
   (reads `APP_OWNER_PASSWORD`, `APP_USER_PASSWORD` and `APP_ADMIN_PASSWORD` from the same `.env`;
   all three are required).
3. **`app_worker` and `app_auth` passwords** — `run.mjs` does not set these. Either:
   - **Neon console** (preferred): branch → Roles → the role → reset password, if the role is
     listed there. Neon generates the password and shows it once; put it straight into the probe's
     environment file (step 5). Whether roles created through SQL appear in this list has not been
     verified for this project — if they do not, use the next option.
   - **Neon SQL Editor**, connected to that branch as its owner: `alter role app_auth password '…'`
     (and the same for `app_worker`) with a freshly generated value. Generate it without printing
     it — in PowerShell, `node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))" | Set-Clipboard`
     — and paste it into the editor and the environment file only. The SQL Editor keeps a query
     history in the project: acceptable only because this project is non-production; rotate these
     passwords after the probe.

## 3. Apply migrations — when the gate requires them

The probe's checks need no schema, but the gate this procedure closes is "the first
non-production branch that receives 0072/0073". On that branch, apply the migrations through the
latest (0075) with the direct `app_owner` connection:
`node --env-file=<owner env file> scripts/migrate-ws.mjs` (the file holds only
`DATABASE_URL_MIGRATE`; same handling as step 5). Then run, as the owner, the read-only role and
grant checks of the production migration runbook, step 3 ("Worker role", "Authentication role"),
and record their results.

## 4. Clear the shell

Open a **new** terminal. Node's `--env-file` does **not** replace a variable that is already set,
so a leftover value would silently win over the file. In PowerShell:

```powershell
Remove-Item Env:NEON_LOCAL_WSPROXY, Env:NEON_LOCAL_PG_ADDRESS, Env:DATABASE_URL, Env:DATABASE_URL_AUTH, Env:DATABASE_URL_WORKER, Env:DATABASE_URL_MIGRATE -ErrorAction SilentlyContinue
Get-ChildItem Env: | Where-Object { $_.Name -like 'NEON_LOCAL*' -or $_.Name -like 'DATABASE_URL*' }   # must print nothing
```

`NEON_LOCAL_WSPROXY` and `NEON_LOCAL_PG_ADDRESS` send every connection to a local Postgres
(`scripts/ci/neon-local.mjs`); the probe refuses a Neon run while either is set.

## 5. Create the environment file — outside the repository

Create `%USERPROFILE%\.pravshi\probe.env` (any path **outside** the repository) holding exactly
four lines, `NAME=value`, each value copied from the Neon console's connection details for the
branch and role:

| Variable               | Connection                                   |
| ---------------------- | -------------------------------------------- |
| `DATABASE_URL`         | role `app_user`, **pooled** connection on    |
| `DATABASE_URL_AUTH`    | role `app_auth`, **pooled** connection on    |
| `DATABASE_URL_WORKER`  | role `app_worker`, **pooled** connection on  |
| `DATABASE_URL_MIGRATE` | role `app_owner`, **pooled** connection off  |

Restrict it to your own account:

```powershell
icacls "$env:USERPROFILE\.pravshi\probe.env" /inheritance:r /grant:r "${env:USERNAME}:(R,W)"
```

## 6. Run the probe

From a checkout of the commit under test with dependencies installed (`pnpm install
--frozen-lockfile`), in the shell cleared in step 4:

```powershell
$result = "$env:USERPROFILE\.pravshi\probe-result.json"
node --env-file="$env:USERPROFILE\.pravshi\probe.env" scripts/ops/auth-pool-probe.mjs `
  --non-production-branch <branch-name> --expect-endpoint <endpoint-id-from-step-1> `
  --instances 1,3,10 --seconds 60 | Out-File -Encoding utf8 $result
"exit=$LASTEXITCODE"
```

- `--expect-endpoint` is the endpoint ID you read in the console in step 1. The probe refuses to
  run unless all four connection strings name that endpoint (pooled and direct forms of the same
  compute), the same database, a `*.neon.tech` host, and the expected login role each.
- Keep `--seconds 60`. Acquisition times include connection set-up; in very short phases set-up
  dominates p95 (measured on a local dry run: 3-second phases put the 3-instance p95 at 1.2 s,
  20-second phases at 0 ms), which would fail the p95 threshold for a reason that is not pool
  pressure.
- The result file stays outside the repository. It always contains a JSON document — including
  when the run is refused or stops midway — with no credential, username, query parameter or full
  hostname; endpoint IDs appear only masked (`ep-…` and the last four characters).

`--local-dry-run` exists for testing the probe against a local Postgres through wsproxy (it
requires `NEON_LOCAL_WSPROXY`). A dry run never contacts Neon, reports
`"neon_pooler_verified": false` and `"status": "LOCAL_DRY_RUN_ONLY"`, and never exits 0. It is not
evidence for this gate.

## 7. Read the result

| Exit | `status`             | Meaning                                                                    |
| ---- | -------------------- | -------------------------------------------------------------------------- |
| 0    | `NEON_VERIFIED`      | Identity passed **and** every load phase passed. `neon_pooler_verified: true` |
| 1    | `IDENTITY_FAILED`    | At least one login is wrong; load phases were skipped                      |
| 1    | `LOAD_FAILED`        | Identity passed (`identity_status: PASS`); at least one load phase failed  |
| 1    | `FAILED_MIDWAY`      | Stopped at `failed_stage` with a sanitized `error` code; partial results kept |
| 2    | `REFUSED`            | A precondition failed (`reasons`); nothing was connected                   |
| 3    | `LOCAL_DRY_RUN_ONLY` | A local dry run; no Neon verification                                      |

**Identity** (`identity.<VARIABLE>`), per connection:

- `login_ok: false` — the connection authenticated as another role (`got` names one of ours, or
  `(another role)`). The URL is for the wrong role, or the pooler is not logging in as the role in
  the connection string. Stop: the gate fails.
- `attributes_ok: false` — the role has SUPERUSER, BYPASSRLS, CREATEROLE or CREATEDB. Stop and
  re-run `roles.sql` on that branch; never "fix" it on production.
- `membership_ok: false` (runtime roles) — the role is a member of another role, so it would
  inherit privileges. Stop and investigate.
- `error` — the login failed outright: `28P01` wrong password, `28000` no such role or no access,
  `3D000` no such database, `ENOTFOUND` / `ECONNREFUSED` / `TIMEOUT` network or endpoint
  suspended-and-unreachable.

**Load** (`load[]`, one entry per instance count), each with its own `status` and `checks`:

| Check                                            | Meaning                                                        |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `no_client_errors`                               | no connection, acquisition or query error for either role (`errors` holds `acquire:<code>` / `query:<code>` counts) |
| `sampled`                                        | `pg_stat_activity` was sampled at least once                    |
| `peak_total_below_max_minus_reserved`            | peak server connections < `max_connections` − reserved          |
| `app_auth_p95_within_single_instance_plus_200ms` | app_auth p95 acquire ≤ the 1-instance p95 + 200 ms (`BASELINE` on the 1-instance phase) |
| `app_auth_peak_within_documented_pool_size`      | `MANUAL`: compare `peak_server_connections.app_auth` with Neon's documented per-role pooler limit and record it |

**Capacity decisions** (unchanged from the record template): expected peak is 3 instances,
stress is 10. If a 3-instance check fails, lower the authentication pool and repeat without
editing the probe — `--auth-per-instance 2 --instances 1,3` — or record the limit as a deployment
constraint. A failure only at 10 instances is the stress ceiling: the run exits 1
(`LOAD_FAILED`) and the record says so; it does not by itself fail the gate. A changed pool size
also needs `AUTH_POOL_MAX` in `src/lib/db/auth-pool.ts` changed through a pull request.

**A run that stopped midway** (`FAILED_MIDWAY`): keep the partial JSON for the record, fix the
cause the `failed_stage` and `error` point to, and run again.

## 8. After the run

1. In the Neon console, read the branch's compute usage for the run and whether the compute
   suspends after its idle period (and how long after the last query). Record both.
2. The record's "24 h before / after the new build" comparison needs a deployed build on this
   branch. When none is deployed, mark it **N/A — no deployment on this branch** rather than
   leaving it blank.
3. Fill in the [run record](./auth-pool-probe-record.md) and propose it through a pull request.
   Paste the probe's JSON as printed — it carries masked endpoint IDs only — and never add a full
   hostname or endpoint ID by hand.
4. Delete `probe.env` and `probe-result.json` once recorded, remove `NEON_OWNER_URL` and the
   role passwords from the repository's `.env`, and rotate the branch's role passwords if any of
   them was ever shown outside your own terminal.
