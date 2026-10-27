# Sales Sheet import into the CRM — requirements proposal

**Status: PROPOSAL — pending founder review. Not approved. Nothing here is implemented.**
Date: 2026-10-16 · Baseline: `main` @ `2e2d725` · Decision:
[ADR-007](../adr/007-v1-founder-product-decisions.md) BP-06 (the import is in the V1 launch scope)

The field mapping **cannot be finalised yet**: the Sales Sheet's columns are not recorded anywhere in
this repository. Section 7 lists what the founder needs to supply. Everything below that depends on
the mapping is marked **[MAPPING]**.

---

## 1. What the original plan said, and what exists now

**Build plan, Phase 3 (2026-09-06):** "export the Sheet → transform → import to staging → verify
counts and spot-check against source → import to production → set the Sheet read-only with a banner
pointing here → keep it as a 90-day fallback → archive. One-way. Never deleted." Exit: the sales
team works in Pravshi OS for a full week without opening the Sheet. The plan named tables (`leads`,
`clients`, `client_contacts`, `lead_activities`) that were **not** built in that form.

**The CRM as built** (verified in `drizzle/0033`–`0037`):

| Table | Required | Constrained | Uniqueness usable for matching |
|---|---|---|---|
| `companies` | `name` (not blank), `owner_person_id` (a person of the same organization) | `size ∈ {STARTUP, SMB, MID_MARKET, ENTERPRISE}`; `country_code` 2 letters, default `IN` | `domain` unique per organization among live rows |
| `contacts` | `first_name` (not blank), `owner_person_id` | `company_id` must be a company of the same organization | `email` unique per organization among live rows |
| `deals` | `title` (not blank), `owner_person_id` | `stage ∈ {NEW, QUALIFIED, PROPOSAL, NEGOTIATION, WON, LOST}`; `value ≥ 0`; `currency` 3 letters, default `INR`; `probability` 0–100; pipeline and stage must belong to the organization; the contact must belong to the deal's company | none |
| `activities` | `subject` (not blank), `entity_type ∈ {company, contact, deal}`, `entity_id`, `owner_person_id` | — | none |

Permissions exist per entity (`companies.create`, `contacts.create`, `deals.create`,
`activities.create`, `contacts.export`, `deals.export`, …). **No import permission, import code or
file-parsing dependency exists.** There is no file storage in V1 (ADR-006).

---

## 2. Scope

**In:** a one-way import of the Sales Sheet into companies, contacts and deals (and notes as
activities, if the sheet has them [MAPPING]) for **one organization at a time**, used for the
launch migration and available to that organization's authorised users afterwards.

**Out of V1:** two-way sync with the sheet; scheduled or automatic re-import; updating existing CRM
records from the file (see §4); importing other modules; Excel workbooks with several sheets,
formulas or macros.

---

## 3. Acceptance criteria

### 3.1 File format

- **AC-F1** One CSV file, UTF-8 (a byte-order mark is accepted), comma-separated, RFC 4180 quoting,
  a single header row. The sheet is exported to CSV; `.xlsx` is not parsed in V1 (no macro, zip or
  formula surface) — confirm with Q1.
- **AC-F2** Limits: at most 5 MB and 10,000 data rows per file (proposed; confirm with Q7). Larger
  files are refused before any row is processed, with the limit stated.
- **AC-F3** Header names are matched to the agreed mapping exactly after trimming and
  case-folding. A missing required column refuses the whole file before preview; unknown columns
  are listed and ignored.
- **AC-F4** Dates, amounts and percentages are parsed in one documented format each [MAPPING];
  an ambiguous date such as `03/04/2026` is never guessed — the format is fixed by the mapping
  (Q4).

### 3.2 Preview and validation (nothing is written)

- **AC-P1** Uploading a file produces a preview: per target table, how many rows would be created,
  how many match existing records (and how they would be treated), and how many are invalid — with
  every invalid row listed by row number, column and reason.
- **AC-P2** Validation applies the database's own rules before commit: required fields, enums,
  number ranges, currency and country codes, owner resolution, and relationships (a contact's
  company, a deal's company and contact, and pipeline and stage within the organization).
- **AC-P3** The preview writes nothing to CRM tables. The user must confirm it explicitly to
  commit; the confirmation is bound to the exact file (by its SHA-256) and the preview counts.
- **AC-P4** Owner resolution: each row's owner [MAPPING] is resolved to an ACTIVE person of the
  importing organization by email. An unresolved owner is a row error unless the founder chooses a
  default owner (Q5). The file can never name a person of another organization.

### 3.3 Duplicate detection and matching policy

- **AC-D1 Companies:** a row matches an existing live company of the organization when the domains
  are equal (case-insensitive; the database enforces uniqueness). Without a domain, an exact match
  on the normalised name (trimmed, case-folded, internal whitespace collapsed) is reported as a
  **possible duplicate** and is not created unless the user includes it explicitly in the preview.
- **AC-D2 Contacts:** a row matches an existing live contact when the emails are equal
  (case-insensitive; unique in the database). Without an email, an exact match on normalised full
  name **and** company is reported as a possible duplicate.
- **AC-D3 Deals:** no natural key exists. A deal is identified within an import by its source row;
  across imports, an identical file is caught by AC-I1. A deal with the same normalised title,
  company and contact as an existing live deal is reported as a possible duplicate.
- **AC-D4 Within the file:** two rows that resolve to the same company or contact create it once
  and link both rows to it; conflicting values between such rows are reported, and the first row
  wins only if the user accepts the preview.
- **AC-D5 Existing records are never modified in V1.** A matched record is linked to (for example,
  a new deal attached to an existing company) but its fields are not overwritten. Whether
  re-imports should update records is Q6.

### 3.4 Commit, errors and partial failure

- **AC-C1** Commit runs as a background job for the importing user, through the normal authorised
  data path (`withAuthorizedDb`), so every row write is subject to RLS and the same checks as the
  CRM's own create functions.
- **AC-C2** Each row is written in its own savepoint inside batch transactions: a row that fails at
  commit (for example, a duplicate created concurrently by another user) is rolled back alone and
  recorded as failed with its reason; the rest of the batch continues. All-or-nothing commit is the
  alternative for Q3.
- **AC-C3** The import record shows a final status (`COMPLETED`, `COMPLETED_WITH_ERRORS`, `FAILED`,
  `CANCELLED`) and counts of created, linked, skipped and failed rows that add up to the file's row
  count.
- **AC-C4** Failed rows can be downloaded as a CSV containing only the source row number, the
  original row values and the reason; any value beginning with `=`, `+`, `-` or `@` is escaped so it
  cannot run as a spreadsheet formula.

### 3.5 Retries and idempotency

- **AC-I1** Starting an import of a file whose SHA-256 matches a completed import of the same
  organization is refused with a link to the earlier import, unless the user explicitly starts a new
  one.
- **AC-I2** A commit interrupted part-way (worker restart, database failure) resumes from the rows
  not yet recorded; each source row is applied at most once (unique on import id and row number).
- **AC-I3** Retrying the commit request returns the same import and does not start a second job.

### 3.6 Permissions and organization scope

- **AC-S1** A new permission `crm.import` is required to upload, preview and commit, **in addition
  to** the create permission for every table the file writes (`companies.create`,
  `contacts.create`, `deals.create`, and `activities.create` if notes are imported). Missing any of
  them refuses the import before preview with the standard 403.
- **AC-S2** The organization comes from the session, never from the file or the request body. Every
  created record carries that organization; the existing composite foreign keys and RLS re-check
  it.
- **AC-S3** Import records and failed-row details are organization-scoped tables with forced RLS,
  visible only to holders of `crm.import` in the same organization.
- **AC-S4** `crm.import` is seeded to the organization `SUPER_ADMIN` and `ADMIN` roles only, at
  first (proposed; confirm with Q8).

### 3.7 Audit and history

- **AC-A1** Starting a commit and its completion each write one tenant audit entry
  (`crm.import.started`, `crm.import.completed`) in the same transaction as the import record's
  change, carrying the import id, file name, SHA-256 and counts — never row contents.
- **AC-A2** Every created company, contact, deal and activity records the importing user as its
  creator, as the CRM's own create functions do; the import's row record holds the id of every
  record that row created or linked, so each CRM record can be traced to its source row without
  changing the CRM tables.
- **AC-A3** The raw file is not kept. Parsed rows needed for preview and failure reporting are kept
  with the import record and removed by retention after a period (proposed 90 days, matching the
  build plan's fallback window; confirm with Q7).

### 3.8 Tests

- **AC-T1 Unit:** CSV parsing (quoting, embedded newlines, byte-order mark, encodings refused),
  header mapping, every field validator, owner resolution, duplicate normalisation, formula
  escaping.
- **AC-T2 Database:** RLS on the import tables across two organizations; refusal without
  `crm.import` or without each create permission; organization taken from the session even when the
  file names another; idempotency (same file, resumed commit, retried request); a concurrent
  duplicate failing one row only; counts adding up.
- **AC-T3 End-to-end:** upload → preview → confirm → background commit → CRM pages show the records
  → failed-rows download; a second user of another organization sees nothing.
- **AC-T4 Regression:** the existing CRM, pipeline, relationship, export and audit suites pass
  unchanged.
- **AC-T5 Migration rehearsal:** the real (anonymised or staging) export imports into a disposable
  database with counts matching the sheet and a spot-check of at least 20 rows per table.

---

## 4. Launch migration procedure

1. Founder supplies the sheet's structure and answers §7; the mapping is approved.
2. The import is built and passes §3.8 in CI.
3. Rehearsal on a non-production database (depends on DB-14): import, verify counts against the
   sheet, spot-check rows, fix the mapping if needed.
4. Production import, after the production migration gate (HG-2): the same file, verified the
   same way.
5. The sheet is set read-only with a banner pointing to Pravshi OS, kept for 90 days as a fallback,
   then archived. It is never deleted.

---

## 5. Data protection

- The file may contain personal data (names, emails, phone numbers). It is processed in memory,
  never logged, and only the parsed rows needed for preview and failure reporting are stored, under
  RLS, until retention removes them.
- Error messages and logs carry row numbers and reasons, never row values.

---

## 6. Dependencies

- Founder answers to §7 (blocking for the mapping).
- A CSV parsing dependency, reviewed like any new dependency.
- A migration for the import tables and the `crm.import` permission; production application under
  HG-2.
- DB-14 for the rehearsal and production databases.

---

## 7. Questions for the founder

- **Q1 Source and format.** Where does the Sales Sheet live (Google Sheets, Excel), how many tabs
  does it have, and can it be exported as one CSV per tab? Please share the header row and a few
  anonymised sample rows of each tab.
- **Q2 Meaning of each column.** Which columns describe the company, the contact person, the deal
  (title, value, currency, stage, expected close date, probability) and notes or follow-ups? Is
  there a "lead" that is not yet a deal, and how should it be represented (the built CRM has no
  separate lead table)?
- **Q3 Partial failure.** Should valid rows be imported when some rows are invalid (recommended,
  with a failed-rows report), or must the whole file be clean first?
- **Q4 Formats.** How are dates written (for example `DD/MM/YYYY`), and amounts (currency symbol,
  thousands separators, lakh/crore notation)? Is every deal in INR?
- **Q5 Owners.** Does the sheet name a salesperson for each row, and how (email, name, initials)?
  If a row has none, who should own it?
- **Q6 Re-imports.** After the launch migration, should the import ever update existing records, or
  only create new ones (recommended for V1)?
- **Q7 Volume and retention.** Roughly how many rows does the sheet have, and is 90 days the right
  time to keep import details and the sheet fallback?
- **Q8 Who may import.** Only organization administrators (`SUPER_ADMIN`, `ADMIN`) at first, or
  also sales managers?
- **Q9 Stages.** How do the sheet's status values map to the CRM pipeline stages (`NEW`,
  `QUALIFIED`, `PROPOSAL`, `NEGOTIATION`, `WON`, `LOST`) or to a custom pipeline?
