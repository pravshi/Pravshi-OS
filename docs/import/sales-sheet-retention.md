# Sales Sheet import retention — design for approval

**Status: proposed, NOT enabled.** Nothing in the repository deletes or clears import data. The
rules below are encoded in a pure planner (`src/lib/import/sales-sheet/retention.ts`, tested in
`tests/import/retention-plan.test.ts`) so the policy can be reviewed against code; the cleanup
itself is a separate change that needs the founder's explicit approval of this exact policy
(open decision Q7).

## What an import holds

| Data | Where | Personal data? | Under this policy |
| ---- | ----- | -------------- | ----------------- |
| Import metadata — who, when, file name and SHA-256, mapping, status, counts | `crm_imports` | The importer's id; the file name may name a person | **Kept** — the record that the import happened |
| Row-level results — row status, ids of records created or linked, error reasons (never values) | `crm_import_rows` (minus values), `crm_import_row_plans` | No values | **Kept** |
| Raw spreadsheet values — every cell of every row | `crm_import_rows.source_values` | Yes: names, emails, phones, deal values | **Cleared** when due |
| Duplicate decisions — entity keys built from normalised names/emails | `crm_import_decisions` | Yes | **Cleared** (rows deleted) when due |
| The header row (column names) | `crm_imports.header` | No | Kept (0081 requires it) |
| Audit history — `crm.import.*` entries | `audit_logs` | Ids, counts, file name/hash | **Never touched**: audit has its own retention |
| CRM records the import created or linked | `companies`, `contacts`, `deals` | Business data | **Never touched** by import retention |

## When the clock starts

- **Finished imports** (completed, completed with errors, failed, cancelled): 90 days after the
  import reached that state (`completed_at`).
- **Never confirmed** (still `PREVIEWED`): 90 days after upload.
- **In progress** (`QUEUED`, `RUNNING`): never due. An abandoned import is first failed by
  `crm_import_fail_abandoned` (0081), which starts its clock.
- **Floor:** never earlier than `expires_at`, which 0081 records at upload (upload + 90 days). A
  final import without a completion time counts from its upload, never from "now".

Why not simply `expires_at`: it is fixed at upload, so an import confirmed or finished late
would lose its values sooner than 90 days after it finished.

## Failed imports

Treated as finished: their values are kept for 90 days after the failure — long enough to read
the failed-rows export and re-import — then cleared like any other. Their failure reason and
row errors are kept.

## How a cleanup would run (to be implemented only after approval)

- A worker maintenance step (beside `crm_import_fail_abandoned`), batched, limited per run,
  idempotent: clearing an already-cleared import changes nothing.
- One `SECURITY DEFINER` function on the worker plane, in its own migration, that for each due
  import: sets every row's `source_values` to `[]`, deletes its `crm_import_decisions`, and stamps
  a new `values_cleared_at` on `crm_imports` (0081's guard must allow exactly that change, and
  the row guard exactly the values change — both need a reviewed migration).
- **Audit:** one `crm.import.values_cleared` entry per import (ids and counts, never values) in
  the same transaction; a failed import is recorded as `crm.import.retention_failed` with a fixed
  code and retried next run; a run that fails as a whole leaves nothing half-cleared (one
  transaction per import).
- The failed-rows export of a cleared import answers "values no longer kept".

## Test plan for the cleanup change

Due/not-due boundaries per status (the planner's rules, against the database); values cleared
and metadata, results, plans, audit and CRM records unchanged; idempotent re-run; per-import
atomicity on failure; tenant isolation (a run never reads one organization's data on another's
behalf); the failed-rows export after clearing; an in-progress import never touched; the
retention audit entries; rollback of the migration.

## Decisions needed

1. Approve 90 days, and the clock as defined above (Q7).
2. Approve what is cleared versus kept (in particular: keep the file name, or clear it too).
3. Approve enabling the cleanup in production, as its own change.
