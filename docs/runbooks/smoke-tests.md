# Post-deployment smoke tests

## When to run

Run this pack **after every deployment** — every production release, every
redeploy, and every deployment that follows a production migration — before
the deployment is declared live. Items 1–3 are automated by
`scripts/smoke/smoke.mjs`; items 4–8 are manual checks an operator performs in
a browser (plus one read-only SQL query for item 6).

Record the outcome of every item in the results table at the bottom of this
document, and file the completed table **with the deployment's run record**
(the same record the production-migration runbook produces when migrations
ran in the window). A smoke run that is not recorded did not happen.

## Before you start

- `<production-host>` below is the production hostname (no trailing slash).
  Never substitute a preview or staging host and record it as production.
- The health token comes from the operator's secret store for the production
  environment (`HEALTH_CHECK_TOKEN`, per-environment, ≥ 32 characters). Load
  it into your shell only; never paste the value into the run record, a
  ticket, or chat:

  ```sh
  export BASE_URL="https://<production-host>"
  export HEALTH_CHECK_TOKEN="<from the production secret store>"
  ```

- You need two real accounts: a normal user account **with** `integrations.view`
  (items 4, 5a, 7, 8) and one **without** `integrations.view` (item 5b).
  Record account email addresses in the run record — never passwords.
- You need the `AI_*` and `INTEGRATIONS_ENCRYPTION_KEY` go-live decisions as
  recorded for this release (items 7 and 8 are checked against them).

## The pack

### 1. Liveness — `GET /health`

```sh
curl -sS -i "$BASE_URL/health"
```

**Expected:** HTTP 200 over the production TLS certificate (no certificate
warnings) with a JSON body of the form
`{"status":"ok","at":"<ISO-8601 timestamp>"}`. This endpoint touches nothing —
no database, no compute wake.

**Failure means:** the web deployment is not serving (bad deploy, DNS/TLS
problem, or the wrong host). Nothing downstream can pass; stop here.

**Record:** status code and the `at` value in the results table.

_Items 1–3 can be run together:_ `BASE_URL=… HEALTH_CHECK_TOKEN=… node scripts/smoke/smoke.mjs`

### 2. Database endpoint hides itself — `GET /health/db` without the token

```sh
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE_URL/health/db"
```

**Expected:** **404** with an empty body. The endpoint authorises before it
touches the database, and answers 404 — not 401 — so its existence is not
confirmed to unauthenticated callers, and the call does not wake Neon compute.

**Failure means:** a 200 or 503 here means the token gate is not in front of
the database check (anyone on the internet could hold compute awake); a 401
means the concealment behaviour changed. Either is a security-relevant
regression — treat as a failed deployment.

**Record:** the status code in the results table.

### 3. Database reachability — `GET /health/db` with the token

```sh
curl -sS -i -H "x-pravshi-health-token: $HEALTH_CHECK_TOKEN" "$BASE_URL/health/db"
```

**Expected:** HTTP 200 with body `{"status":"ok","wake_ms":<number>}`.
`wake_ms` is the time the check took, including waking suspended compute: a
large first-call value after an idle period is expected (cold wake) — note it
in the record, do not alarm on it. Subsequent calls should be fast. A wrong
token also returns 404 (same as item 2); if the token is unset in the
environment, everyone is denied — 404 with the correct token means the
environment is missing `HEALTH_CHECK_TOKEN`. A database failure returns 503
with `{"status":"error"}` and the detail goes to Sentry, never to the caller.

**Failure means:** 503 — the app cannot reach the production database with its
runtime credentials (wrong `DATABASE_URL`, role problem, or Neon outage).
404 with the known-good token — the environment's token is unset or differs
from the secret store.

**Record:** status code and the `wake_ms` value (mark it "cold" if it was the
first call after an idle period).

### 4. Sign-in and session persistence

Sign in through the real UI at `$BASE_URL/login` with a real account, then —
in the same browser session — reload the page or open a second authenticated
page.

The programmatic equivalent, for the record:

```sh
# Establishes the session (server-mediated sign-in; sets the session cookie)
curl -sS -i -c /tmp/smoke-cookies.txt \
  -H 'content-type: application/json' \
  -d '{"email":"<operator email>","password":"<operator password>"}' \
  "$BASE_URL/api/auth/login"

# A second, separate request carrying only the cookie must still be recognised
curl -sS -b /tmp/smoke-cookies.txt "$BASE_URL/home" -o /dev/null -w '%{http_code}\n'
```

**Expected:** the sign-in returns HTTP 200 and sets a session cookie; the
second request is served as an authenticated page (HTTP 200), **not** a
redirect to `/login`. Wrong password, unknown email, and locked account all
return the same generic 401 by design — they are indistinguishable, and that
is not a failure signal.

**Failure means:** sign-in succeeds but the second request loses the session —
`BETTER_AUTH_SECRET` differs between deployed instances, or the cookie/domain
configuration is wrong for the production host. Users would be signed out at
random in production.

**Record:** the account email, the sign-in status code, and whether the
second request stayed authenticated. Delete `/tmp/smoke-cookies.txt` after
the run.

### 5. Permission-gated page and permission-denied surface

- **5a (gated page renders):** signed in as the account **with**
  `integrations.view`, open `$BASE_URL/settings/integrations`.
- **5b (denied surface):** signed in as the account **without**
  `integrations.view`, open the same URL.

**Expected:** 5a renders the Integrations settings page. 5b does **not**
render it — the browser is redirected to `/access-denied`, which names no
missing permission and reveals nothing about what sits behind the boundary.
(An unauthenticated visit to the same URL redirects to `/login` instead.)

**Failure means:** 5b rendering the page is an authorisation failure — stop,
the deployment is not live. 5a redirecting to `/access-denied` for an account
that holds the permission means the production permission catalogue / role
grants are not what the release expects (RLS context or seed state problem).

**Record:** both outcomes (rendered / redirected to `/access-denied`) with the
two account emails.

### 6. Worker proof — a job reaches `succeeded`

In the app, perform one action that enqueues a job — for example: run a
workflow manually (job type `workflow_run`), assign a task or trigger a
notification (`notification`), or send a test email through an integration
(`email`). Note the time and the job type. Then run this read-only query
against the production database (Neon console SQL editor, production branch):

```sql
select id, type, status, attempts, claimed_by, created_at, updated_at
from public.jobs
order by created_at desc
limit 10;
```

**Expected:** the row created by your action appears and moves
`pending` → `claimed` → `running` → **`succeeded`**, with `claimed_by`
stamped with the worker id and `updated_at` at completion. (The terminal
success status in this schema is `succeeded` — there is no `completed`
status.) Timing: the row should leave `pending` within about a minute of the
action and reach `succeeded` within 5 minutes under normal load.

**Failure means:** the row sits in `pending` past 5 minutes, or no row
appears — the worker plane is not running or not claiming (worker host down,
worker env mismatch, or no worker deployed at all). This is the silent
failure this pack exists to catch: the web app looks healthy while every
notification, email, webhook, and scheduled trigger quietly never happens.
`failed` / `dead_letter` rows for your action mean the worker is claiming but
the job itself is erroring — record `error_code` from the row and treat as a
failure.

**Record:** the job `id`, `type`, final `status`, and time from action to
`succeeded`.

### 7. AI panel honest state

Signed in as the account from item 4, open any record detail page that
carries the "AI summary" panel (a deal, contact, company, task, or project)
and click **Summarize**.

**Expected:** the panel shows the state that matches the recorded `AI_*`
go-live decision for this release —

- AI decided **off / mock** for go-live: the panel answers
  "AI isn't configured for this workspace yet." That honest not-configured
  state is a **pass**.
- AI decided **on** (a real provider configured): the panel returns a real
  summary of the record, or — if the workspace hit its configured usage
  limit — "AI usage limit reached for this workspace." Either is consistent
  with "on"; the not-configured message is not.

**Failure means:** the panel's state contradicts the recorded decision — the
deployed `AI_*` environment does not match what go-live approved (provider
vars missing, or present when they should be absent).

**Record:** which record page was used and the exact state shown.

### 8. Integrations settings and vault state

Signed in as the account with `integrations.view` (and `integrations.manage`,
to see the vault notes), open `$BASE_URL/settings/integrations` and open the
add-connection form for a vault-tier provider.

**Expected:** the page renders with its providers, connections, subscriptions,
and executions. The vault state matches the recorded
`INTEGRATIONS_ENCRYPTION_KEY` decision for this release —

- Key decided **unset** for go-live: the form shows "The server vault key
  (INTEGRATIONS_ENCRYPTION_KEY) is not configured, so a secret cannot be
  stored right now." — that is a **pass**.
- Key decided **set**: no such note appears, and storing a secret on a
  vault-tier connection is enabled.

**Failure means:** the page errors, or the vault state contradicts the
recorded decision — the deployed environment does not match the approved
configuration (key missing where it should be present, or present where the
decision was to launch without stored secrets).

**Record:** page rendered (yes/no) and the vault state observed.

## Results table (copy into the run record)

| #   | Check                                        | Result (pass/fail) | Evidence (status code / wake_ms / job id / state shown) | Operator | Time (IST) |
| --- | -------------------------------------------- | ------------------ | ------------------------------------------------------- | -------- | ---------- |
| 1   | `GET /health` → 200                          |                    |                                                         |          |            |
| 2   | `GET /health/db` unauthenticated → 404       |                    |                                                         |          |            |
| 3   | `GET /health/db` with token → 200            |                    |                                                         |          |            |
| 4   | Sign-in + session persists on second request |                    |                                                         |          |            |
| 5a  | Gated page renders for permitted account     |                    |                                                         |          |            |
| 5b  | Denied account → `/access-denied`            |                    |                                                         |          |            |
| 6   | Job reaches `succeeded`                      |                    |                                                         |          |            |
| 7   | AI panel state matches `AI_*` decision       |                    |                                                         |          |            |
| 8   | Integrations page + vault state match        |                    |                                                         |          |            |

Release / deployment identifier: ……………… Production host: ………………

## Failure doctrine

Any failure ⇒ the deployment is **not** declared live. Rollback of the code
deploy (the previous Vercel build) is the default response while diagnosis
happens. Migrations, if any ran in the same window, follow the
production-migration runbook's doctrine — forward-fix only, **never an
improvised down-migration**.
