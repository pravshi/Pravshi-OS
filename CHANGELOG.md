# Changelog

All notable changes to Pravshi OS are recorded in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Database migrations: 0063–0064 (production still pending — see the
[production migration runbook](docs/runbooks/production-migration.md)).

### Fixed

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

### Changed

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
