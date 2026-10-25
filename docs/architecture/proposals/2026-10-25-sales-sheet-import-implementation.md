# Sales Sheet import (BP-06) — implementation record

**Status:** implemented and verified on disposable local PostgreSQL 18.6 only (not Neon); local
commit, unpushed, unmerged. **Not ready for real imports:** the column mapping is a documented
stand-in until the founder supplies the real Sales Sheet (proposal §7: Q1, Q2, Q4, Q9).

**Requirements status:** built from the requirements proposal
`docs/architecture/proposals/2026-10-16-sales-sheet-import.md`, on branch
`docs/v1-founder-decisions` — **unmerged and still marked "PROPOSAL — pending founder review. Not
approved."** The founder authorized building the stored half against the documented sample
(2026-10-24, 2026-10-25). Every choice below that answers an open question is pending
confirmation (§2).

Date: 2026-10-25 · Migration **0081** (journal idx 80) on top of 0077–0080 (all local).

## 1. What is built

| Part | Where | Acceptance criteria |
|---|---|---|
| CSV reading, mapping, row rules, preview (pure) | `src/lib/import/sales-sheet/{csv,mapping,rows,preview}.ts` | AC-F1–F4, AC-P1–P4, AC-D1–D5, AC-C4 |
| Import records, rows, guards, RLS, `crm.import`, `crm_import` job type, worker-plane definers | `drizzle/0081_crm_imports.sql` | AC-S2–S4, AC-I2, AC-C3, AC-A2, AC-A3 (storage) |
| Preview + record, confirm, cancel, read, failed rows | `src/lib/import/sales-sheet/service.ts` | AC-P3, AC-I1, AC-I3, AC-A1 (started) |
| Background commit and job handler | `src/lib/import/sales-sheet/{commit,job}.ts` | AC-C1, AC-C2, AC-I2, AC-A1, AC-A2 |
| Abandoned-import sweep | `src/lib/jobs/maintenance.ts` (`failAbandonedImports`) | stuck imports |
| HTTP API | `src/app/api/crm/imports/**` | AC-S1 |

Not built: the UI (frontend task), retention of import records (E3), the real mapping.

## 2. Choices made where the founder has not decided — PENDING CONFIRMATION

| # | Question | Implemented | Founder question |
|---|---|---|---|
| E1 | Partial failure | Valid rows commit; a failing row fails alone (savepoint per row) and is reported | Q3 |
| E2 | Rows without a resolvable owner | Row error; no default owner | Q5 |
| E3 | Retention of import records | `expires_at` = 90 days recorded; **no sweep removes imports yet** | Q7 |
| E4 | Who may import | `crm.import` to SUPER_ADMIN and ADMIN at GLOBAL only | Q8 |
| E5 | Re-imports | Never update existing records. A file already imported **or being imported** (queued, running, completed) is refused unless `allowReimport` | Q6 |
| E6 | `crm.import` sensitivity | Sensitive (like the exports): a GLOBAL holder needs MFA (aal2) | — |
| E7 | Queueing the commit | Confirm also requires `jobs.create` (the job goes through the normal jobs policy) | — |
| E8 | Owner assignment | A record is created with the importer as owner, then handed to the row's owner through the CRM's own owner-reach rule. The routes check only the create permissions (AC-S1); a row whose owner is outside the importer's `*.edit` reach, or that needs `*.view` the importer lacks, fails with a reason | — |
| E9 | Workflows | Imported deals do **not** fire `deal.created` workflow events | open |
| E10 | Notes / activities | Not imported: the stand-in mapping has no notes column | Q2 |
| E11 | Preview counts with possible duplicates | The counts describe a commit with nothing included: a row with a possible duplicate counts only its possible duplicates. Including rows can change later rows' outcomes; the commit's counts are final | — |
| E12 | `crm.import` below GLOBAL | A GLOBAL holder sees every import of the organization; a holder at any narrower scope sees only the imports they created (source rows hold personal data). Seeded grants are GLOBAL only | Q8 |
| E13 | Who confirms or cancels | The importer only (other holders get 403 `NOT_IMPORTER`); a `crm_import` job is never cancelled through the jobs API — the import is cancelled through its own route before it runs | — |
| E14 | Including a possible duplicate | A row whose possible-duplicate company would be re-created while its contact belongs to the existing one is **not includable** (confirm refuses it). Including other rows can make a *later* row fail (it may then meet a contact or company the included row created); the failure is reported per row. **Whether "include" should re-plan the rest of the file is a product decision — NEEDS-HUMAN** | open |

## 3. Duplicate rules (preview and commit apply the same)

- A row with any possible duplicate is **skipped unless the user includes it**, and until then
  creates nothing a later row could link to.
- Company: an earlier committing row of the file with the same key → LINK; the same domain in
  the organization → LINK; the same name without a domain → POSSIBLE_DUPLICATE, **for every row
  that names it**; otherwise CREATE.
- Contact: likewise by email, and by name + company as a possible duplicate. An email that
  already belongs to a contact under another company — in the file or the organization — is a
  row error at preview, since the commit would refuse it.
- Deal: the same title + company + contact as a live deal or an earlier committing row →
  POSSIBLE_DUPLICATE; otherwise CREATE.
- Across imports: confirmations of the same file in one organization are serialised (advisory
  lock on organization + SHA-256), so two concurrent previews cannot both commit (AC-I1).
- Retries: each row is decided once (database guard); a non-row error rolls its whole batch
  back, and the retry resumes from the rows still pending (AC-I2).
- Matching sees only what the importer can see through RLS; a record an earlier row created and
  that is no longer visible fails the row rather than being duplicated.

## 4. Failures, retention and errors

- **An import never stays QUEUED or RUNNING without a recorded outcome.** The importer's commit
  records completion. When the importer can no longer see the import (lost `crm.import`), the
  worker records `FAILED` / `IMPORTER_NOT_PERMITTED` at once. When a job ends without an outcome
  (retries exhausted, dead-lettered, cancelled, or deleted), DB maintenance marks the import
  `FAILED` / `JOB_ENDED` on its next pass. An unknown mapping is `UNKNOWN_MAPPING`. Each failure
  writes `crm.import.failed`, attributed to the import's creator (no audit entry is ever
  actor-less). Failure reasons are fixed codes (a CHECK constraint). A failed import still
  reports the counts of the rows its committed batches decided (AC-C3).
- **A `crm_import` job is not cancelled by hand.** A database trigger and the jobs service refuse
  it: `jobs.cancel` holders could otherwise stop someone else's import half-way.
- **Job retention keeps working.** Deleting a job an import references (retention, the cleanup
  job, an operator) clears only the import's `job_id`, and only once the job is really gone; the
  import and its audit entries — which carry the job id — remain.
- **No imported value reaches a job error.** The handler replaces every error with a fixed
  message, the job id and the SQLSTATE before the worker stores it in `jobs.error_message`.
  Row errors carry reasons and constraint names, never values; audit entries carry ids, file
  name, hash, counts or a reason code.

## 5. HTTP contract (for the frontend)

All routes: standard `withPermission` envelope for 401/403; `crm.import` on every route.

| Method and path | Also requires | Body | Success | Refusals |
|---|---|---|---|---|
| `POST /api/crm/imports?fileName=<name>` | companies.create, contacts.create, deals.create | CSV bytes (≤ 5 MB) | 201 import view (`PREVIEWED`) | 413 `FILE_TOO_LARGE`; 422 `{error}` for a refused file (`NOT_UTF8`, `TOO_MANY_ROWS`, `TOO_MANY_COLUMNS`, `MISSING_REQUIRED_COLUMNS`, `DUPLICATE_HEADERS`, `EMPTY_FILE`, `UNTERMINATED_QUOTE`); 400 bad file name |
| `GET /api/crm/imports/:id` | — | — | 200 import view | 404 |
| `POST /api/crm/imports/:id/confirm` | the three create permissions, jobs.create | `{ fileSha256, counts, includeRows?, allowReimport? }` (≤ 256 KiB) | 202 import view (`QUEUED`); repeating returns the same import | 400 malformed; 403 `NOT_IMPORTER`; 413 `BODY_TOO_LARGE`; 409 `PREVIEW_MISMATCH`, `ALREADY_IMPORTED` (+ `earlierImportId`), `NOT_PREVIEWED`; 422 `INVALID_INCLUDE`; 404 |
| `POST /api/crm/imports/:id/cancel` | — (importer only) | — | 200 import view (`CANCELLED`) | 403 `NOT_IMPORTER`; 409 once running; 404 |
| `GET /api/crm/imports/:id/failed-rows` | — | — | 200 `text/csv` | 404 |

The import view (`ImportView` in `service.ts`) carries status, file name and hash, preview counts
(`counts` is what confirm must echo), unknown headers, in-file conflicts, invalid rows (row
number, column, reason), possible-duplicate, not-includable (`preview.notIncludableRows`) and
included row numbers, final counts and `earlierImportId`. It never carries row values.

## 6. Evidence (local, disposable PostgreSQL 18.6 — not Neon)

- Fresh chain 0000–0081; a re-run applies nothing.
- Rollback → roll-forward, twice: equal to a fresh 0080 and a fresh 0081 on 8 order-stable schema
  fingerprints; the permission and every `crm_import*` function gone after each rollback. The
  rollback refuses on a database holding imports and changes nothing.
- Upgrade from K = 64 with representative data: every data table byte-equal; schema equal to a
  fresh 0081; `crm.import` backfilled to SUPER_ADMIN and ADMIN of every organization.
- Index evidence: on a 10,000-row import, the earlier-row lookup is an index scan reading 3
  buffers with `crm_import_rows_company_key_idx`, a sequential scan reading 87 buffers and
  filtering 4,998 rows without it — per row.
- Tests: `tests/db/crm-imports.test.ts`, `tests/serial/crm-import-retention.test.ts`,
  `tests/serial/crm-import-error-sanitising.test.ts`, `tests/integration/crm-imports-routes.test.ts`,
  `tests/import/sales-sheet.test.ts`, `tests/guards/rollback-0081-restores-0080.test.ts`. Mutation
  checks — each fails its test: the sanitizer bypassed; the retention exception removed; the
  importer-only rule removed; `crm.import` dropped from the select policy; the GLOBAL-or-own scope
  clause removed; the jobs cancel trigger dropped with the service check bypassed; `deals.create`
  dropped from the route check.
- Two independent review rounds (security, migration, code). Round 2's findings are fixed in this
  change, except E14 (a product decision).

## 7. Known limits and follow-ups

- **Release blocker:** the real mapping (proposal §7). The stand-in must not be used on
  production data.
- Retention of import records (E3) — a separate approved change.
- An abandoned import is failed on the next maintenance pass, not instantly.
- AC-T3 (end-to-end through a browser) and AC-T5 (rehearsal with the real export) are not done.
