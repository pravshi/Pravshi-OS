# Runbook: Production Migration

**Status:** Maintained procedure — written, not yet executed. Execution is a
human/operator act gated on **HG-2** (see
[release-checklist.md](./release-checklist.md) item 12). No step in this
document authorises itself; the approvals named in each step must exist first.

**Purpose.** Bring the production Neon database from its current migration
state to the repository's final journal state, safely, with a rehearsal, a
rollback asset, and a complete run record. This runbook supersedes the ad-hoc
2026-10-06 attempt (a one-time workflow whose `migrate` job failed mid-run; the
workflow was removed by PR #61) and PR #60, the stale replacement-workflow
artefact, which is closed as superseded as part of HG-2 (Step 3 closeout).

**The only runner** is `scripts/migrate-ws.mjs`, run from the repo root:

```bash
node scripts/migrate-ws.mjs
```

It reads `drizzle/meta/_journal.json` and the recorded history in
`drizzle.__drizzle_migrations` (in insertion order, `id`), verifies that the
history is exactly the journal's prefix idx 0…K−1 — the same file-byte hash and
the same `when`, row for row — and only then applies idx K…n−1 in journal
order, each in its own real transaction on one connection, recording
`sha256(file)` per migration. A failed migration rolls back whole — production
can only ever be left at a whole-migration boundary, never with partial DDL.
Exit codes: `0` = success, `2` = a migration failed and was rolled back,
`1` = the runner itself errored, `3` = **refused**: the recorded history is not a
clean prefix of the journal (a missing, duplicated, reordered, unknown or
checksum-mismatched row, or more rows than the journal has), or another run
holds the migration lock — refused before anything was applied; or the history
changed while the run was applying — it stops there, and whole migrations it
committed earlier stay applied (its second error line says how many).
Do not use any other tool, workflow, or hand-written SQL to apply migrations;
in particular not `drizzle-kit migrate`, which selects by `when` (below).

## Ground rules (binding)

1. **Verify, never assume.** Project records say production is at migration
   0044, but that state is recorded nowhere in the database's own records
   available to this repo, and the failed 2026-10-06 run may have applied
   migrations before failing. Step 0 establishes the true state before
   anything else happens, and the runbook branches on what Step 0 finds.
2. **Forward-fix only.** The only down-migrations in this repo are the three
   prepared rollback scripts in `scripts/db/rollback/` (for 0073, 0075, 0077, 0078, 0079 and 0080), each
   run only with Nani's explicit approval as Failure doctrine (d) describes;
   none are invented at incident time. Every other failure is fixed by a new PR
   and a new or corrective migration, rehearsed again from Step 2.
3. **Production is touched only in Step 3**, only under a recorded HG-2
   approval, and only after a green rehearsal (Step 2) against a snapshot of
   production itself.
4. **Freeze before snapshot.** The snapshot branch (Step 1) is the rollback
   asset; it is only a faithful copy if writes are frozen while it is taken
   and while Step 3 runs.
5. **Everything is recorded.** Every execution fills in the run-record
   template at the end of this document, including failures and aborts.

## Before you start — prerequisites

- [ ] You are the named operator for this run, and a second person (or Nani)
      is reachable for the duration.
- [ ] HG-2 approval for this execution is recorded (who, when, for which
      target journal state). HG-2 covers Step 3 exactly; Steps 0–2 are
      read-only/rehearsal acts but still need the run to be scheduled.
- [ ] A checkout of the repo at the **release commit** (the commit the
      readiness report names), dependencies installed (`pnpm install`).
      Confirm the journal in your checkout:

      ```bash
      node -e "const j=require('./drizzle/meta/_journal.json'); console.log(j.entries.length, j.entries.at(-1).idx, j.entries.at(-1).tag)"
      # expected at the current release: 80 79 0080_organization_types
      ```

- [ ] Access to the Neon console for the production project
      (`floral-base-77155861`, production branch `br-billowing-grass-b3e7ckaz`,
      endpoint `ep-tiny-butterfly-b3ue8x2a` — **per project records; re-verify
      all three in the console during Step 0 before relying on them**).
- [ ] The production `DATABASE_URL_MIGRATE` value: the **direct** (non-pooled)
      endpoint for the production branch, as role **`app_owner`**. Assemble it
      in your shell only; never commit it, paste it into the run record, or
      put it in a file that leaves your machine.
- [ ] **The `app_worker` role exists on the target branch** (needed by 0070): run
      `scripts/db/roles.sql` as the branch owner — idempotent; it creates only what is
      missing and asserts no role holds BYPASSRLS/SUPERUSER/CREATEROLE/CREATEDB — then set
      the `app_worker` password in the Neon console. Without the role, 0070 stops before
      changing anything and names this step. The rehearsal (Step 2) runs it on the snapshot
      branch first. The `DATABASE_URL_WORKER` built from that password goes to the worker
      host only (never Vercel), and the worker is deployed with or before the migration —
      see DEPLOYMENT.md, "The worker plane".
- [ ] **The `app_auth` role exists on the target branch** (needed by 0072/0073): the same
      `scripts/db/roles.sql` run creates it; set the `app_auth` password in the Neon console.
      Without the role, 0072 stops before changing anything and names this step. The
      `DATABASE_URL_AUTH` built from that password (the **pooled** host) goes to Vercel only —
      Production and Preview, never the worker host — and must differ from `DATABASE_URL`.
      **Order:** 0073 takes the credential store away from `app_user`, so the web app that
      authenticates through `DATABASE_URL_AUTH` must be deployed before 0073 is applied (0072
      is additive and safe under either app). On the first production rollout — the web app
      has never served production — apply 0072 and 0073 together and deploy the new app with
      `DATABASE_URL_AUTH` set. 0074 only narrows the two administrator definers 0072 adds (the
      target must be visible to the administrator under `people.view`); it is safe under either
      app and is applied in the same run — never stop the chain between 0072 and 0074.
- [ ] **Calendar gate:** any step that touches Neon (Steps 0–4) consumes the
      Neon allowance. Before **2026-11-01** these steps are written but not
      executed, unless Nani directs otherwise.

## The chain as of writing

The repo journal holds 77 entries (idx 0–76). Per project records, production
last applied **idx 44** (`0044_workflow_engine`), so the pending chain is the
35 migrations **idx 45–79 (0045–0080)** listed in
[Appendix A](#appendix-a--the-pending-chain-idx-4576). Step 0 verifies this;
if Step 0 disagrees, the appendix is not evidence — Step 0's output is.

One mechanical fact the operator should know: the journal's **order is its
`idx`, never time**. Its historical `when` values are not monotonic — idx 28,
29 and 30 carry earlier values than idx 27, and idx 35 ties idx 34 — so
ordering the history by `created_at` is not journal order, and drizzle-kit's
rule (apply every entry whose `when` exceeds `max(created_at)`) would silently
skip pending entries from a database stopped inside those ranges. The runner
does not use that rule: it verifies the history as an exact prefix and applies
the rest by `idx`. For the recorded 0044 state it applies exactly idx 45–79 —
no more, no fewer.

## Step 0 — Verify current production state (read-only)

Run these two queries against the **production branch** (Neon console SQL
editor, or another approved read-only path). Change nothing.

```sql
select count(*) as applied_count, max(created_at) as max_created_at
from drizzle.__drizzle_migrations;

select id, hash, created_at
from drizzle.__drizzle_migrations
order by id;
```

Order by `id` — the runner's insertion order, which follows the journal. Not by
`created_at`: the historical `when` values are not monotonic (above), so time
order would put idx 28–29 before idx 26, and idx 30 before idx 27, and fail a
correct database.

Compute the repository's expected hash list — the hashes the runner records
are `sha256` of each migration **file's bytes**, computed exactly as the
runner computes them:

```bash
node -e "const fs=require('fs'),c=require('crypto');const j=JSON.parse(fs.readFileSync('drizzle/meta/_journal.json','utf8'));for(const e of j.entries){const h=c.createHash('sha256').update(fs.readFileSync('drizzle/'+e.tag+'.sql','utf8')).digest('hex');console.log(e.idx, e.when, h)}"
```

> **Do not compare against the `hash` field embedded in
> `_journal.json`.** That field is stale for idx 42, 47 and 51 (those files
> were amended after the field was written) and the runner never reads it.
> The only valid comparison is: database `hash` values vs the file-byte
> hashes printed by the command above.

**Pass criteria — the production state is an exact journal prefix.** There
exists a K such that: `applied_count` = K; the database rows, in `id` order,
carry exactly the file-byte hashes of idx 0…K−1 **and** each row's
`created_at` equals that entry's `when`; and `max_created_at` is the largest
`when` among idx 0…K−1 (not necessarily idx K−1's own, for the reason above).
The runner performs the same verification and refuses (exit `3`) anything
else; Step 0 is the operator's independent check before any write. For the
state project records describe, K = 45
rows: count `45`, max_created_at `1791111413392`, last hash
`44fedb2f8e658d709156c6d4ac7482aa31dde45608ba921674d01b2329d7c6d4`
(idx 44, `0044_workflow_engine`). Any other clean prefix (a different K) is
also workable — the pending chain is then idx K…76 — but record the
difference prominently; it means the 2026-10-06 run (or another act) applied
more than the records show.

**STOP conditions — do not proceed, escalate to Nani for a founder decision:**

- The hash list is **not** a prefix of the repo list (a hash differs, a row
  is missing mid-chain, or there are rows the repo journal does not know).
- `drizzle.__drizzle_migrations` does not exist (production predates the
  journal entirely — a different situation from a prefix state).
- Count and max disagree with each other (e.g. count implies one K, the
  ordered hashes imply another).
- Anything else you cannot explain from the journal. Improvisation at this
  step is how production incidents start.

Record the full query output in the run record.

## Step 1 — Freeze and snapshot

1. Announce the freeze window to everyone with production write access:
   no application writes, no manual SQL writes, no other operator activity
   against production from freeze start until Step 4 completes and the
   freeze is formally lifted. (Writes made during a later disaster-repoint
   would be lost — the freeze is what makes that acceptable; see
   [Failure doctrine](#failure-doctrine-binding).)
2. In the Neon console, create a **branch of the production branch** at the
   current timestamp, named:

   ```
   pre-migration-<YYYY-MM-DD>-<target-idx>
   ```

   For the V1 run the target idx is 72, e.g. `pre-migration-2026-11-03-72`.
3. Record the new branch's **branch id** (`br-…`) in the run record.

This branch — not the timestamp — is the rollback asset. Neon's point-in-time
history window is 6 hours; a timestamp repoint is only possible inside that
window, while the branch, once created, is a durable copy that persists
until deliberately deleted. Do not delete it at the end of a successful run;
its retention is part of the HG-7 backup decision.

## Step 2 — Rehearse on the snapshot branch

Production is **not touched** in this step.

1. Get the snapshot branch's connection string: **direct** endpoint, role
   `app_owner`. In your shell only:

   ```bash
   export DATABASE_URL_MIGRATE='<snapshot branch direct URL as app_owner>'
   node scripts/migrate-ws.mjs
   ```

   Sanity-check before running: the URL's endpoint/branch must be the
   **snapshot branch's**, not production's. If in doubt, stop and re-check —
   this is the one typo that turns a rehearsal into an incident.

2. Expected runner output shape (for the recorded 0044 state):

   ```
   journal entries: 77, last applied created_at: 1791111413392
   verified history: 45 of 77 entries match the repository (idx 0-44, through 0044_workflow_engine)
   applying idx 45 0045_automation_jobs (… statements)
   …
   applying idx 76 0077_deal_history_and_org_identity (… statements)
   applying idx 77 0078_audit_history_truncate_guard (… statements)
   applying idx 78 0079_rate_limit_first_use (… statements)
   applying idx 79 0080_organization_types (… statements)
   done: applied 35, total 80
   ```

3. **Success criteria — all four must hold:**
   - The runner exits `0`.
   - Re-running the Step 0 queries **against the snapshot branch** shows the
     full repo state: count `80`, max_created_at `1791595728057`, and the
     hash list in `id` order equal to the file-byte hashes of idx 0…76.
   - The phase regression suites relevant to the newly applied migrations
     (jobs/scheduler, workflows, notifications, search, AI, integrations,
     security hardening, project members, task reminders, db maintenance, worker next-due, admin audit, job and schedule principals (jobs RLS, jobs audit atomicity), deal-stage history and organization identity (CRM pipelines, organizations)) run green against the branch, or in CI's equivalent
     from-empty shape. Note what this rehearsal proves that CI cannot: the
     **upgrade path** — the chain applied over lived-in 0044 data, not over
     an empty database.
   - No unexplained warnings in the runner output.

4. **On any failure:** stop. The fix is a new PR carrying a new or corrective
   migration (forward-fix only), then a **fresh snapshot** (Step 1 again —
   never re-rehearse on a branch a failed attempt already mutated) and
   Step 2 again. Production remains untouched throughout.

## Step 3 — Apply to production (operator act, HG-2)

Preconditions — all must be true, checked in order:

- [ ] Step 2 rehearsal is green against a snapshot of the **current**
      production state (if production changed since the rehearsal, redo
      Steps 1–2).
- [ ] The write freeze from Step 1 is in force.
- [ ] HG-2 approval is recorded in the run record.

Immediately before applying, verify **twice**:

1. **The URL names production.** `DATABASE_URL_MIGRATE`'s endpoint/branch id
   is the production branch (`br-billowing-grass-b3e7ckaz` per project
   records — re-verified in the console during Step 0), direct endpoint,
   role `app_owner`.
2. **The state is unchanged.** Re-run the Step 0 queries against production;
   the result must be identical to Step 0's recorded output. If it differs,
   STOP — someone or something wrote to production since Step 0; return to
   Step 0 and re-plan.

Apply:

```bash
export DATABASE_URL_MIGRATE='<production direct URL as app_owner>'
node scripts/migrate-ws.mjs 2>&1 | tee migration-run-output.txt
```

Capture the runner's **complete output verbatim** into the run record,
including the applied idx list and the final `done:` line. Exit `0` →
proceed to Step 4. Exit `2` or `1` → production is at a whole-migration
boundary; do not retry, do not improvise — go to
[Failure doctrine](#failure-doctrine-binding) and record the failure. Exit `3`
→ the runner refused (its `REFUSED:` line says why). Read the next line before
anything else: `Nothing was applied.` means it refused before applying — the
history is not the clean prefix Step 0 recorded, or another run holds the lock.
`N migration(s) committed earlier in this run; nothing after them.` means the
history changed while it was applying: those N whole migrations (the first N
`applying idx` lines of the captured output) are on production — record them as
applied in the run record. STOP either way; return to Step 0 and escalate to
Nani.

**Closeout (after a successful Step 4):** close PR #60 as superseded by this
runbook, referencing the run record. This is a human act under HG-2; it is
part of release-checklist item 12.

## Step 4 — Post-apply verification

All checks must pass before the freeze is lifted.

1. **Journal == repo.** Re-run the Step 0 queries against production:
   count `80`, max_created_at `1791595728057`, hash list in `id` order equal to
   the file-byte hashes of idx 0…76 (same comparison method as Step 0).
2. **Application-level check.** Once the app is deployed against production:

   ```bash
   curl -s -H "x-pravshi-health-token: $HEALTH_CHECK_TOKEN" https://<production-host>/health/db
   # expect: 200 {"status":"ok","wake_ms":…}
   ```

   (Without the token the endpoint deliberately returns 404.) If the app is
   not yet deployed, instead run a role-connect check in the
   `scripts/db/run.mjs --verify-roles` shape against production: `app_user`
   connects, role attributes match `scripts/db/roles.sql`, and RLS is live.
3. **Worker role (0070).** As the owner, confirm `app_worker` is a plain login with no
   membership (see the note below the queries), that `app_user` can no longer claim jobs, and
   that `app_worker` can:

   ```sql
   select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
     from pg_roles where rolname = 'app_worker';            -- expect: t f f f f
   select count(*) from pg_auth_members am join pg_roles m on m.oid = am.member
     join pg_roles r on r.oid = am.roleid
    where m.rolname = 'app_worker'
       or (r.rolname = 'app_worker'
           and (am.member <> (select datdba from pg_database where datname = current_database())
                or m.rolname like 'app\_%'));               -- expect: 0
   select has_function_privilege('app_user',   'public.jobs_claim_next(text,text[])', 'execute'),
          has_function_privilege('app_worker', 'public.jobs_claim_next(text,text[])', 'execute');
                                                            -- expect: f | t
   select has_function_privilege('app_user',   'public.jobs_run_cleanup(uuid,text)', 'execute'),
          has_function_privilege('app_worker', 'public.jobs_run_cleanup(uuid,text)', 'execute');
                                                            -- expect: f | t  (0071)
   ```

   **Membership rule (0070, 0072, 0073).** The role is a member of no role (it inherits
   nothing), and no role is a member of it (none can `SET ROLE` into it) except the database
   owner, and only when the owner is not an application role. On PostgreSQL 16+ a
   non-superuser that creates a role is automatically granted ADMIN on it, and Neon's branch
   owner — which runs `roles.sql` — is not a superuser (`scripts/db/run.mjs` also adds SET and
   INHERIT). The owner cannot revoke that grant and already administers the branch, so it
   widens nothing; every other membership still fails the migration and this check. The pooler
   probe (`scripts/ops/auth-pool-probe.mjs`) applies the same rule, in both directions, to
   `app_user`, `app_worker` and `app_auth` through their pooled logins (`identity.<VARIABLE>`
   `membership_ok` and `members_ok`; procedure `docs/runbooks/auth-pool-probe.md`).

   Then, from the worker host, through the **pooled** endpoint it will really use
   (`DATABASE_URL_WORKER`), `select session_user` must answer `app_worker` — the worker
   performs this check itself at start and exits with a message if it fails. This
   pooler check has **not yet been run against Neon by the package author** (only through
   CI's local proxy): it is a required operator step on the first branch that receives 0070.
   Finally, the worker's log shows `[worker] starting …` and queued work drains.
   **Authentication role (0072/0073).** As the owner, confirm `app_auth` is a plain login with
   no membership, that `app_user` holds nothing in the `auth` schema, and that the pre-login
   functions are `app_auth`'s alone:

   ```sql
   select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
     from pg_roles where rolname = 'app_auth';              -- expect: t f f f f
   select count(*) from pg_auth_members am join pg_roles m on m.oid = am.member
     join pg_roles r on r.oid = am.roleid
    where m.rolname = 'app_auth'
       or (r.rolname = 'app_auth'
           and (am.member <> (select datdba from pg_database where datname = current_database())
                or m.rolname like 'app\_%'));               -- expect: 0 (membership rule above)
   select has_schema_privilege('app_user', 'auth', 'usage'),
          has_table_privilege('app_user', 'auth.auth_accounts', 'select'),
          has_table_privilege('app_auth', 'auth.auth_accounts', 'select');
                                                            -- expect: f | f | t
   select has_function_privilege('app_user', 'authz.update_credential_password(uuid,text)', 'execute'),
          has_function_privilege('app_auth', 'authz.update_credential_password(uuid,text)', 'execute');
                                                            -- expect: f | t
   select count(*) from pg_proc
    where proname in ('admin_session_action', 'admin_issue_credential_reset')
      and position('authz.person_visible(p.id)' in prosrc) > 0;
                                                            -- expect: 2 (0074)
   ```

   Then through the **pooled** endpoint Vercel really uses (`DATABASE_URL_AUTH`),
   `select session_user` must answer `app_auth` — the auth pool refuses any other login on
   first use, and `/health/db` (with the health token) answers 503 if it does not. Like the
   worker's, this pooler check has **not yet been run against Neon** (only through CI's local
   proxy): it is a required operator step on the first non-production branch that receives
   0072/0073 (`scripts/ops/auth-pool-probe.mjs`, procedure `docs/runbooks/auth-pool-probe.md`,
   record template `docs/runbooks/auth-pool-probe-record.md`). A test sign-in then succeeds.
4. Record every result in the run record.
5. Announce completion and **lift the freeze explicitly** — the freeze ends
   by announcement, not by assumption.

## Failure doctrine (binding)

Migrations are **forward-fix only**. The only down-migrations in this repo are
the six prepared rollback scripts described under (d) below (for 0073, 0075, 0077, 0078, 0079 and 0080),
each run only with Nani's explicit approval and a run-record entry; none are
invented at incident time.

- **(a) The failure is in a migration itself.** Fix via a new PR carrying a
  new or corrective migration; re-enter this runbook at Step 2 with a fresh
  snapshot. Production stays at its whole-migration boundary meanwhile; the
  already-applied prefix is valid state, not damage.
- **(b) Production is left in a state the application cannot run against.**
  Disaster path: repoint the application's `DATABASE_URL` to the Step 1
  snapshot branch and **escalate to Nani immediately**. Writes made since
  the freeze are lost — which is exactly why the freeze exists and why it is
  never skipped. The 6-hour timestamp repoint is a fallback inside its
  window only, never the plan; the snapshot branch is the plan.
- **(c) After 0070 the worker processes nothing.** Queued work waits; nothing is lost and
  the web app is unaffected. Read the worker's start-up log: a missing
  `DATABASE_URL_WORKER`, or one that does not authenticate as `app_worker`, stops the
  worker with a message saying so. Check the role exists and its password matches the
  variable, and that the URL uses the pooled host. Fix the configuration and restart the
  worker. **Never re-grant the worker functions to `app_user` to get going** — that
  re-opens the gap 0070 closes. A defect in 0070 itself is case (a).
- **(d) After 0073 nobody can sign in.** The web app still authenticating as `app_user` (an old
  build, or `DATABASE_URL_AUTH` missing or naming `app_user`) is refused with 42501 on every
  sign-in and session check — it fails closed; nothing is exposed. Deploy the build that uses
  `DATABASE_URL_AUTH`, or fix the variable (`/health/db` says which login it reaches).
  **The prepared exceptions to forward-fix:** `scripts/db/rollback/0073_auth_role_contract.down.sql`
  gives `app_user` back the credential store so an old build can sign people in again. It
  RE-OPENS the gap 0073 closes; it is run only with Nani's explicit approval for that step,
  recorded in the run record, and the contract is re-applied as soon as the new build is live.
  `scripts/db/rollback/0075_audit_partition_lock_order.down.sql` restores the 0062
  audit-partition maintenance body, for the case where 0075's NOWAIT acquisition keeps
  exhausting its retries under sustained load (worker log: `audit partition maintenance failed`,
  sqlstate 55P03, then `audit partition window ends soon`). It brings back the 0062 lock order —
  maintenance waiting while holding `audit_logs`, deadlocking or stalling audited writes while a
  partition is created — so it too needs Nani's explicit approval and a run-record entry.
  `scripts/db/rollback/0077_deal_history_and_org_identity.down.sql` restores the 0076 state
  — `app_user`'s direct INSERT policy on `deal_stage_history` and a changeable organization
  id and slug — for the case where something legitimate turns out to depend on either. It
  RE-OPENS MT-L6 and MT-L1, so it needs Nani's explicit approval and a run-record entry.
  `scripts/db/rollback/0078_audit_history_truncate_guard.down.sql` restores the 0077 state —
  0075's `ensure_audit_log_partitions()` verbatim and no TRUNCATE guard on the history — for the
  case where something legitimate needs to truncate audit history. It RE-OPENS MT-L3.
  `scripts/db/rollback/0079_rate_limit_first_use.down.sql` restores 0024's `check_rate_limit()`
  verbatim, for the case where the upsert form misbehaves; it RE-OPENS FU-3 (concurrent first
  uses fail with 23505). Each needs Nani's explicit approval and a run-record entry.
  `scripts/db/rollback/0080_organization_types.down.sql` restores the 0079 state — no
  organization-type catalog or templates, no recorded type or version, and 0039's hard-coded
  default pipeline. It refuses while any organization is on anything but `generic_crm` version 1,
  keeps pipelines already seeded, and needs Nani's explicit approval and a run-record entry.

## Abort criteria (any step)

Stop the run, keep the freeze in force until Nani directs otherwise, and
record the abort if: any STOP condition fires; any verification disagrees
with its expected value; the runner exits non-zero; the wrong branch/URL is
suspected at any point; or the operator is unsure. An aborted run with a
complete record is a success of process; a continued run on a doubt is not.

## Appendix A — The pending chain (idx 45–79)

As of this runbook's writing, assuming the Step 0 boundary at idx 44
(`0044_workflow_engine`, `when` 1791111413392, file hash
`44fedb2f8e658d709156c6d4ac7482aa31dde45608ba921674d01b2329d7c6d4`).
Hashes below are `sha256` of the migration file's bytes — the values the
runner records in `drizzle.__drizzle_migrations` when it applies each one.
Regenerate them with the command in Step 0 rather than trusting this table
after any repo change.

**0070, 0072 and 0073 were corrected in place on 2026-10-15** (the role-membership rule — see
Step 3, "Membership rule"). No persistent database is known to have recorded the original
migration files based on the available evidence. The previous development database has not been
checked. If that database is reused, follow Step 0 and stop if its migration hashes or history do
not match the expected state.

The evidence, and its limits: CI has migrated only its own throwaway Postgres since 2026-10-09
(0070 was first committed on 2026-10-12); project records place production at idx 44, which is
unverified until Step 0; and the current development database's journal ended near idx 63 when
it was checked read-only. Any database that recorded the earlier bytes of those three files would
show a hash mismatch on exactly those rows in Step 0: that is a STOP condition — escalate, do not
re-apply.

| idx | tag                                    | `when`        | sha256 (file bytes)                                                |
| --- | -------------------------------------- | ------------- | ------------------------------------------------------------------ |
| 45  | `0045_automation_jobs`                 | 1791248285590 | `925045e968732f0956abda1c263e92c598133f400c405be61be1dd119407baec` |
| 46  | `0046_scheduler_tick`                  | 1791248285591 | `9116be1d2891e19037449878b9b8270758ac13e46e4f0c11baa67363bf39b1ae` |
| 47  | `0047_notifications`                   | 1791248326409 | `1cccaf1d4d9183544909af25707bf5b9c80374506926a60e94e2c33a3d662b04` |
| 48  | `0048_workflow_job_execution`         | 1791249691113 | `9eb57a9360acd3e2b3f42298403d203da9fb64119509c2a7050140f2ccf590fa` |
| 49  | `0049_worker_plane_sweep`              | 1791252339662 | `f9f6fe6ab698143997565b0c95ae41db147bfbf4a4b9835acc2c8abb098fe9fa` |
| 50  | `0050_worker_plane_release`            | 1791252763750 | `3ef846714a55a140b8f2310b8056181a75d821d47920eef93d7083db30feb99e` |
| 51  | `0052_notifications_phase8`            | 1791343891087 | `55350527cb355eafd20aa12106a7ebf19ece00b7234bc6d642a15671da82b79e` |
| 52  | `0053_search_indexes`                  | 1791343891088 | `d094788e8bc43ce964765b993bbb1b53dfb79ed7b49977cf205fa1be3e4f1468` |
| 53  | `0054_ai_foundation`                   | 1791343891089 | `d2eef8cefcb0f00d46751e9d0cf16049a86ad011613703955b1d8142dd214875` |
| 54  | `0055_ai_permissions`                  | 1791343891090 | `6d0096ffaefb73640fc081f375f01bb81f05e65b2654199b910c37d430b43acd` |
| 55  | `0056_integrations_schema`             | 1791343891091 | `f835af1e10b9ea682f3cd13d482596b098fe95064f79bf95eb1e32c413a17735` |
| 56  | `0057_integrations_permissions`        | 1791343891092 | `99a7359182a185cab72f943f25090034616370b19b2cdcc908f6560e79017a0e` |
| 57  | `0058_inbound_endpoint_key`            | 1791343891093 | `81eb63bfa9c2b14959f3f8afb640474c75fcc4c1b54a0c13384ce3807c25d3b0` |
| 58  | `0059_webhook_delivery_resolution`     | 1791343891094 | `e7175a7bdc41fbf3d26f772c01850abd04892a738d755c9e17d9f068a07b5cfd` |
| 59  | `0060_integrations_write_plane`        | 1791343891095 | `52e99fe49d8216cb21f8289a18828ba041afe6dbe0af0867a780ca360cf64de4` |
| 60  | `0061_security_hardening`              | 1791343891096 | `18944fce1e413190bd48aac19143b7489cc11a1bbc6bf894c04ae479308ecb62` |
| 61  | `0062_audit_partition_maintenance`     | 1791343891097 | `401c18152b0f0eca75ff5b7b606a120b41f62964ecd32bd742c9397f9b5eb170` |
| 62  | `0063_project_member_policy_fix`       | 1791570729458 | `45aead55d56919e1f0c19f19db90cc1e651fd617817feaeba52affcb03cac246` |
| 63  | `0064_task_reminder_delivery`          | 1791579728057 | `fac6efbae4e1f0c1d831eb702ada30479c702a190773f11eb6a3283ef7dd6b39` |
| 64  | `0065_db_maintenance`                  | 1791580728057 | `83feafe58f56f8a2ee609d7b029739ba0d872265df6c0d155d8525263df4c69d` |
| 65  | `0066_worker_next_due` | 1791581728057 | `d0fe49560379f960ef2c5994371074007af36dfbfb28f0129c4afaaa2e9dbac6` |
| 66  | `0067_admin_audit_completeness` | 1791582728057 | `9b26f90ece4a2ad2c362bf89b28e262b1fc63e616c5f6f7659360add8c16fc55` |
| 67  | `0068_elevated_function_boundaries` | 1791583728057 | `ad13aa14ed4611a8b78e64640cef3ae9ce64a4adc5ee269431c311d9cf551209` |
| 68  | `0069_password_reset_email_content` | 1791584728057 | `0931683cfc7b407b044967f7b8d6e9d14f3011674e25765fdcb9a0bf5c99284c` |
| 69  | `0070_app_worker_role` | 1791585728057 | `31eb0f0139a0c94edcfe1348a72170b44c59542c2b620bbd12b9d9f59f54e4ad` |
| 70  | `0071_cleanup_job_worker_plane` | 1791586728057 | `593e317c1d66cfcd1ddec6dc85b0c92eff661805ee23baf262ef0de95626d51d` |
| 71  | `0072_auth_role_expand` | 1791587728057 | `547c0cfb5eb11b3a4ddfed556a95449563834d732fbfd24b6827dba7bf3c7143` |
| 72  | `0073_auth_role_contract` | 1791588728057 | `f1ab5b224b5051d9b278d46f915fbc87cc336a64b8a6bad68ac2f483beb3b9a4` |
| 73  | `0074_admin_target_visibility` | 1791589728057 | `3f485a690d7bee8438428b4214712db7062261264b28a5469d7dddab972d8c53` |
| 74  | `0075_audit_partition_lock_order` | 1791590728057 | `b31ce1bf74ba925cebdf486ee3a03cf3dc2fb60350b2ba947bc02b58dad8a9e0` |
| 75  | `0076_job_schedule_principal_binding` | 1791591728057 | `3a2ebbfbaaee84a595d7e8cad516b24ef7527c2dd645b386a8a457e93c925de6` |
| 76  | `0077_deal_history_and_org_identity` | 1791592728057 | `94ba7dcbacf4d91c46932006aa74ec51672f7925d89cb1abb42b3c564f6b8fc2` |
| 77  | `0078_audit_history_truncate_guard` | 1791593728057 | `283691fcf94bda9df7290fa4d74240238d9ff4767e6cea90a49f048cda1e82b2` |
| 78  | `0079_rate_limit_first_use` | 1791594728057 | `29fd79c1d77320849edaf43d3ef38dce96876ac73b16e647be58546fd1b41a5e` |
| 79  | `0080_organization_types` | 1791595728057 | `b7f9a5738d5073509ae5d266ab8ffaeb5b1983571adbfd5727afbdae2ffe6d91` |

(Note the numbering: there is no `0051_*.sql` in the journal — the file that
once carried that number was a dormant, never-journaled artefact retired in
Phase 11. The journal, not the file numbering, is the chain.)

Final expected state after a complete run: count `80`,
max_created_at `1791595728057`.

## Appendix B — Run record template

Copy this block into the run record for **every** execution (including
rehearsals-only runs and aborts) and fill in every field. "n/a" with a
reason is a valid entry; a blank field is not.

```markdown
### Production migration run — <YYYY-MM-DD>

- Operator:
- Second/contact:
- Approvals: HG-2 recorded by / at / covering target idx:
- Release commit (repo checkout used):
- Freeze: announced at / lifted at:
- Step 0 — production state as found:
  - applied_count:
  - max_created_at:
  - ordered hash list matches repo prefix idx 0…K−1: yes/no (K = )
  - deviations from project records (expected 0044 boundary):
- Step 1 — snapshot branch: name / branch id:
- Step 2 — rehearsal:
  - runner exit code:
  - branch journal == repo journal: yes/no
  - regression suites run + result:
- Step 3 — apply:
  - pre-apply re-verification (URL branch id + state re-read): done at
  - runner exit code:
  - runner output (verbatim, or link to captured file):
- Step 4 — verification:
  - journal == repo (count 80 / max 1791595728057 / hashes): yes/no
  - /health/db result (or role-connect check if app not deployed):
- Outcome: completed / aborted at step … / failed at step …
- Failure doctrine invoked: none / (a) forward-fix PR #… / (b) disaster repoint
- PR #60 closed as superseded: yes/no (after successful Step 4)
- Follow-ups / notes:
```
