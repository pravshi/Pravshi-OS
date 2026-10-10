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

It reads `drizzle/meta/_journal.json`, compares `max(created_at)` in
`drizzle.__drizzle_migrations`, and applies each pending migration in its own
real transaction on one connection, recording `sha256(file)` per migration. A
failed migration rolls back whole — production can only ever be left at a
whole-migration boundary, never with partial DDL. Exit codes: `0` = success,
`2` = a migration failed and was rolled back, `1` = the runner itself errored.
Do not use any other tool, workflow, or hand-written SQL to apply migrations.

## Ground rules (binding)

1. **Verify, never assume.** Project records say production is at migration
   0044, but that state is recorded nowhere in the database's own records
   available to this repo, and the failed 2026-10-06 run may have applied
   migrations before failing. Step 0 establishes the true state before
   anything else happens, and the runbook branches on what Step 0 finds.
2. **Forward-fix only.** No down-migrations exist in this repo and none are
   invented at incident time. Every failure is fixed by a new PR and a new or
   corrective migration, rehearsed again from Step 2.
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
      # expected at the current release: 64 63 0064_task_reminder_delivery
      ```

- [ ] Access to the Neon console for the production project
      (`floral-base-77155861`, production branch `br-billowing-grass-b3e7ckaz`,
      endpoint `ep-tiny-butterfly-b3ue8x2a` — **per project records; re-verify
      all three in the console during Step 0 before relying on them**).
- [ ] The production `DATABASE_URL_MIGRATE` value: the **direct** (non-pooled)
      endpoint for the production branch, as role **`app_owner`**. Assemble it
      in your shell only; never commit it, paste it into the run record, or
      put it in a file that leaves your machine.
- [ ] **Calendar gate:** any step that touches Neon (Steps 0–4) consumes the
      Neon allowance. Before **2026-11-01** these steps are written but not
      executed, unless Nani directs otherwise.

## The chain as of writing

The repo journal holds 64 entries (idx 0–63). Per project records, production
last applied **idx 44** (`0044_workflow_engine`), so the pending chain is the
19 migrations **idx 45–63 (0045–0064)** listed in
[Appendix A](#appendix-a--the-pending-chain-idx-4563). Step 0 verifies this;
if Step 0 disagrees, the appendix is not evidence — Step 0's output is.

One mechanical fact the operator should know: the runner selects what to
apply by `when > max(created_at)`. In the pending segment, `when` values are
strictly increasing and all greater than idx 44's `when` (1791111413392), so
the runner will select exactly idx 45–63 — no more, no fewer.

## Step 0 — Verify current production state (read-only)

Run these two queries against the **production branch** (Neon console SQL
editor, or another approved read-only path). Change nothing.

```sql
select count(*) as applied_count, max(created_at) as max_created_at
from drizzle.__drizzle_migrations;

select id, hash, created_at
from drizzle.__drizzle_migrations
order by created_at, id;
```

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
exists a K such that: `applied_count` = K, `max_created_at` = the `when` of
journal idx K−1, and the ordered database hash list equals the file-byte
hashes of idx 0…K−1 exactly. For the state project records describe, K = 45
rows: count `45`, max_created_at `1791111413392`, last hash
`44fedb2f8e658d709156c6d4ac7482aa31dde45608ba921674d01b2329d7c6d4`
(idx 44, `0044_workflow_engine`). Any other clean prefix (a different K) is
also workable — the pending chain is then idx K…63 — but record the
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

   For the V1 run the target idx is 63, e.g. `pre-migration-2026-11-03-63`.
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
   journal entries: 64, last applied created_at: 1791111413392
   applying idx 45 0045_automation_jobs (… statements)
   …
   applying idx 63 0064_task_reminder_delivery (… statements)
   done: applied 19, total 64
   ```

3. **Success criteria — all four must hold:**
   - The runner exits `0`.
   - Re-running the Step 0 queries **against the snapshot branch** shows the
     full repo state: count `64`, max_created_at `1791579728057`, and the
     ordered hash list equal to the file-byte hashes of idx 0…63.
   - The phase regression suites relevant to the newly applied migrations
     (jobs/scheduler, workflows, notifications, search, AI, integrations,
     security hardening, project members, task reminders) run green against the branch, or in CI's equivalent
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
[Failure doctrine](#failure-doctrine-binding) and record the failure.

**Closeout (after a successful Step 4):** close PR #60 as superseded by this
runbook, referencing the run record. This is a human act under HG-2; it is
part of release-checklist item 12.

## Step 4 — Post-apply verification

All checks must pass before the freeze is lifted.

1. **Journal == repo.** Re-run the Step 0 queries against production:
   count `64`, max_created_at `1791579728057`, ordered hash list equal to the
   file-byte hashes of idx 0…63 (same comparison method as Step 0).
2. **Application-level check.** Once the app is deployed against production:

   ```bash
   curl -s -H "x-pravshi-health-token: $HEALTH_CHECK_TOKEN" https://<production-host>/health/db
   # expect: 200 {"status":"ok","wake_ms":…}
   ```

   (Without the token the endpoint deliberately returns 404.) If the app is
   not yet deployed, instead run a role-connect check in the
   `scripts/db/run.mjs --verify-roles` shape against production: `app_user`
   connects, role attributes match `scripts/db/roles.sql`, and RLS is live.
3. Record every result in the run record.
4. Announce completion and **lift the freeze explicitly** — the freeze ends
   by announcement, not by assumption.

## Failure doctrine (binding)

Migrations are **forward-fix only**. No down-migrations exist in this repo
and none are invented at incident time.

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

## Abort criteria (any step)

Stop the run, keep the freeze in force until Nani directs otherwise, and
record the abort if: any STOP condition fires; any verification disagrees
with its expected value; the runner exits non-zero; the wrong branch/URL is
suspected at any point; or the operator is unsure. An aborted run with a
complete record is a success of process; a continued run on a doubt is not.

## Appendix A — The pending chain (idx 45–63)

As of this runbook's writing, assuming the Step 0 boundary at idx 44
(`0044_workflow_engine`, `when` 1791111413392, file hash
`44fedb2f8e658d709156c6d4ac7482aa31dde45608ba921674d01b2329d7c6d4`).
Hashes below are `sha256` of the migration file's bytes — the values the
runner records in `drizzle.__drizzle_migrations` when it applies each one.
Regenerate them with the command in Step 0 rather than trusting this table
after any repo change.

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

(Note the numbering: there is no `0051_*.sql` in the journal — the file that
once carried that number was a dormant, never-journaled artefact retired in
Phase 11. The journal, not the file numbering, is the chain.)

Final expected state after a complete run: count `64`,
max_created_at `1791579728057`.

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
  - journal == repo (count 64 / max 1791579728057 / hashes): yes/no
  - /health/db result (or role-connect check if app not deployed):
- Outcome: completed / aborted at step … / failed at step …
- Failure doctrine invoked: none / (a) forward-fix PR #… / (b) disaster repoint
- PR #60 closed as superseded: yes/no (after successful Step 4)
- Follow-ups / notes:
```
