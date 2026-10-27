# Changelog

All notable changes to Pravshi OS are recorded in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Database migrations: 0063–0086 (production still pending — see the
[production migration runbook](docs/runbooks/production-migration.md)).

### Added

- Platform administrator console (ADR-008, migration 0086). `/platform` for platform
  administrators only: the organizations (metadata only), provisioning with type selection and
  a one-time setup link for the first administrator, re-issuing that link, suspend and
  reactivate with a reason, platform administrators (invite with no more than the inviter's
  own permissions, revoke — which ends their sessions), and the platform audit trail. Every
  action goes through `/api/platform/*` on its own database login (`DATABASE_URL_PLATFORM`,
  `app_platform`, no fallback): a tenant user of any role, SUPER_ADMIN included, gets 404; an
  administrator without an enrolled authenticator can only enrol one; sensitive actions need a
  sign-in from the last 10 minutes; platform sessions end after 30 idle minutes or 12 hours;
  sensitive actions are rate limited; an administrator's refused or failed operations are
  audited (DENIED / ERROR). The acting administrator is bound in the database to a live aal2
  session of their own login (0086), so the console's database credential alone acts as nobody. The setup links
  `/platform/setup` and `/setup/organization` set a first password under the full password
  policy. The operator CLI `scripts/bootstrap/platform.mjs` creates the first platform
  administrator, re-issues a pending administrator's link, and performs audited break-glass
  recovery that invalidates the old password and second factor at once. Migration 0086 adds
  `platform.list_admins()`. Prepared rollback: `scripts/db/rollback/0086_platform_console.down.sql`.
- Organization provisioning by the platform, database layer (migration 0084, ADR-008). In one
  transaction a platform administrator creates an organization from an available type (today
  `generic_crm`; Real Estate and Education stay disabled) and its latest published template,
  its Executive department and its first administrator with SUPER_ADMIN, plus a 72-hour setup
  link for that administrator — who then creates their own login, never adopting an existing
  one. Requests are idempotent by key. Platform administrators can re-issue the setup link
  until it is used, and suspend or reactivate an organization with a reason: while suspended,
  its members are refused and its background work waits. Archive and restore are deferred to
  V1.1 (ADR-008). Every change writes one platform audit entry. Reachable from the platform
  console (above). Prepared rollback: `scripts/db/rollback/0084_platform_provisioning.down.sql`.
- Platform administrator plane, database layer (migration 0083, ADR-008). A separate
  authority from every organization: platform administrators with their own permission
  catalogue, an append-only platform audit trail, and a new database login `app_platform`
  that holds no table privilege anywhere and reaches the platform only through its functions.
  The first administrator is created by a once-per-database operator bootstrap, independent of
  the organization bootstrap — which it then closes, so every later organization is provisioned
  by the platform. Setup creates the administrator's own login (never adopting an existing one);
  a login is a platform administrator or a tenant person, never both. Administrators can invite
  (least privilege) and revoke administrators (never themselves; revocation ends their
  sessions) and grant only permissions they hold themselves. Every platform action needs an
  administrator whose login has an enrolled second factor; the aal2 claim alone is not enough.
  A break-glass operator recovery resets a lost factor and clears the whole old credential
  (password, sessions, factors, reset links), and nothing created during the recovery window
  survives it; the web password reset never reaches a platform login. The protected-role genesis
  grant now names exactly the logins allowed to perform it (`app_admin`, `app_owner`,
  `app_platform`). Not yet reachable from the application: the platform API, console and
  organization provisioning follow. Requires `scripts/db/roles.sql` to create `app_platform`
  before 0083 (runbook). Prepared rollback: `scripts/db/rollback/0083_platform_identity.down.sql`.
- Sales Sheet import, stored half (migration 0081, BP-06). An uploaded CSV is previewed and
  recorded — file name, SHA-256, mapping, header and every row with its plan or errors, never
  the raw file — and, once the importer confirms that exact preview, committed by a background
  `crm_import` job that runs as the importer through the normal authorised path: every company,
  contact and deal is written under the CRM's own policies and triggers, one savepoint per row,
  so a failing row fails alone and an interrupted run resumes from the rows not yet decided.
  New permission `crm.import` (sensitive; SUPER_ADMIN and ADMIN at GLOBAL), required with the
  create permission of every table the file writes; confirming also needs `jobs.create`. A
  file already imported, or being imported, is refused unless a re-import is asked for, and
  confirmations of the same file are serialised. Audit: `crm.import.started`,
  `crm.import.completed` and `crm.import.failed`, with ids, name, hash, counts or a reason code
  only. An import never stays in progress without an outcome: the worker records a failure,
  and DB maintenance fails imports whose job ended. Job errors carry no imported value. Job
  retention keeps working: an import outlives its job. Only the importer confirms or cancels;
  a holder of `crm.import` below GLOBAL sees only their own imports; a `crm_import` job cannot
  be cancelled through the jobs API. API under `/api/crm/imports`.
  The real Sales Sheet mapping is still pending: the shipped mapping is a documented stand-in.
  Prepared rollback: `scripts/db/rollback/0081_crm_imports.down.sql`.
- Organization types and versioned organization templates (migration 0080). Every
  organization records the operating type it was created from — `generic_crm`,
  `real_estate_crm`, `education_crm`, from a controlled catalog — and the template version
  it was seeded with. A template defines the pipelines and stages an organization starts
  with; a published version is immutable, and an upgrade to a newer version of the same
  type only adds what the organization lacks. Existing organizations are `generic_crm`
  version 1, which is exactly the six-stage default pipeline every organization already
  had, so nothing changes for them or for new organizations created without a type.
  Real Estate and Education are catalogued but disabled until their templates are
  approved. Prepared rollback: `scripts/db/rollback/0080_organization_types.down.sql`.
- Low-cost worker mode for the Neon Free plan (the default). Neon Free suspends
  compute only after five minutes without a query and caps a project at 100
  CU-hours a month; a worker polling every 10 seconds kept compute awake
  permanently (~182 CU-hours). The idle worker now sleeps without querying until
  its next due work (migration 0066, `worker_next_due_at()`), at most two hours,
  holding no database connection; the web app wakes it over an authenticated,
  rate-limited `POST /wake` right after committing new work — jobs, retries,
  reminders, schedules, and every forgot-password request (on every path, so the
  wake adds no timing signal). Measured end to end: a woken job finishes in under
  a second, reminders and schedules fire within a second of their time, work that
  fell due while the worker was down drains on start, and a job whose wake was
  lost is found by the two-hour safety wake. The worker logs a daily estimate of
  the compute it causes and warns at 70% and 90% of a budget.
  `WORKER_IDLE_MODE=poll` keeps the previous behaviour.
- Schedules may not fire more often than `SCHEDULE_MIN_INTERVAL_MINUTES`
  (default 60; 0 disables) — each run wakes the database. Checked on create, on a
  cron or timezone change, and when a paused schedule is enabled again (even with
  its cron unchanged). Existing active schedules are not changed; the "Every 15
  minutes" preset became "Every hour".
- Automatic database maintenance in the worker (migration 0065), at startup and
  hourly. Audit-log partitions are kept twelve months ahead: they were created
  once by migration 0011 and never extended, so about a year later every write
  that produces an audit entry would have failed. Old operational records are
  deleted on fixed retention periods (finished jobs and their webhook
  deliveries, read notifications, finished workflow executions, processed
  inbound webhook events, AI usage records, expired auth bookkeeping), in
  bounded batches. The audit log, login events and business records are never
  deleted. Both run through worker-only database functions that refuse a
  signed-in caller. Periods are listed in DEPLOYMENT.md, "The worker plane".

### Fixed

- The migration runner (`scripts/migrate-ws.mjs`) could silently skip migrations. Like
  drizzle-kit, it applied only journal entries dated after the newest recorded one, but the
  journal's historical dates are out of order (idx 28–30 are dated before idx 27; idx 35 ties idx
  34), so a database stopped inside those ranges would have pending migrations skipped while the
  run reported success. It also never checked that what a database had applied matched the
  repository. The runner now verifies the recorded history is exactly the journal's prefix — same
  file checksum and date, row for row — and applies the rest in journal order; anything else
  (missing, duplicated, reordered, unknown or changed migrations, or a concurrent run) is refused
  with exit code 3 before anything is applied, and a history that changes during the run stops it
  with the same code after the whole migrations it has committed. The production migration
  runbook's Step 0 now reads
  the history in insertion order instead of by date, which made a correct database fail its own
  check, and `DEVELOPMENT.md` no longer recommends `drizzle-kit migrate`.
- Migrations 0070 and 0072, and 0073's verification, rejected the role membership that
  Neon-style role creation produces. On PostgreSQL 16+ a non-superuser that creates a role is
  automatically granted ADMIN on it and cannot revoke that grant itself; Neon's branch owner,
  which runs `scripts/db/roles.sql`, is not a superuser, so it becomes a member of `app_worker`
  and `app_auth`, and the previous checks stopped on that membership
  (`app_worker must share no role membership: neondb_owner -> app_worker`). The failure and the
  fix were reproduced on a local PostgreSQL 18.6 simulation of Neon's non-superuser branch owner
  and have not yet been run on Neon. CI never showed it because a superuser creates the roles
  there. The rule is now: the role is a member
  of no role at all (stricter than before, which only looked at application roles), and no role
  is a member of it except the database owner, and only when the owner is not an application
  role. The three files were corrected in place, and the production migration runbook's step-3
  checks and pinned hashes follow. No persistent database is known to have recorded the original
  migration files based on the available evidence. The previous development database has not
  been checked. If that database is reused, follow Step 0 and stop if its migration hashes or
  history do not match the expected state.
- Audit-log partition maintenance no longer deadlocks or stalls ordinary writes (migration
  0075). Creating a partition locks the audit log and then the organizations and people tables;
  any change to a person or an organization that is audited takes them the other way round. When
  the worker created a partition at that moment, the person or organization change could fail,
  and every audited write in the system waited up to five seconds. Maintenance now takes the locks
  it needs without waiting and retries a moment later on a conflict, so it never waits while
  holding one. It also takes no lock at all when there is nothing to create.
- Administrative actions that left no audit trail now record exactly one audit
  entry each, committed with the change (migration 0067): creating and
  archiving departments, creating, renaming, archiving and changing the
  members of teams, and revoking one or all of a user's sessions. Each entry
  carries the acting administrator and organization (derived by the database),
  the request id, and before/after values; a refused action writes nothing, and
  an audit failure rolls the action back.
- The notification bell stops polling a page nobody has used for ten minutes
  and refreshes on the next activity; an unattended open tab no longer keeps the
  database awake overnight.
- The worker no longer adds an error listener to a pooled database client on
  every checkout (listeners accumulated for the client's lifetime).
- Project members: `GET/POST/DELETE /api/work/projects/<id>/members` no longer
  return 500. The `project_members` policies recursed into themselves; they now
  use membership helper functions (migration 0063). Resolves the 1.0.0 known
  limitation of the same name. (#72)
- Task assignee and project member pickers offer the organization's active
  people, so a project's first task can be assigned. (#74)
- Automatic notifications for task assignment, reassignment and completion and
  for deal stage changes, and task reminders are delivered by the worker
  (migration 0064). (#76)
- Authentication journeys: truthful invitation errors, sign-out from the shell,
  safe return path after login, backup-code MFA challenge, lockout cleared by a
  password reset. (#77)
- Local development: pages rendered client-side (`/setup`, the login form) work
  under `pnpm dev` again; production keeps the strict CSP. (#78)
- Password-reset email is delivered with the documented email configuration
  (`RESEND_API_KEY` + `EMAIL_FROM`). Reset email is a job, and the job email
  adapter previously required `EMAIL_PROVIDER=resend` as well, so those emails
  silently dead-lettered.

### Security

- Sign-in lockout reaches every account whatever the case of its address (migration 0085,
  LOCK-1). Accounts created by invitation or bootstrap kept the address as typed, and the lockout
  looked logins up case-sensitively, so an account stored with capital letters was never locked
  out and a password-reset request did not find it. Every login address is now stored
  lower-cased: existing ones are normalised (a case-only duplicate cannot exist — the address
  was already unique regardless of case — and the migration refuses rather than merge if it ever
  did), and every writer is normalised by a trigger and a CHECK. The organization lookup before
  sign-in compares case-insensitively. Rate limits were never keyed by address and are
  unchanged. Prepared rollback: `scripts/db/rollback/0085_login_email_case.down.sql`.
- Least-privilege cleanup (migration 0082, found by the V1 acceptance review). The two
  link-immutability trigger functions from 0036 no longer carry PUBLIC EXECUTE (the triggers
  still fire for every role), and `app_user` no longer holds DELETE on webhook deliveries,
  inbound events and sync checkpoints — tables with no DELETE policy, where a DELETE used to
  match no row and is now refused with 42501. Connections and subscriptions keep the DELETE
  their disconnect and delete flows need; retention still purges through its definer.
  Prepared rollback: `scripts/db/rollback/0082_least_privilege_cleanup.down.sql`.
- Audit history cannot be truncated (migration 0078, Phase 3 MT-L3). `audit_logs` — the
  parent and every partition, including partitions created later — `login_events` and
  `engagement_events` refuse TRUNCATE, so a TRUNCATE … CASCADE reaching them is refused as a
  whole. Row triggers already refused UPDATE and DELETE; a statement trigger on the
  partitioned parent is not inherited by its partitions, hence one per partition.
- Rate-limit buckets count concurrent first uses (migration 0079, FU-3 / F-MFA-5).
  `authz.check_rate_limit()` is a single upsert, so simultaneous first requests on a key are
  each counted instead of one failing with a unique violation — which callers turned into a
  spurious refusal and an alert. Counting semantics are unchanged.
- A job or schedule can only run as the person who created it, enforced in the database
  (migration 0076). A workflow job runs with the permissions of the person who enqueued it and a
  scheduled run with those of the schedule's creator; at the SQL level, a member allowed to
  create jobs could previously name someone else in either column, point another member's
  schedule at a workflow of their own, or queue a scheduled run directly — each running a
  workflow with another person's permissions. The application never did any of these. The
  database now refuses all four.
- Changes to jobs and schedules (schedule create, edit and delete; job cancel and retry) write
  their audit entry in the same transaction as the change. Before, the entry was written after
  the change had been saved, and a failure only produced a log line, leaving the change
  unaudited. Now a failed audit write cancels the change.
- A database failure during sign-in or a session check no longer writes the session token to
  the server log. Database errors carry every query parameter, and the authentication library
  printed them whole; the session's token was one of them. Authentication now logs errors as
  their type and code only, and Sentry events, breadcrumbs and traces (server, edge and browser)
  are scrubbed of tokens, passwords, cookies and credential-bearing URLs before they leave.
- Sign-in, sessions and passwords now run on their own database login, `app_auth`
  (migrations 0072 and 0073). Before, the web app's everyday login could read and change the
  whole credential store — password hashes, sessions, second-factor secrets — so a flaw that let
  someone run database queries as the web app could have taken over any account. Now only the
  authentication part of the app can reach it, through `DATABASE_URL_AUTH` (required on Vercel;
  never on the worker host). Administrators ending another person's sessions or resetting their
  password are checked by the database against their own signed-in session, rather than trusted
  from the application; ending sessions and its audit record happen together. They reach only
  people they are allowed to see (`people.view` at its scope — migration 0074), as before the
  move: a department-scoped administrator cannot reset the password of, or list or end the
  sessions of, someone in another department.
- The `cleanup` job type (deleting an organization's old finished jobs, or handing
  stuck jobs back to the queue) now runs on the worker's own login (migration 0071).
  It was the last worker path that ran its queries as the web app, and it could only
  have worked by giving the web app the power to purge and reset any job — so it
  failed or did nothing. The database now does the work only for a cleanup job the
  calling worker holds, inside that job's organization, with the job's own settings
  checked there; it never deletes a job that still has webhook delivery records, and
  never resets a job whose last heartbeat is under a minute old (`staleThresholdMs`
  below 60000 is now refused rather than accepted).
- The background worker has its own database login, `app_worker` (migration 0070),
  and the work only it should do — claiming and finishing jobs, retries, reminders,
  scheduled runs, maintenance, reading a reset email's protected body, and resolving
  webhook signing secrets — is now possible for that login only. Before, the web
  app's own login could do all of it, so a flaw that let someone run database queries
  as the web app would have exposed every organization's queued work. The database
  recognises the worker by the login itself, not by any setting a caller could forge.
  The worker needs the new `DATABASE_URL_WORKER` (worker host only; the app refuses it
  on Vercel) and refuses to start without it.
- A password-reset link could be read by other people in the same organization
  (migration 0069). The reset email — whose link carries the reset token — was
  stored as an email job, and the jobs list (`GET /api/jobs`) shows job contents
  to anyone allowed to view jobs: administrators and project managers. Since
  anyone can request a reset for any address, a project manager could request
  one for a colleague and use the link first. The email body now lives in a
  table no application role can read; the job keeps only the recipient and the
  subject, the worker reads the body only for the job it is sending, and the
  body is deleted once the job is finished. Existing reset jobs were cleaned in
  the same migration. Reset links, expiry and single use are unchanged. Not
  exploitable in production, which has never run this code.
- Elevated database functions now check the organization they act on against
  the caller (migration 0068). Claiming jobs refuses a signed-in request;
  resolving a webhook's signing secret, checking a protected role and deleting a
  schedule act on the caller's own organization only (deleting a schedule also
  re-checks `jobs.delete`); a login event can only be attributed to the
  organization of its login or email; moving an inbound webhook receipt requires
  that connection's endpoint key; and the runtime role allocates identity codes
  (EMP-…, INV-…) only for its own organization. None of these was reachable
  through the API; each closes a path open to anyone able to run SQL as the
  application.
- Background work stops for an organization that is suspended, archived or
  deleted: its jobs are not claimed, failed jobs are not retried, reminders and
  schedules do not fire, and its inbound webhook endpoints answer with the
  ordinary rejection. Nothing is cancelled — the work resumes when the
  organization is active again. A job already running when the organization is
  suspended finishes, or is recovered if its worker dies.
- Deal-stage history can no longer be forged (migration 0077, Phase 3 MT-L6).
  Its rows are written only by the trigger that records a deal's stage change,
  in the same transaction and with the real actor. The runtime role lost the
  direct INSERT path (policy and grant) that let SQL-level access insert rows
  naming another organization's stages or people, another person as the actor,
  or any date — rows that fed the CRM lead and velocity reports and the
  deduplication of workflow and webhook events.
- An organization's id and slug are fixed once it is created (migration 0077,
  Phase 3 MT-L1): a trigger refuses any change to either. Name, status and
  deletion stay changeable. A prepared rollback restores the 0076 state.

### Changed

- V1 scope recorded ([ADR-006](docs/architecture/adr/006-v1-scope-business-os.md)): V1 is the
  multi-tenant Business OS that was built. The 2026-09-06 HR and operations blueprint is preserved
  as a deferred, separate future product scope and is no longer a V1 acceptance criterion; its
  architecture remains binding. Organization membership, provisioning, tenant tiers, the
  environment topology and the Sales Sheet import remain open decisions. Documentation only — no
  behaviour changes.
- The production migration runbook targets the current journal (0064), and a
  guard test fails CI whenever a migration lands without the runbook following.
- Deployment, environment and development documentation describe the current
  setup: no `staging` branch exists yet, and development uses its own Neon
  project, separate from production.

### Tests

- Real-database proof of the job-enqueue deduplication contract. (#73)

## [1.0.0] — 2026-10-09

Pravshi OS V1: a multi-tenant business operating system — CRM, sales pipelines,
work management, workflow automation, background jobs, analytics, global search,
notifications, an AI assistant layer, and an integrations platform — built
across thirteen phases on a row-level-security-enforced, permission-checked
foundation. Database migrations: 0001–0062.

### Added

#### Phase 1 — Identity & access

- Email/password sign-in with database sessions (Better Auth), TOTP
  multi-factor authentication with backup codes, and a first-run bootstrap
  that creates the initial super admin.
- Invitations with one-time links: accepting an invitation creates the
  person's engagement from the invitation's terms and grants the baseline
  employee role.
- Password reset by email link (one-hour, single-use, anti-enumeration
  responses, rate-limited).
- Admin console: user management (invite, role editor, suspend/unsuspend,
  revoke), roles, departments, and audit-log viewers; a per-user security
  page for TOTP, backup codes, and sessions.
- A permission catalogue with roles and scope resolution, per-record grants,
  an append-only audit log, and row-level security (FORCE RLS) with
  transaction-local identity on every table — access is fail-closed.

#### Phase 2 — CRM core

- The core CRM records — companies, contacts, deals, and activities — with
  create, read, update, and soft delete, plus relationships between records.
- Every record is tenant-isolated: row-level security scopes all reads and
  writes to the caller's organization and granted permissions.

#### Phase 3 — Sales pipelines

- Configurable sales pipelines with ordered stages (probabilities, won/lost
  flags, colors) and a drag-and-drop Kanban board for deals.
- Automatic deal-stage history recorded by database triggers.
- Revenue forecasting including a per-currency breakdown, and per-stage deal
  velocity (average days in stage, computed from stage history).

#### Phase 4 — Work management

- Projects and tasks with subtasks, project members, and task reminders.
- Tasks can be linked to CRM deals; projects and tasks are permission-gated
  and tenant-isolated like every other record type.

#### Phase 5 — Workflow engine

- A visual workflow builder: definitions composed of triggers, conditions,
  and actions, with an execution history showing each run's outcome.
- Workflow definitions and executions are stored per organization and run
  under the same permission and tenant-isolation rules as the rest of the
  system.

#### Phase 6 — Automation & background jobs

- A database-backed job plane: jobs are claimed by a worker process with
  heartbeats, retried with backoff, swept when retryable, reaped when a claim
  goes stale, and dead-lettered after their attempt budget is spent.
- Scheduled triggers that enqueue jobs on a cadence, so automations and
  notifications run off the request path.

#### Phase 7 — Analytics & dashboards

- Five analytics dashboards — overview, CRM, sales, work, and automation —
  served by five matching API routes, all gated by the `reports.view`
  permission.

#### Phase 8 — Search & notifications

- Global search across eight record types (contacts, companies, deals,
  projects, tasks, activities, workflows, people), permission-filtered per
  entity, with typo-tolerant trigram matching and deterministic relevance
  ranking.
- A notification system with a header bell, per-user channel preferences, and
  delivery through the Phase 6 job plane with idempotent, deduplicated
  inserts.
- A permission-aware home page that routes each user to what they can access.

#### Phase 9 — AI foundation

- An AI provider abstraction: a deterministic mock provider by default, plus
  one env-gated OpenAI-compatible adapter. No provider configured means an
  honest "not configured" state everywhere, never a fabricated answer.
- `POST /api/ai/assist` with eight record-summary capabilities, backed by six
  read-only, permission-checked tools and a context builder that only reads
  data through the existing authorized services.
- AI summary panels on the company, contact, deal, activity, project, and
  task detail pages.
- Two-phase usage metering with per-organization monthly/request limits and
  a kill switch (`GET /api/ai/usage`, `GET/PUT /api/ai/usage/limits`).

#### Phase 10 — Integrations platform

- A credential vault (AES-256-GCM) for integration secrets; the API only ever
  exposes whether a credential exists, never its value.
- A connections registry in Settings → Integrations, with connect, rotate,
  and disconnect (disconnect destroys the stored ciphertext).
- Email delivery through the Phase 6 job plane via Resend, with idempotency
  keys so a retried job never sends twice.
- Outbound webhooks: subscriptions with server-generated signing secrets
  (shown once), signed deliveries fanned out from real domain events
  (workflow completed/failed, deal won/lost, task completed), and SSRF
  checks at subscription creation and again at delivery.
- Inbound webhooks: per-endpoint secret tokens, receipt-first recording,
  deduplication, and a workflow trigger and action for webhook-driven
  automation.
- An executions read model unifying outbound deliveries and inbound events.

#### Phase 11 — Security hardening

- The sign-in lockout and login-event recording now live in the auth
  pipeline itself, so every sign-in path — including the library's own
  endpoints — is covered; the custom login route no longer duplicates them.
- The forgot-password timing leak is closed: reset email is enqueued onto
  the job plane instead of being sent inline on one branch of the flow.
- One shared password policy (breached/common-password checks) enforced on
  invitation acceptance and bootstrap setup as well as reset.
- Abuse controls: per-IP and per-endpoint throttles on inbound webhooks, and
  per-user rate limits on search and audit export.
- Browser headers completed: a restrictive Permissions-Policy and a CSP
  `connect-src` covering the error-reporting ingest hosts.
- Database hardening (migration 0061): caller-context assertions inside the
  SECURITY DEFINER functions the worker and AI layers rely on, and
  identity-freeze triggers on jobs, schedules, workflows, and AI usage
  requests. Two dormant migration files and a legacy workflow were retired.

#### Phase 12 — Performance & reliability

- Analytics requests now compose over a single database transaction per
  route (down from 12 on the overview route), with payload parity proven
  against the previous behaviour.
- The worker's crash-reaper is wired at startup and in-loop, and idle
  polling backs off geometrically (1 s → 10 s ceiling) instead of waking the
  database every second.
- Audit-log partition maintenance is hardened against concurrent writers
  (migration 0062: an advisory lock is taken before any lock timeout is
  armed, with a bounded retry).
- App-segment error, loading, and not-found boundaries; the Inter and
  JetBrains Mono fonts actually load via `next/font`; the notification bell
  polls every 60 s and pauses while the tab is hidden.
- Code-splitting on the workflow editor routes (258 kB → 199 kB first load);
  the AI route declares `maxDuration = 60`; a request timing log records
  route, status, and duration — never query strings.
- A permanent Tier-1 performance harness in CI: a deterministic
  ~540,000-row two-organization dataset with seven EXPLAIN plan assertions
  guarding the hottest queries against sequential scans, plus a Tier-2
  baseline recorder (measurement deferred — see Known limitations).

#### Phase 13 — Production readiness

- The production migration runbook: verify state → freeze and snapshot →
  rehearse the full chain on the snapshot → apply → verify, forward-fix
  only, with a run record for every execution.
- Deployment documentation corrected to match the system as built,
  including the worker plane (a web-only deployment is silently broken) and
  the backup position.
- Backup, incident-response, and post-deployment smoke-test runbooks, and a
  15-item binary release checklist separating agent-verifiable, CI-proven,
  and human-gated items.
- Release identity: this changelog and version 1.0.0.

### Accepted residuals

Known, assessed, and deliberately accepted at V1:

- **Phase 9, F1 (Low):** the per-minute AI usage window counts
  NOT_CONFIGURED rows while the monthly window excludes them. Fail-closed
  only — it can refuse a request earlier than strictly necessary, never
  allow one it should refuse.
- **Phase 11:** the TOO_COMMON password rejection is unreachable under the
  current configuration (the longest common-list entry is 11 characters,
  below the 12-character minimum length) on all flows. Extending the common
  list is a product decision, not a defect fix.
- **Phase 11:** the `/forget-password` rate-limit key in configuration is
  dead on the installed Better Auth version (the live path is
  `/request-password-reset`); both spellings are refused in the auth
  before-hook. Left untouched as out of scope.
- **Phase 12:** the Tier-2 measured performance baseline is deferred (see
  Known limitations), and migration 0062's retry-exhaustion branch is pinned
  by construction and tests around it rather than live-probed — holding the
  lock long enough to exhaust it would flake sibling test suites.

### Known limitations

- **Production migrations 0045–0062 are not yet applied to production.**
  Production remains at migration 0044 until the §4.1 runbook is executed
  under gate HG-2.
- **Tier-2 performance baseline unmeasured:** the recorder is built, but the
  first measured run is scheduled for the post-Nov-1 slot; V1's performance
  evidence is the Tier-1 plan/concurrency harness plus static budgets.
- **Deferred major upgrades:** PR #52 (Sentry 10 → 11) and PR #54
  (Next.js 15 → 16) are intentionally not in V1. V1 ships on Next 15.5.25 and
  Sentry 10.x; the Sentry upgrade is also what retires one build-chain audit
  ignore, and that coupling is recorded rather than left implicit.
- **Project people sourcing (Phase 4 backlog):** `GET
/api/work/projects/<id>/members` returns a 500, and the task assignee and
  project member pickers only offer people already on the project's tasks,
  so a project's first task can only be "Unassigned". Assignment itself is
  proven at the service level; the fix (an authorized org-people candidate
  query) is scheduled as its own PR.
- **Test hygiene:** the scheduler-tick test suite cleans up
  `scheduled_trigger` jobs without org scoping, which can delete other
  suites' rows on a shared CI database. Test-only; no product impact.
  Scoping it is a recorded backlog item.
- **Manual verification:** browser click-through of the shipped UI remains
  the founder's manual pass (gate HG-3); automated suites cover the API and
  service surface.

### Release status

This changelog records the V1 codebase. **Production deployment has not
happened**: it awaits Nani's explicit approval (gate HG-1) and the remaining
human gates HG-2…HG-9 (production migration decision, manual click-through,
hosting/DNS, monitoring, backup decision, worker hosting, first super-admin
bootstrap).
