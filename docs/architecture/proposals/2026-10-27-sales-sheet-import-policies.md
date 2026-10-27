# Sales Sheet import — permission, duplicates, retention and workflow policies

**Status: APPROVED DIRECTION** — [ADR-008](../adr/008-v1-platform-and-import-decisions.md), 2026-10-27.
Local implementation may proceed; every hosted step still needs its own approval. Remaining
founder inputs are listed in ADR-008 "Still open".

_Original status (superseded):_ PROPOSAL — pending founder confirmation. Policies 1 and 4 match what is implemented;
policies 2 and 3 need code that is **not** written yet, and policy 3's deletion is not to be
built until this proposal is approved.

Date: 2026-10-27 · Builds on the requirements proposal
[2026-10-16-sales-sheet-import.md](./2026-10-16-sales-sheet-import.md) and the implementation
record `2026-10-25-sales-sheet-import-implementation.md` (on the local branch
`feature/sales-sheet-import`; migration 0081). **The real Sales Sheet mapping is still not
known**: nothing here makes real imports production-ready.

## 1. `crm.import` — who may import (founder Q8; implementation E4, E6, E12)

**Recommendation — keep what is implemented:**

| Rule | Detail |
|---|---|
| Organization-scoped | `crm.import` is an ordinary organization permission; it opens only the holder's own organization's imports (forced RLS on `crm_imports`, `crm_import_rows`) |
| Seeded holders | `SUPER_ADMIN` and `ADMIN`, at GLOBAL. **Not** `SALES_MANAGER`, `SALES` or any other system role |
| Wider use | an organization administrator with `roles.manage` may grant it to a custom role, at any scope |
| Narrower than GLOBAL | sees and acts on only the imports that holder created (source rows hold personal data) |
| Sensitive | a GLOBAL holder needs a verified second factor (`aal2`) to confirm an import |
| Also required | the create permission of every table the file writes (companies, contacts, deals), `jobs.create`, and edit reach over each row's owner |
| Who confirms or cancels | the importer only |

**Attribution (unchanged):** the database stamps the importer as `crm_imports.created_by`; every
company, contact and deal is created as the importer (`created_by`), then handed to the row's
owner through the CRM's own owner-reach rule; each import row records the ids it produced; the
audit entries `crm.import.started` / `.completed` / `.failed` name the importer (a failure
recorded by the worker says `recordedBy: worker` in its metadata).

**Isolation (unchanged):** the background job resolves its principal only through
`crm_import_execute_as_job()` for the worker that holds that job, in the import's own
organization; a payload naming another import is refused.

## 2. Deterministic duplicate resolution with a re-planned preview (E14)

**Today:** the preview is computed once. At confirmation the importer may *include* rows marked
"possible duplicate"; the preview is not recalculated, so including a row can make a **later**
row fail at commit (it then meets a record the included row created). The failure is reported,
but the preview the importer approved was not what happened.

**Recommendation:**

1. **Resolve per key, not per row.** Possible duplicates are grouped by the key that matched
   (company key, contact key). For each group the importer chooses **skip** or **create new**;
   every row of the group follows that choice. (A per-row choice inside one group is what makes
   later rows contradict earlier ones.)
2. **Re-plan the remainder.** After each resolution the server recomputes the plan of every row
   in ascending `row_number`, with the same rules as the commit: an earlier row's planned record
   is what later rows of the same key link to; a skipped group registers nothing. The result is a
   new **preview revision** — counts, per-row plan, and its hash.
3. **Deterministic:** the same file, the same resolutions and the same database state give the
   same plan, byte for byte (fixed ordering, no clock or randomness in planning).
4. **Confirm binds to a revision:** confirmation names the revision hash it approves; a stale
   revision is refused. The recorded preview stays immutable: a revision is a new record, not an
   update.
5. **The commit still re-checks.** Records created by someone else after the preview still fail
   their rows individually (unchanged).

**Needs:** a migration (preview revisions or a resolutions table, and the guard that binds the
confirmation to a revision), service and route changes, and tests that a resolved group yields
zero commit-time failures caused by the file itself. Not built.

## 3. Retention (Q7, E3) — 90 days, provisional

**Today:** `crm_imports.expires_at` = 90 days is recorded; **nothing deletes anything**. Each row
keeps its source values (`crm_import_rows.source_values`), which contain personal data (names,
emails, phones) also present in the CRM records created from them.

**Recommendation — by data class:**

| Data | Keep | Then |
|---|---|---|
| Source values of rows decided CREATED, LINKED or SKIPPED | until the import reaches a final status | **cleared at completion** (minimisation: the data now lives in the CRM records, under their own rules) |
| Source values of FAILED rows | 90 days (needed for the failed-rows export and a corrected re-import) | cleared |
| Row results (status, error reasons, created ids, plan) | 90 days | deleted with the import |
| Import metadata (file name, SHA-256, mapping id, header, counts, status, importer, timestamps) | 90 days | deleted |
| Audit entries `crm.import.*` (ids, file name, hash, counts, reason codes — never row values) | **audit retention**, not import retention | unchanged by this policy |
| CRM records the import created, and their own audit history | the CRM's rules | never deleted by import retention |
| The `crm_import` job | the existing job retention (90 days) | unchanged |

**Mechanism (proposed, not built):** a worker-plane maintenance step through a SECURITY DEFINER
function, the pattern of the existing data retention (`drizzle/0065`): batch-limited; never
touches QUEUED or RUNNING imports; counts only in its logs; a dry-run mode that reports what it
would clear; one audit entry per run with counts. Deletion is irreversible, so it is built only
after this proposal is approved, and tested on disposable databases first.

**Open for the founder:** confirm 90 days (or another period); confirm that clearing source
values at completion is acceptable (it means a completed import's successful rows can no longer
be shown with their original cell values); any legal-hold requirement.

## 4. Imported deals and workflows (E9)

**Recommendation — keep what is implemented:** an imported deal does **not** emit `deal.created`,
so no workflow runs for it. A sheet of thousands of deals would otherwise fan out into thousands
of workflow runs — emails, webhooks, tasks — in minutes, for records that are historical.

**A safe opt-in, if wanted later (not V1):**

1. Chosen per import at confirmation (`runWorkflows: true`), only by a holder of `crm.import`
   who also holds `workflows.activate` (the permission that already governs turning workflows
   on); recorded on the import and in its audit entry.
2. The confirmation screen first shows a **dry run**: which ACTIVE workflows match `deal.created`
   and how many runs and external actions (emails, webhooks) would result.
3. Events go through the job queue with the per-deal deduplication key the CRM already uses, at a
   bounded rate, never inline in the commit transaction.
4. A hard cap per import (e.g. 500 runs); above it the opt-in is refused.
5. The existing chaining bound (D4) still applies; never retroactive for an import already
   committed.

## 5. Decisions requested

**Decided by ADR-008 (2026-10-27):** policy 1 (I-1), policy 2 for V1 (I-2), policy 4 (I-4).
Policy 3 (I-3): 90 days proposed; the cleanup is designed and tested but not enabled until its
rules and exclusions are approved.

| # | Decision | Recommendation | Blocks V1? |
|---|---|---|---|
| Q8 | Policy 1 | keep as implemented | no — confirm |
| E14 | Policy 2 | build it (per-key resolution, re-planned revisions) | **yes, if you want it in V1**; otherwise today's behaviour (later failures reported) ships |
| Q7 | Policy 3 | 90 days, source values cleared at completion, audit separate | **yes**: confirm the policy; the sweep is built after approval |
| E9 | Policy 4 | off; opt-in in V1.1 at the earliest | no |

Once confirmed, the decisions are recorded in ADR-008 with the platform decisions.
