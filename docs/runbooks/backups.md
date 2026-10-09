# Runbook: Backups and restore drills

## Status — the interim truth

**There is no backup strategy yet.** The only recovery mechanism that exists today is a
Neon branch taken from a timestamp inside the current plan's **6-hour** history-retention
window. There is no scheduled backup, no point-in-time recovery beyond that window, no
restore drill has ever been run, and no RPO/RTO has been set. A production failure older
than 6 hours is, today, unrecoverable. ([DEPLOYMENT.md](../../DEPLOYMENT.md), "Backup and
restore", records the same posture.)

## The decision — HG-7 (Nani's, not an engineering default)

Choosing the backup mechanism and the loss/time tolerances is a founder decision (human
gate **HG-7**). Engineering prepares this record; engineering does not fill it in. The
mechanism choice follows from the RPO/RTO numbers, not the reverse.

### Decision record

Complete every field when the decision is made, and keep this section as the record.

| Field              | Value |
| ------------------ | ----- |
| Decision owner     | Nani (founder) |
| Decision date      | _pending_ |
| Mechanism          | _pending — one of the options below_ |
| RPO                | _pending — maximum acceptable data loss, expressed in time_ |
| RTO                | _pending — maximum acceptable restore duration_ |
| Retention          | _pending — how long backups are kept_ |
| Backup schedule    | _pending — frequency, if the mechanism is scheduled backups_ |
| Backup destination | _pending — plan/bucket and region_ |

Mechanism options:

1. **Upgrade Neon retention / point-in-time recovery** on the production project —
   extends the timestamp-restore window beyond 6 hours.
2. **Scheduled logical backups** of the production branch (`pg_dump`) to object storage —
   independent of the Neon plan; restore is a load, not a branch operation.
3. **Both** — PITR for short-window operational recovery, logical backups for long-window
   and provider-independent recovery.

## Restore drill procedure

A completed drill is part of the HG-7 gate: a backup that has never been restored is a
hope, not a backup. The drill never touches the live production branch.

1. **Restore into a new Neon branch.** Restore the chosen backup (timestamp restore or
   logical-backup load) into a **new** branch — never over the live branch.
2. **Point a preview deployment at it.** Configure a Vercel Preview deployment (or a local
   build) with `DATABASE_URL` naming the restored branch, as `app_user`, pooled.
3. **Run the smoke pack, items 1–5** from
   [smoke-tests.md](smoke-tests.md): `/health`, `/health/db` unauthenticated and
   token-authenticated, a real sign-in whose session persists, and one permission-gated
   page plus one permission-denied surface.
4. **Spot-check the data.** Confirm recent records match the backup's timestamp — the
   restored database must be the database the backup claims to be.
5. **Record the drill** (shape below). The elapsed restore time is the first real RTO
   measurement; compare it against the RTO in the decision record.

### Drill record

| Field            | Value |
| ---------------- | ----- |
| Drill date       | |
| Backup used      | (timestamp / backup id, and its age at restore) |
| Restored branch  | (branch name/id) |
| Elapsed restore  | (start → smoke pack green) |
| Smoke items 1–5  | pass / fail, with notes |
| Data spot-check  | what was checked, result |
| Operator         | |

## Drill schedule

- **Once before go-live** — part of gate HG-7; production data does not exist before this
  drill has passed.
- **Then once per release** — every release that ships to production re-proves the restore
  path, and the drill record is appended with the release's run record.

Until HG-7 is decided and one drill has run, a production go-live carries an explicitly
unmitigated data-loss risk.
