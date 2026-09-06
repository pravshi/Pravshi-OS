# PRAVSHI OS — MASTER BLUEPRINT

**Status:** Revision 2 — architecture ratified by the founder. **NO APPLICATION CODE WRITTEN YET.**
**Date:** 2026-09-06

**Companion docs:**
- [Database Architecture & ERD](../../architecture/database.md)
- [Security Architecture, Permission Matrices & Threat Model](../../architecture/security.md)
- [PRAVSHI OS V1 Build Plan](../../architecture/build-plan.md)

## LOCKED DECISIONS — do not revisit without an explicit founder decision

The following were ratified on 2026-09-06 and are binding on every later phase, spec and plan:

| Locked | Detail |
|---|---|
| **Database** | **Neon PostgreSQL.** **Do not reintroduce Supabase** in any future proposal. |
| Authentication | **Better Auth**, self-hosted, sessions in Postgres. Provider interface kept open so Google OAuth / Workspace is an additive switch later. |
| File storage | **Cloudflare R2**, private buckets, presigned URLs |
| Runtime DB role | **`app_user`** — not the schema owner, **no `BYPASSRLS`** |
| RLS | **`FORCE ROW LEVEL SECURITY` on every table** |
| Auth context | **`SET LOCAL app.person_id` inside a transaction only.** Never session-scoped `SET`. |
| Data access | **One centralised `withAuthorizedDb()`.** No other path to Postgres. |
| Authorization posture | **Fail-closed.** No identity means zero rows, never all rows. |
| **Neon region** | **AWS Asia Pacific 1 — Singapore (`aws-ap-southeast-1`).** Vercel functions therefore pin to `sin1`, not `bom1`. |
| **Neon compute** | **Scale-to-zero / autosuspend stays ENABLED.** No keep-alive job, heartbeat, cron, background worker or synthetic query whose purpose is to keep compute awake. No minimum or always-on compute. Cold-start latency is accepted for V1. Connection handling must tolerate wake-up cleanly. |
| Phase order | Fixed as listed in §34 and [build-plan.md](../../architecture/build-plan.md). Sales (Phase 3) is the immediate business priority; Projects & Tasks (Phase 4) follows it. |

---

## 0. How to read this document

This is a design contract, not a tutorial. It answers three questions:

1. **What are we building?** (§1–19)
2. **How is it built so it stays safe and maintainable?** (§20–31)
3. **What do we build first, and what do we deliberately not build?** (§32–38)

Where a judgement call could reasonably have gone the other way, it is marked **[DECISION]**
with the trade-off stated. Where you must answer something before I proceed, it is marked
**[NEEDS YOUR INPUT]**.

---

## 1. Executive Architecture

PRAVSHI OS is a single-tenant-today, multi-tenant-capable internal operations platform.
Its architecture rests on one sentence:

> **Every request resolves to a person; that person resolves to roles and scopes; and the
> database itself refuses to return rows that person is not entitled to see.**

Everything else — the CRM, the HR module, the document index — is a feature built on that
spine. If the spine is right, features are cheap and safe to add. If the spine is wrong,
every new feature is a future incident.

Three enforcement layers, deny-by-default at each:

| Layer | Enforces | Failure mode if it were the only layer |
|---|---|---|
| **UI** | What you *see* (nav, buttons, columns) | Trivially bypassed via URL or API. Never trust it. |
| **Application** (Server Actions / Route Handlers) | What you can *ask for* | One missed check leaks everything behind that endpoint. |
| **Database** (Postgres Row Level Security) | What rows can *physically be returned* | Slower and harder to write — but it is the layer that survives a developer's mistake. |

The UI layer is UX. The application layer is the primary gate. **RLS is the backstop that turns
an intern's coding mistake into a bug instead of a breach.** We build all three.

**Non-goals for V1:** payroll, replacing Slack, external customer access, AI features, native
mobile apps, and any workflow engine more complex than a configurable checklist.

---

## 2. Product Vision

**For** PRAVSHI employees, interns, managers, HR and the founder
**Who** currently coordinate work across Google Sheets, Drive and chat
**PRAVSHI OS is** an authenticated internal operating system at `os.pravshi.com`
**That** makes identity, permission, work and record-keeping one auditable system
**Unlike** the spreadsheet stack — which has no identity, no permissions, no audit trail, and
no safe way to give an intern access to *some* of it
**Our product** knows who you are, what you may touch, what work is yours, and what you did.

Success at six months, in priority order:

1. Nobody at PRAVSHI needs to open the Sales Sheet to do their job.
2. Onboarding an intern is one workflow, not eight manual steps.
3. Offboarding revokes access in minutes and leaves a record.
4. The founder can answer "who has access to what" without asking anyone.

---

## 3. System Architecture

```
                     ┌─────────────────────────────────────────────┐
   Browser           │  Vercel — Next.js App Router (region sin1)   │
   (employee)        │                                             │
       │             │   React Server Components   (reads)         │
       │  HTTPS      │   Server Actions            (writes)        │
       ├────────────►│   Route Handlers  (files, cron, webhooks)   │
       │             │                    │                        │
       │             │        ┌───────────▼────────────┐           │
       │             │        │  auth  (Better Auth)   │  session → person
       │             │        │  sessions live in PG   │           │
       │             │        ├────────────────────────┤           │
       │             │        │  authz.requirePermission()         │
       │             │        ├────────────────────────┤           │
       │             │        │  withAuthorizedDb()    │  opens a txn,
       │             │        └───────────┬────────────┘  SET LOCAL app.*
       └─────────────┤                    │                        │
                     └────────────────────┼────────────────────────┘
                                          │  connects as role `app_user`
                                          │  (not the owner; no BYPASSRLS)
                     ┌────────────────────▼────────────────────────┐
                     │  Neon Postgres  —  a branch per environment │
                     │     RLS on EVERY table                      │
                     │     authz.* SQL helper functions            │
                     │     audit_logs (append-only, no UPDATE)     │
                     └─────────────────────────────────────────────┘
             ┌───────────────────┬──────────────────┬──────────────┐
             ▼                   ▼                  ▼              ▼
     Cloudflare R2        Resend (email)     Sentry (errors)   Google Drive
     private buckets                                           corporate docs
     presigned URLs                                            Phase 5, index-only
```

**[DECISION] Neon Postgres is the database.** You already have it, and it is a better fit than I
first assumed: Neon's branching maps exactly onto the three-environment story in §29 — production is
a branch, staging is a branch, and each developer gets a disposable branch seeded with fake data.
That is cheaper and safer than three separate database projects, and branch-per-pull-request makes
migration review genuinely testable.

What Neon does **not** provide, and a Supabase-shaped design would have assumed: authentication,
object storage, and a built-in `auth.uid()` to drive RLS. Each is replaced deliberately below, and
the replacements are more portable — nothing in this design now depends on a vendor's proprietary
auth function.

**[DECISION] Authentication is a self-hosted library, not a managed service.** Users and sessions
live in your own Postgres. That keeps employee identity data in one place you control, costs
nothing, and — this is the direct answer to your question 1 — **does not depend on Google
Workspace**. Google OAuth becomes one more provider you switch on later without touching a line of
authorization code. See §25.

**[DECISION] RLS is driven by transaction-local session variables, not a vendor JWT.** Every request
opens a transaction and sets `app.person_id`, `app.org_id` and `app.aal` with `SET LOCAL`; policies
read them with `current_setting()`. This is ordinary Postgres that works on any provider.

The constraint this creates is real and must be respected from the first line of code: **all data
access goes through a single `withAuthorizedDb()` helper.** A query issued outside that transaction
carries no identity, and RLS will correctly return nothing — which is the safe failure, but it means
the helper is not optional. It is the choke point that makes the whole model work.

**[DECISION] All data access runs on the Next.js server.** One place to enforce permissions, one
place to write audit entries, no ability for a browser to enumerate tables. With Neon this is not
merely preferable but required: the database credential must never reach a browser.

---

## 4. Technology Stack

| Concern | Choice | Why this, not the alternative |
|---|---|---|
| Framework | **Next.js 15 (App Router) + React 19 + TypeScript strict** | One deployable unit, server-first. Not an SPA: an SPA pushes auth decisions into the browser. |
| Language | TypeScript `strict: true`; `any` banned in `src/lib/authz` | Permission bugs are type-preventable. |
| Database | **Neon Postgres**, `aws-ap-southeast-1` (Singapore) | Serverless Postgres with branching. Branches become environments (§29) and per-PR migration tests. **Autosuspend stays on** — see §4.1. |
| Connection | **`@neondatabase/serverless` Pool over WebSocket**, pooled endpoint | **[DECISION]** Not the HTTP one-shot driver: it cannot hold a transaction, and our RLS context (`SET LOCAL`) requires one. This is the single most important technical detail in the stack — get it wrong and either RLS silently returns nothing or you leak context between requests. |
| Schema & queries | **Drizzle ORM + Drizzle Kit** | Schema in TypeScript, migrations emitted as **plain SQL files you can hand-edit**. Not Prisma: Prisma's migration format resists the raw SQL that RLS requires. |
| RLS, functions, grants | **Hand-written SQL, appended to the generated migration files** | **[DECISION]** Policies are never modelled in Drizzle. Drizzle owns table shape; SQL owns security. One source of truth for each, and no tool that can silently drop a policy. |
| Auth | **Better Auth** — self-hosted, sessions in your Postgres, invitation-only, TOTP 2FA, pluggable OAuth | §25. Alternative considered: Auth.js v5 (more mature, but 2FA and admin/invite flows are do-it-yourself). Not Clerk: it moves employee identity to a third party and adds cost. |
| File storage | **Cloudflare R2**, private buckets, presigned URLs | You already use Cloudflare. S3-compatible, zero egress fees, and the presigned-URL pattern is identical to the one in §17. |
| Forms | react-hook-form + **Zod**, schemas shared client↔server | The server re-validates everything regardless. |
| UI | **Tailwind CSS v4 + shadcn/ui (Radix)**, lucide icons, TanStack Table | Accessible primitives whose code you own. Not a purchased admin template (§22). |
| Email | **Resend**, sending from `mail.pravshi.com` | Invitations, notifications. Isolated from your corporate mail reputation. |
| Monitoring | **Sentry** + Vercel logs + Neon metrics + an uptime check | Non-negotiable before real users. |
| Testing | **Vitest** (unit), **Playwright** (E2E), **pgTAP/SQL RLS harness** | §31 |
| CI/CD | **GitHub Actions** → Vercel, with a Neon branch per pull request | §29 |
| Hosting | Vercel, functions pinned to **`sin1`** (Singapore) | **[DECISION] Co-located with the database, not with the users.** A single page render makes several sequential round trips; Mumbai→Singapore is roughly 35–60 ms each, so compute in `bom1` would multiply that by every query in the request. One slightly longer hop from the browser beats N longer hops from the server. |

### 4.1 Neon compute behaviour — a locked V1 decision

**Scale-to-zero stays enabled.** When nobody is using PRAVSHI OS the compute suspends; the first
request afterwards wakes it. This is the correct choice for a ~20-person internal tool used in
business hours, and it is locked for V1.

What that forbids, explicitly:

- **No keep-alive of any kind** — no heartbeat, no cron ping, no background worker, no synthetic
  `SELECT 1` whose purpose is to keep compute awake.
- **No minimum or always-on compute** configured for latency alone. Only a demonstrated production
  requirement changes that, and it would be a founder decision.
- **Nothing that incidentally defeats autosuspend.** This is the trap, because it is never
  deliberate — see the rules below.

What that requires the application to handle:

| Consequence | What we do about it |
|---|---|
| Compute suspends, so **open connections are dropped** | Short pool idle timeouts; validate a connection before use; never assume a pool survives idleness |
| The first request after a suspend pays a **cold start** (typically sub-second) | Accepted for V1. `connect_timeout` set generously (10 s), not tight |
| A cold start can surface as a **transient connection error** | Retry with backoff **on connection establishment only** — never replay a transaction that may have partially applied (§24) |
| An uptime monitor hitting a DB-backed health check **is a keep-alive** | `/health` must not touch the database. `/health/db` exists separately and is called by CI and humans, never by a monitor |
| Scheduled jobs wake the compute | Only the nightly backup (§30) is scheduled in V1, and waking once a day for it is intentional, not a keep-alive |
| Auth session cleanup on a timer would wake it repeatedly | Session expiry is evaluated lazily on use, not swept by a periodic job |

**Region.** Confirmed as Singapore. That settles latency (see the Hosting row) and raises one legal
question rather than a technical one: PRAVSHI's employee data will be **stored outside India**.
See §26 — this is very likely fine, but it is a question for counsel, not for me.

**Running cost at your scale:** Neon (already yours) + Vercel (Hobby to start, Pro at $20 when you
need team seats or longer function timeouts) + R2 (effectively free below 10 GB) + Resend (free
below 3,000 emails/month) + Sentry (free tier). **Roughly $0–20/month**, materially less than the
$45 I estimated when I assumed Supabase Pro. The one thing worth paying for early is Neon's
longer history retention (§30).

**Deliberately excluded from V1:** Redis, a job queue, a separate API service, Docker in production,
microservices, GraphQL, and any client state library beyond React plus server state. None of them
earn their maintenance cost at 20 users.

---

## 5. Module Architecture

The system is a **core** plus **modules**. Modules may depend on the core. Modules must not
depend on each other except through explicit, documented interfaces.

```
                        ┌──────────────────────────────┐
                        │            CORE              │
                        │  organization • identity     │
                        │  roles • permissions • scope │
                        │  departments • teams         │
                        │  audit • notifications       │
                        │  files • settings            │
                        └──────────────┬───────────────┘
        ┌──────────────┬───────────────┼───────────────┬──────────────┐
        ▼              ▼               ▼               ▼              ▼
    ┌────────┐   ┌──────────┐    ┌──────────┐   ┌───────────┐  ┌──────────┐
    │ PEOPLE │   │  HIRING  │    │  SALES   │   │ DELIVERY  │  │  RECORDS │
    │employee│   │openings  │    │leads     │   │projects   │  │documents │
    │intern  │   │candidates│    │clients   │   │tasks      │  │policies  │
    │profile │   │interviews│    │pipeline  │   │milestones │  │templates │
    │lifecycle│  │offers    │    │reports   │   │comments   │  │corporate │
    └────────┘   └──────────┘    └──────────┘   └───────────┘  └──────────┘
                                       │
                        ┌──────────────▼───────────────┐
                        │      CROSS-CUTTING (later)   │
                        │ approvals • access requests  │
                        │ performance • leave • search │
                        │ analytics • AI               │
                        └──────────────────────────────┘
```

**The module contract.** Every module declares, in its own README: its permissions, its tables,
its RLS scope rules, its audit events, its navigation entries, and its dashboard widgets.

> **Adding a module must never require editing the authorization engine — only inserting rows
> into `permissions`.** This is the most important extensibility property in the design.

---

## 6. User / Role Architecture

Identity splits into three concepts that are usually — and wrongly — collapsed into one:

| Concept | Table | Meaning | Lifecycle |
|---|---|---|---|
| **Login** | `auth_users` (Better Auth) | A credential that can authenticate | Created on invite; disabled on offboard |
| **Person** | `people` | A human PRAVSHI has a relationship with | Created at candidate/hire; **never deleted** |
| **Engagement** | `engagements` | A *period* of working with us: type, department, manager, dates | Many per person over time |

**[DECISION] Why `people` is separate from both the auth table and `employees`.** An intern who
converts to an employee, leaves, and returns as a contractor is **one person with three
engagements** — not three records. Collapsing these is the mistake most internal HR systems make,
and it makes history, re-hire and audit permanently wrong. Cost: one extra join in most queries.
Worth it.

A person may exist with **no login at all** (a candidate, an alumnus). A login may exist with no
active engagement (suspended). **Access is granted by the engagement, not by the person.**

### 6.1 Role model

Roles are **data, not code**. The seeded roles below are rows; SUPER_ADMIN can create more.

`SUPER_ADMIN` · `ADMIN` · `HR_ADMIN` · `HR_MANAGER` · `MANAGER` · `SALES_MANAGER` · `SALES` ·
`PROJECT_MANAGER` · `DEVELOPER` · `VIBECODER` · `FINANCE` · `MARKETING` · `INTERN` · `EMPLOYEE`

Rules that keep this from rotting:

- A person may hold **multiple roles**. Effective permissions are the union; effective scope is
  the broadest granted.
- `EMPLOYEE` is the baseline every active engagement receives. Every other role is additive.
- `INTERN` is a *role* for permission purposes. The **legal classification** lives on the
  engagement (`engagement_type`), never on the role. Different questions, different fields (§9).
- **No role name appears in business logic.** Code asks `has('leads.edit')`, never
  `role === 'SALES'`. The sole exception is a `roles.is_system` flag that prevents deleting
  SUPER_ADMIN.
- **No owner email is hard-coded anywhere.** The first SUPER_ADMIN is created by a one-time,
  idempotent bootstrap script that reads an environment variable and refuses to run twice (§29).

### 6.2 The protected-role rule

A role carrying `roles.manage` or `permissions.manage` may only be granted or revoked by someone
who already holds that permission at `GLOBAL` scope. **HR cannot escalate anyone to SUPER_ADMIN,
and cannot modify a SUPER_ADMIN account.** Enforced in SQL, not in the UI (threat T-03, §26).

---

## 7. Permission Architecture

This is the heart of the system. Read it twice.

### 7.1 A permission is `resource.action`

`leads.view` · `leads.create` · `leads.edit` · `leads.delete` · `leads.assign` · `leads.export`

Actions come from a fixed vocabulary so the matrix stays readable:
`view · create · edit · delete · assign · approve · export · manage`.
`manage` is a superset used only for configuration surfaces (e.g. `settings.manage`).

### 7.2 A grant is `(role, permission, scope)` — never just `(role, permission)`

Scope is what makes "Sales sees their leads, Sales Manager sees the team's leads" expressible
*without inventing two different permissions*.

| Scope | The row is visible when… |
|---|---|
| `GLOBAL` | always, within the organization |
| `DEPARTMENT` | the record's owning department is one of mine |
| `TEAM` | the record's owner is me, or reports to me (recursive manager chain) |
| `PROJECT` | the record belongs to a project I am a member of |
| `SELF` | I am the owner or subject of the record |

Effective scope = the **broadest** scope granted across all of my roles for that permission.

### 7.3 Record-level exceptions

`record_grants(entity_type, entity_id, person_id, permission, granted_by, reason, expires_at)`
covers "give this one developer access to this one client project until 31 March".
**Time-boxed by default**, audited on grant and revoke, and expiry is enforced in the SQL
predicate itself — not by a cron job that might not run.

### 7.4 Resolution order (deny-by-default)

```
1. Is the request authenticated?                        no → 401
2. Is the engagement ACTIVE and the org ACTIVE?         no → 403   ← checked in the DB, not the JWT
3. Does MFA level meet this resource's requirement?     no → 403 step-up
4. Does any role grant this permission?                 no → 403
5. Does the scope (or a record_grant) cover this row?   no → 404   ← not 403
```

**[DECISION] Step 5 returns 404, not 403.** Answering "this exists but you may not see it"
confirms the record exists, which is itself a leak (threat T-07, §26).

### 7.5 The rule that must never be broken

> Frontend permission checks exist **only** so users aren't shown buttons that would fail.
> Deleting every check in the browser must not change what data any user can obtain.

The Playwright and RLS suites in §31 exist specifically to prove that claim, continuously, in CI.

Full permission matrix and data-visibility matrix: [security.md](../../architecture/security.md).

---

## 8. Department Architecture

Departments are configurable rows supporting an optional parent. Seeded: Executive, HR, Sales,
Software Development, Vibecoding/AI, Projects & Delivery, Marketing, Finance, Operations,
Legal & Compliance, Customer Success.

- `departments(id, org_id, code, name, parent_id, head_person_id, status)`
- `teams(id, department_id, name, lead_person_id)` — a team belongs to exactly one department
- `team_members(team_id, person_id, role_in_team)`
- Primary department comes from the active engagement; `person_departments` allows secondary
  membership (a developer who also sits in the AI team).

Archiving a department never deletes it: `status='ARCHIVED'` blocks new assignment while keeping
historical records resolvable. Reassigning that department's people is required first, enforced by
a service-layer check with a clear error rather than a silent orphan.

---

## 9. Employee Lifecycle

```
CANDIDATE ──► OFFER ──► PRE_ONBOARDING ──► ONBOARDING ──► ACTIVE
                                                            │
              ┌───────────────┬──────────────┬──────────────┤
              ▼               ▼              ▼              ▼
        ROLE_CHANGE    DEPT_TRANSFER      LEAVE      PERFORMANCE_REVIEW
              │               │              │              │
              └───────────────┴──────────────┴──────────────┘
                                    │
                         ┌──────────┴──────────┐
                         ▼                     ▼
                   NOTICE_PERIOD           SUSPENDED
                         │                     │
                         ▼                     │
                    OFFBOARDING ◄──────────────┘
                         │
                         ▼
                     ARCHIVED   (person retained, engagement closed, access revoked)
```

Every transition writes an `engagement_events` row **and** an audit entry. Status is never edited
freely; it moves through a transition function that validates the source state, so history is
always reconstructable.

**Access is derived from engagement state**, never set by hand. `ACTIVE` grants login;
`SUSPENDED`, `OFFBOARDING` and `ARCHIVED` do not (`NOTICE_PERIOD` is configurable). This is the
mechanism that makes §13 reliable rather than aspirational.

---

## 10. Intern Lifecycle

Interns use the same `people` + `engagements` spine, with `engagement_type = 'INTERN'` plus an
`internships` extension row carrying mentor, expected end date, review dates and outcome.

```
APPLICATION → SCREENING → INTERVIEW → SELECTED → OFFER → AGREEMENT
  → DOCUMENT_COLLECTION → ONBOARDING → ACTIVE
  → MID_REVIEW → FINAL_REVIEW
  → { COMPLETED | CONVERTED_TO_EMPLOYEE | TERMINATED | ABANDONED }
  → OFFBOARDING → ARCHIVED
```

Requirements the schema must carry, specific to interns:

- **Mentor is a separate relationship from manager.** Both are person references on the internship.
- **Expected end date is mandatory** and drives an automatic notification to HR and the mentor
  14 days before (configurable).
- **Conversion creates a new engagement on the same person** and closes the internship engagement.
  It never edits an intern record into an employee record.
- Completion-certificate issuance is a document workflow (§17), gated on `FINAL_REVIEW` complete.

**[NEEDS YOUR INPUT — LEGAL]** Whether a given intern is a trainee, an apprentice, or a fixed-term
employee is a legal classification with real consequences in India (stipend treatment, PF/ESI
applicability, Shops & Establishments obligations). **The system records the classification you
set; it cannot decide it for you.** This needs one round with an Indian employment lawyer, after
which the templates are fixed. See §26.

---

## 11. Recruitment Architecture

```
job_openings ──1:N──► applications ──1:N──► interviews ──1:1──► scorecards
      │                     │
      │                     └──N:1──► candidates (a `people` row, pre-hire)
      └── hiring_manager, department, headcount, status
```

Pipeline: `APPLIED → SCREENING → SHORTLISTED → INTERVIEW → SELECTED → OFFER_SENT → ACCEPTED →
HIRED`, with terminal branches `REJECTED`, `WITHDRAWN`, `ON_HOLD`.

Visibility rules that matter:

- HR sees all candidates. A **hiring manager sees only candidates for openings they own** —
  `candidates.view` at `DEPARTMENT` scope, further narrowed by opening ownership.
- **Interview feedback is write-once, then locked per interviewer**, and an interviewer cannot read
  anyone else's scorecard until they submit their own. This prevents anchoring; it is a real
  requirement, not a nicety, and it is enforced in RLS.
- Candidate CVs live in the private `hr-documents` bucket under the same signed-URL discipline as
  employee documents (§17). **A CV is personal data** (§26).
- `HIRED` is the only transition that creates the person promotion + engagement + onboarding
  instance, and it does so in a single transaction.

---

## 12. Onboarding Architecture

**[DECISION] Templates and instances, not a workflow engine.** A configurable checklist covers
100% of what PRAVSHI needs for the next two years. A BPMN-style engine covers 100% of what you
will never use, and costs roughly ten times as much to build and debug.

```
onboarding_templates ── scoped by (department, engagement_type)
        │
        └── onboarding_template_tasks (title, owner_role, offset_days, required, doc_type_id,
                                       is_access_task)
                        │
                        ▼  instantiated at HIRED
        onboarding_instances ──1:N──► onboarding_tasks
                                       (assignee, due_date, status, completed_at, evidence)
```

Seeded task set: offer signed · agreement signed · NDA signed · IP assignment signed ·
identity verification · emergency contact · corporate email created · PRAVSHI OS account ·
GitHub access · Drive access · project access · policies acknowledged · manager assigned ·
mentor assigned · equipment issued · training complete.

Every task has an **owner role**, so nothing lands on nobody.

Tasks that grant access (GitHub, Drive, OS account, project access) carry
`is_access_task = true`. This matters because **§13 auto-generates the revocation checklist from
the access tasks that were actually completed** — so offboarding can never forget a system that
onboarding granted. That linkage is the single most valuable idea in this section.

---

## 13. Offboarding Architecture

```
EXIT_INITIATED (manager or HR)
  → HR_REVIEW → WORK_HANDOVER → ASSET_RETURN
  → ACCESS_REVOCATION   ◄── auto-generated from completed access-granting onboarding tasks
  → EXIT_DOCUMENTS (relieving letter, experience letter, FnF acknowledgement)
  → ENGAGEMENT_CLOSED → ARCHIVED
```

Hard rules:

- The moment an engagement enters `OFFBOARDING`, **OS access is revoked** — not at the end of the
  checklist. Revocation deletes the person's session rows and stamps `sessions_revoked_at`; because
  sessions live in the database and RLS re-reads engagement status on every query, it takes effect
  on the very next request — there is no token that stays valid for another hour (§25).
- External systems (Google Workspace, GitHub) are **manual-with-attestation in V1**: the task
  requires the responsible person to confirm revocation, and that confirmation is timestamped and
  audited. V1 holds no admin credentials into Workspace or GitHub. Pretending otherwise would be
  worse than admitting it. Automation is Phase 9.
- Data is retained. `ARCHIVED` people are excluded from default queries by RLS, remain visible to
  `people.view` at `GLOBAL` scope, and fall under the retention policy in §26.

---

## 14. Sales Architecture

The existing Sales Sheet is treated as a **workflow reference**, not a schema.

```
leads ──(convert)──► clients ──1:N──► projects ──1:N──► tasks
  │                     │
  └── owner_person_id   └── owner_person_id
      department_id         account_manager
      status, priority      industry, status
      expected_value
      follow_up_date
```

**Leads.** `code` (LEAD-2026-0001), name, company, email, phone, source, owner, industry, status,
priority, expected value + currency, follow-up date, notes, timestamps, soft-delete.
Statuses are **configurable rows** (`pipeline_stages`), not an enum — you will change them, and a
schema migration per pipeline tweak is unacceptable.

**Conversion is an explicit, audited event.** A lead becomes a client (and optionally a project) in
one transaction that records `converted_from_lead_id`, preserving the full pre-conversion history.

**Visibility.** `SALES` gets `leads.view` at `SELF`, `SALES_MANAGER` at `DEPARTMENT` (or `TEAM`
once teams exist). Reassignment requires `leads.assign`. **Export requires `leads.export`, is
rate-limited, and writes a high-severity audit entry** — bulk export is how CRM data walks out the
door (threat T-11, §26).

**[DECISION] IDs are generated by the database**, via an `identity_counters` table and a
`next_code(prefix)` function inside the transaction. Immutable once issued. No spreadsheet-style
formula IDs, ever — they renumber on sort, which silently corrupts every reference.

**Migration from Sheets** is one-way, per module, and only after the module runs correctly:
export → transform → import into staging → verify counts and spot-check → import to production →
**set the Sheet to read-only with a banner pointing to PRAVSHI OS** → keep it read-only for 90 days
as a fallback → archive. The Sheet is never deleted (your rule 11).

---

## 15. Project Architecture

One `projects` table serves both client and internal work, distinguished by `project_type` and a
nullable `client_id`. Two separate tables would double every query, permission and report for no
benefit.

```
projects(code PRJ-2026-0001, name, type CLIENT|INTERNAL, client_id?, owner_person_id,
         department_id, status, priority, start_date, target_date, completed_at,
         progress_pct, visibility)
   ├── project_members(project_id, person_id, role_in_project, added_by, added_at)
   ├── milestones(project_id, name, due_date, status)
   ├── tasks(...)
   ├── project_links(label, url, kind: REPO | DOC | DESIGN | DRIVE)
   └── comments + activity (polymorphic, see §19)
```

`project_members` is the backbone of `PROJECT`-scoped access (§7.2): it is how a developer or
vibecoder gets exactly the access they need and nothing more. Membership changes are audited.

Lifecycle: `DRAFT → ACTIVE → ON_HOLD → COMPLETED → ARCHIVED`, with `CANCELLED` as a terminal branch.

---

## 16. Task Architecture

One `tasks` table, company-wide, polymorphically attachable so the Sales module and the Delivery
module share it rather than each growing their own.

```
tasks(code TSK-2026-000001, title, description, project_id?, client_id?, lead_id?,
      assignee_person_id, creator_person_id, priority, status, start_date, due_date,
      completed_at, estimate_hours?, parent_task_id?)
```

**[DECISION] Optional foreign keys rather than a generic `entity_type/entity_id` pair.** Real
foreign keys give referential integrity and fast joins; a generic pair gives neither. A check
constraint enforces that at most one context link is set.

Saved views (not new tables): My Tasks · Team Tasks · Overdue · Due Today · Upcoming · Unassigned ·
Completed. Every view is a filter over the same RLS-protected query, so **a view can never widen
visibility** — a critical property.

Base visibility: assignee and creator always; plus project members; plus manager chain at `TEAM`
scope; plus `GLOBAL` for admin roles.

---

## 17. Document Architecture

Two distinct things that must not share a code path:

| | **HR / Person documents** | **Corporate records** |
|---|---|---|
| Examples | Offer letters, agreements, NDA, IP assignment, IDs, certificates | Incorporation docs, contracts, financials, IP filings, insurance |
| Storage | **Cloudflare R2**, private bucket `pravshi-hr` | Google Drive (source of truth), indexed in PRAVSHI OS |
| Sensitivity | Highest — personal data | High — commercial |
| V1 scope | Full upload / download / verify lifecycle | **Index and link only** (§27) |

### 17.1 Metadata model

`documents(id, org_id, code, document_type_id, subject_person_id?, entity_type?, entity_id?,
status, access_level, current_version_id, storage_provider, storage_bucket, expires_at,
verified_by, verified_at, uploaded_by, created_at, deleted_at)`
plus `document_versions(document_id, version_no, storage_key, file_name, mime_type, size_bytes,
checksum_sha256, uploaded_by, uploaded_at, signed_at)`.

`storage_provider` exists so a document can live in R2 or in Drive without the rest of the system
caring which — the index is uniform even when the bytes are not.

`document_types` is configurable: name, category, required-for-engagement-types, requires
verification, requires signature, retention period, default access level.

### 17.2 The access path — the only path

```
user clicks Download
   → GET /api/documents/{id}/download        (server route; never a bucket URL)
   → authenticate  (session from the database, not a token blob)
   → authorize: documents.download + scope + access_level + subject relationship
   → write audit entry (actor, document, version, IP, user-agent)   ← BEFORE the URL exists
   → sign a 60-second presigned GET against the R2 object
   → 302 redirect
```

R2 buckets have **no public access and no custom domain binding**, so a leaked object key is
useless without a signature. Uploads use server-issued presigned PUT URLs with a content-type
allowlist and a size cap; the version stays `PENDING` until the server confirms the object landed
and records its checksum. Object keys are random UUID paths, never
`/hr/rahul-offer-letter.pdf` — filenames are metadata, not addresses.

V1 has no malware scanning; that is an accepted, documented gap with compensating controls
(threat T-08, §26).

Access levels on a document: `SELF_ONLY` · `HR_ONLY` · `MANAGER` · `DEPARTMENT` · `COMPANY`.
The subject of a document can always read their own documents unless the type is marked
`internal_only` — an internal background-check note, for example.

---

## 18. Policy Architecture

```
policies(code, name, category, owner_person_id, status DRAFT|ACTIVE|SUPERSEDED|RETIRED,
         requires_acknowledgement, review_date)
   └── policy_versions(policy_id, version, effective_date, document_id, change_summary)
        └── policy_acknowledgements(policy_version_id, person_id, acknowledged_at,
                                    ip_address, user_agent)
```

Acknowledgement is **per version**, never per policy. Publishing a new version re-opens
acknowledgement for everyone in the target audience and appears in their Pending Actions.
Acknowledgement rows are append-only, like audit entries — they are evidence.

Targeting: by engagement type, department, or role.

**[LEGAL]** An electronic acknowledgement recorded this way is good internal evidence. Whether it
constitutes a valid signature for a particular document under the Indian IT Act and Contract Act
depends on the document. Employment agreements, NDAs and IP assignments should be reviewed by
counsel, and may need a proper e-signature provider (Phase 9). **The system does not make a
document legally valid.**

---

## 19. Audit Architecture

```
audit_logs(id, org_id, occurred_at, actor_person_id?, actor_email_snapshot, actor_ip,
           user_agent, request_id, action, entity_type, entity_id, severity,
           before jsonb?, after jsonb?, metadata jsonb, result SUCCESS|DENIED|ERROR)
```

Non-negotiable properties:

1. **Append-only, enforced by the database.** `REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC,
   authenticated, anon;` plus a trigger raising an exception on UPDATE/DELETE. Not even
   SUPER_ADMIN can rewrite history through the application.
2. **Written by a `SECURITY DEFINER` function**, so the app can insert without holding table rights.
3. **Two sources.** Database triggers cover create/update/delete on sensitive tables (they cannot be
   forgotten). The application layer adds intent — logins, denied authorizations, downloads,
   exports, role changes, revocations — which triggers cannot see.
4. `request_id` correlates every entry from a single user action, so an incident is one query.
5. **Denials are logged too.** A burst of `result='DENIED'` is your primary intrusion signal.
6. Sensitive values are redacted before storage: no password hashes, no full ID numbers, no
   document contents — only references.
7. Readable only with `audit_logs.view` (SUPER_ADMIN, ADMIN, and a future compliance role).
8. Monthly partitioning from day one; 7-year retention for access, identity and HR events.

---

## 20. Database Architecture

Summarised here; full detail, DDL patterns and index plan in
**[database.md](../../architecture/database.md)**.

Conventions applied to every table without exception:

| Column | Rule |
|---|---|
| `id` | `uuid` primary key, default `gen_random_uuid()` |
| `org_id` | `uuid not null` on every tenant-scoped table, FK to `organizations` |
| `code` | Human identifier where users need one (`EMP-2026-0001`), unique per org, **immutable** |
| `created_at` / `updated_at` | `timestamptz not null default now()`, `updated_at` via trigger |
| `created_by` / `updated_by` | person FK where a human acted |
| `deleted_at` | Soft delete; RLS excludes non-null by default (§31 of your spec) |

Rules: no business logic in the ORM (there is no ORM); enums as reference tables wherever the
business will change them; every FK indexed; every RLS predicate column indexed; `citext` for
emails; `numeric(14,2)` for money with an explicit currency column — never floats.

**Multi-tenancy:** `org_id` is present and enforced from day one, in the schema and in every RLS
policy, but **no cross-organization UI exists in V1**. This is the cheapest possible option on a
future SaaS: adding the column later would be a migration across forty tables and a rewrite of
every policy.

---

## 21. ERD

Full entity-relationship diagram, with cardinalities, keys and security boundaries:
**[database.md § ERD](../../architecture/database.md#erd)**.

Top-level shape:

```
organizations
   └── people ──1:N── engagements ──N:1── departments ──1:N── teams
        │  │              │
        │  │              └── internships / employment_details
        │  ├── person_roles ──N:1── roles ──N:M── permissions   (with scope)
        │  ├── documents, policy_acknowledgements
        │  └── owns → leads, clients, projects, tasks
        │
   audit_logs (append-only, references everything, owned by nothing)
```

---

## 22. Page Map

```
/login                                  public
/login/mfa                              TOTP challenge
/invite/[token]                         accept invite, set credential
/access-denied                          403 landing with request-access CTA

/                                       → role-aware dashboard redirect
/dashboard                              personalised: my tasks, projects, leads,
                                        pending actions, announcements, documents due

/me                                     my profile
/me/documents                           my documents + what's outstanding
/me/policies                            policies awaiting my acknowledgement
/me/security                            sessions, MFA, password, login history

/people                                 directory (permission-filtered)
/people/employees
/people/employees/[personId]            overview · engagement · documents · access · history
/people/interns
/people/interns/[personId]
/people/onboarding                      active onboarding instances
/people/onboarding/[instanceId]
/people/offboarding
/people/offboarding/[instanceId]
/people/org-chart                       Phase 7

/hiring                                 recruitment home
/hiring/openings
/hiring/openings/[id]
/hiring/candidates
/hiring/candidates/[id]                 profile · CV · interviews · scorecards · decision
/hiring/interviews                      my scheduled interviews
/hiring/offers

/sales                                  sales dashboard
/sales/leads
/sales/leads/[id]
/sales/clients
/sales/clients/[id]
/sales/pipeline                         kanban by stage
/sales/reports

/projects
/projects/[id]                          overview · tasks · milestones · members · files · activity
/projects/my
/projects/internal

/tasks                                  all tasks I may see
/tasks/my
/tasks/team
/tasks/[id]

/documents
/documents/hr                           person documents (permission-gated)
/documents/corporate                    corporate records index (Drive-backed)
/documents/templates
/documents/[id]

/policies
/policies/[id]
/policies/[id]/acknowledgements         compliance view

/reports                                Phase 7

/admin
/admin/dashboard                        company-wide health + security signals
/admin/users                            accounts: invite, suspend, reset, revoke sessions
/admin/users/[id]
/admin/roles
/admin/roles/[id]                       permission grid with scope selector
/admin/permissions                      catalogue (read-mostly)
/admin/departments
/admin/teams
/admin/document-types
/admin/onboarding-templates
/admin/pipeline-stages                  configurable statuses
/admin/audit-logs                       filterable, exportable
/admin/access-requests                  Phase 8
/admin/settings                         org profile, branding, security policy, notifications
/admin/integrations                     Google Drive, GitHub — Phase 5+
```

**Improvements over your draft map,** and why:

- `/sales/projects` and `/sales/tasks` are **removed**. Projects and tasks are company-wide
  entities; duplicating them under Sales creates two mental models and two permission surfaces for
  the same rows. Sales users reach their projects through `/projects` filtered, or from the client
  record.
- `/people/candidates` moves to **`/hiring`**. Recruitment has a different audience, different
  permissions and a different lifecycle from employee administration.
- `/me/*` is added. Every employee needs a self-service surface — it is the most-visited area in
  systems like this, and it dramatically reduces HR interruptions.
- `/admin/*` gains the configuration surfaces the spec implies (document types, onboarding
  templates, pipeline stages) so that "don't hard-code business configuration" is actually
  achievable.

---

## 23. Navigation

Sidebar sections render **only if the user holds at least one permission inside them**, so an
intern sees a genuinely small app rather than a wall of locked doors.

```
  ● Home            /dashboard
  ● My Work         /tasks/my · /projects/my · /me/documents · /me/policies
  ● Sales           leads · clients · pipeline · reports        [sales.*]
  ● Projects        all · my · internal                          [projects.view]
  ● People          employees · interns · onboarding · offboarding  [people.view]
  ● Hiring          openings · candidates · interviews           [candidates.view]
  ● Documents       hr · corporate · templates                   [documents.view]
  ● Policies        policies                                     [all users]
  ● Reports         reports                                      [reports.view]
  ─────────────────────────────────────────
  ● Admin           users · roles · departments · audit · settings [admin perms]
```

Top bar: global search (§39 of spec, Phase 7) · notifications · theme toggle · profile menu.
Breadcrumbs on every detail page. Command palette (⌘K) in Phase 7.

**Design direction:** enterprise-restrained, not startup-flashy. Neutral greys with a single
PRAVSHI accent; one type family; dense but breathable tables; status expressed with a coloured dot
plus a text label (never colour alone — accessibility). Dark and light from day one via CSS
variables. Every table gets: search, filters, sort, pagination, column visibility, and an
**empty state that tells you what to do next**. Every destructive action gets a confirm dialog
that names the record.

---

## 24. API Architecture

**[DECISION] Server Actions for mutations, Route Handlers for everything that is not a form.**
There is no separate REST API in V1, because the only consumer is our own UI. A public API is
Phase 9, and the service layer is written so it can be exposed then without rewriting.

```
src/
  app/                     routes (pages, layouts, route handlers)
  modules/
    sales/
      actions.ts           'use server' — thin: parse → authorize → call service → revalidate
      service.ts           business logic + data access; the only place SQL lives
      schema.ts            Zod schemas, shared with the client
      queries.ts           read helpers for Server Components
      permissions.ts       this module's permission constants
  lib/
    authz/                 requirePermission, scope resolution, policy helpers
    audit/                 audit.log()
    db/                    Drizzle client + withAuthorizedDb() — the ONLY path to Postgres
    files/                 signed URL issuance
```

Every Server Action follows the same five steps, and a lint rule enforces that
`requirePermission` is the first statement:

```
1. getSession()            → 401 if absent
2. requirePermission(...)  → 403 if denied (and audit the denial)
3. schema.parse(input)     → 422 with field errors
4. service.doThing()       → business logic; DB enforces RLS underneath
5. audit.log() + revalidatePath()
```

Conventions: cursor pagination on every list (`?cursor=&limit=` capped at 100); a single error
envelope `{ error: { code, message, fields? } }` with codes, never raw database errors; idempotency
keys on create actions to survive double-clicks; rate limits on auth, export, download and search.

Route Handlers exist for exactly four things: file download/upload signing, auth callbacks,
scheduled jobs (Vercel Cron), and future integration webhooks.

---

## 25. Security Architecture

Full detail in **[security.md](../../architecture/security.md)**. Summary of the decisions:

**Authentication — Better Auth, self-hosted, Postgres-backed.** Users and sessions live in your own
database. Primary credential in V1 is **email + password**: minimum 12 characters, checked against a
breach list, hashed with a modern KDF by the library.

**There is no signup route.** Not "signup disabled in a dashboard" — no route exists. An account can
only come into being by an administrator issuing an invitation, and the invitation is single-use,
expiring, and stored hashed. This is a stronger guarantee than the Supabase-shaped design I first
proposed, where an OAuth provider could create a user behind your back and a guard trigger had to
catch it (threat T-01).

**Google Workspace is optional and additive.** The identity layer defines a provider interface from
day one; adding Google OAuth later means enabling a provider, adding a `hd`-claim check, and linking
the identity to the existing `people` row. **No table, policy, or permission changes.** If you do
adopt Workspace, switch on domain restriction and make it the primary provider then — the migration
is a configuration change, not a rewrite. That is the direct consequence of your answer to
question 1, and it costs nothing to preserve.

**MFA.** TOTP, available to everyone, **mandatory for SUPER_ADMIN, ADMIN, HR_ADMIN and FINANCE**.
Sensitive surfaces require `aal2`, and because the level is set into the transaction context
alongside the person id, **RLS itself can require it** — it cannot be skipped by calling an API
directly.

**Sessions are database-backed, and this is a genuine upgrade over the JWT design.** There is no
token carrying stale claims, so:

- Revocation is **immediate**, not "within one hour". Suspend an account, offboard a person, or
  revoke a session, and the very next request fails — because the session row is gone.
- Permission changes take effect on the next request, since permissions are resolved per request
  against the database rather than baked into a token.
- The staleness problem that forced the `session_epoch` mechanism simply does not exist. `people`
  keeps a `sessions_revoked_at` timestamp for bulk invalidation, which is simpler and exact.

Sessions are stored with a rolling expiry (30 days) and a short refresh window; cookies are
`HttpOnly`, `Secure`, `SameSite=Lax`.

**Database credentials and roles.** Three Postgres roles, and the separation replaces the
`service_role` discipline the Supabase design needed:

| Role | Used by | Rights |
|---|---|---|
| `app_owner` | Migrations only, from CI | Owns the schema. **Never** used by the application, and its credential is **never present in the Vercel runtime environment** — it lives in GitHub Actions and on developer machines only. `src/env.ts` refuses to boot in production if it appears. |
| `app_user` | The application at runtime | `SELECT/INSERT/UPDATE` on business tables. **No `BYPASSRLS`.** Cannot alter schema, cannot `UPDATE`/`DELETE` `audit_logs`. |
| `app_admin` | Three audited server paths: bootstrap, provisioning, the audit writer | Narrow `SECURITY DEFINER` function access only — not a superuser. |

**The application never connects as the database owner.** A CI check asserts that the runtime
`DATABASE_URL` resolves to a role without `BYPASSRLS` and without table ownership — because a
project that connects as owner has RLS that looks enabled and does nothing, which is the most
dangerous failure mode available here. It fails silently, in your favour, until it doesn't.

**Transport and headers.** HTTPS only, HSTS with preload, a strict Content-Security-Policy with no
`unsafe-inline`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a
locked-down `Permissions-Policy`.

**Input.** Zod at every boundary. Parameterised queries only — Drizzle parameterises by
construction, and raw SQL uses its tagged template, never string concatenation. Output is encoded by
React; any `dangerouslySetInnerHTML` requires sanitisation and a code-owner review.

**Rate limiting.** Login, password reset, invitation acceptance, file download, search and export.

**Secrets.** Vercel and GitHub environment stores only. `.env*` git-ignored; `.env.example`
committed with documentation and no values. GitHub secret scanning with push protection on.
**Any secret that ever touches a commit is rotated, not deleted** — including the Neon connection
string and the R2 access keys.

> I will never tell you this system is "100% secure", and you should distrust anyone who does.
> Before real HR data goes in, a third-party security review is money well spent (§37).

---

## 26. Threat Model

Full table with tests in **[security.md § Threat Model](../../architecture/security.md#threat-model)**.
The threats that most shape the architecture:

| ID | Threat | Primary mitigation |
|---|---|---|
| T-01 | Unauthorised account creation | **No signup route exists**; accounts come only from single-use, expiring, hashed invitations |
| T-02 | Broken access control on a new endpoint | `requirePermission` lint rule + RLS backstop + CI permission matrix |
| T-03 | Privilege escalation (HR grants itself SUPER_ADMIN) | Protected-role rule in SQL (§6.2) + audit + alert |
| T-04 | IDOR — reading `/people/{someone-else}` | RLS on every table; 404 not 403; E2E tests per role |
| T-05 | Access retained after termination | Engagement-derived access, re-checked in the database on every query; sessions are rows, so deleting them is instant |
| T-06 | Stolen session token | Short TTL + rotation + MFA on sensitive roles + revocation |
| T-07 | Existence disclosure through search or errors | Permission-filtered search; 404 for out-of-scope; generic errors |
| T-08 | Malicious file upload | Private buckets, no execution path, type/size allowlist, no inline rendering of user files. **No AV scanning in V1 — documented gap** |
| T-09 | Public storage bucket misconfiguration | Buckets private by default; CI test asserts no public bucket exists |
| T-10 | App connects with a role that bypasses RLS, so every policy silently does nothing | Runtime role `app_user` — not owner, no `BYPASSRLS`; `FORCE ROW LEVEL SECURITY`; CI asserts all three |
| T-11 | Bulk data exfiltration by an insider | Export permission separated, rate-limited, high-severity audit, admin alert |
| T-12 | Audit log tampering | Append-only grants + trigger + no UPDATE path anywhere |
| T-13 | Over-permissioned admins | Least privilege by default; quarterly access review report (Phase 8) |
| T-14 | Personal data exposure (DPDP Act 2023) | Data minimisation, access levels, retention policy, audit of every document view. **Note: data is stored in Singapore, not India** — see the cross-border question below |

**Where professional review is genuinely required — do not skip these:**

1. **Indian employment lawyer** — intern/employee classification, offer and internship agreement
   templates, NDA and IP assignment enforceability, PoSH Act obligations (an Internal Committee is
   mandatory once you have 10 or more employees), termination and notice terms.
2. **Chartered Accountant** — stipend and salary treatment, PF/ESI thresholds, TDS, contractor
   payments.
3. **Company Secretary** — statutory registers and corporate records structure (§18 of your spec).
4. **Data-protection counsel** — a DPDP Act 2023 posture for employee personal data: notice,
   purpose limitation, retention, and your obligations as a Data Fiduciary.
   **Add one question now that the region is settled: employee personal data will be stored in
   Singapore.** The DPDP Act permits cross-border transfer except to countries the government
   restricts by notification, so this is very likely fine — but "very likely" is not advice, the
   position can change by notification, and sectoral rules may differ. Confirm before real HR data
   is loaded, and record the answer.
5. **Third-party security review** — before production data, ideally an external RLS and access
   control audit.

**This system will store legal documents and record acknowledgements. It does not make anything
legally compliant, and I will not describe it as compliant.**

---

## 27. Google Drive Architecture

Three options, evaluated:

| Option | What it is | Verdict |
|---|---|---|
| **A. Index and link** | Store `drive_file_id` + URL + metadata in PRAVSHI OS; open in Drive | **V1.** Zero credentials, zero sync risk, delivers the "structured index" you asked for |
| **B. Read-only mirror** | Service account with domain-wide delegation reads Shared Drive metadata into the index automatically | **Phase 5.** Real value, moderate risk |
| **C. Two-way sync** | OS writes files and permissions into Drive | **Not recommended.** Two sources of truth, permission drift, high blast radius |

The warning that matters most, stated plainly:

> **A link in PRAVSHI OS is not access control.** If a Drive file is shared "anyone with the
> link", hiding the link in the OS protects nothing. Drive permissions must be managed in Drive.

The workable pattern: put corporate records in **Shared Drives** (not personal My Drive), grant
access via **Google Groups that mirror your departments** (`sales@`, `hr@`, `eng@`), and make
offboarding remove group membership. PRAVSHI OS then indexes and audits, and Drive enforces. The
seventeen corporate categories in your §18 become the Shared Drive folder taxonomy and the OS
index taxonomy simultaneously.

**[NEEDS YOUR INPUT]** Do you have Google Workspace on `pravshi.com` with admin access, or is this
personal Gmail? The answer changes both this section and the auth design in §25.

---

## 28. GitHub Architecture

Organisation `pravshi`, repository `pravshi-os`, **private**.

| Team | Members | Repo permission |
|---|---|---|
| `owners` | Founder only | Admin (org owner) |
| `maintainers` | Senior/trusted engineer | Maintain |
| `developers` | Development interns | Write (branches only) |
| `vibecoders` | Vibecoder interns | Write (branches only) |
| `reviewers` | Whoever reviews | Triage |

**No intern is ever an organisation owner** (your rule, and correct).

Branches: `main` (production, protected) ← `develop` (integration) ← `feature/*`, `fix/*`,
`chore/*`. Protection on `main` and `develop`: pull request required, at least one approval,
CI must pass, no force-push, no deletion, conversation resolution required, and CODEOWNERS review
required for `drizzle/**` and `src/lib/authz/**` — the two directories where a mistake
is a breach.

Repository hygiene from commit one: secret scanning + push protection, Dependabot, CodeQL, a
`.env.example` with no values, and a PR template whose checklist includes *"Does this change
permissions or RLS? If yes, which tests prove it?"*

Documentation set (written as they become true, not upfront):
`README` · `ARCHITECTURE` · `DATABASE` · `SECURITY` · `DEVELOPMENT` · `DEPLOYMENT` ·
`ENVIRONMENT` · `ACCESS-CONTROL` · `INCIDENT-RESPONSE` · `CONTRIBUTING`.

---

## 29. Deployment Architecture

### 29.1 Environments — Neon branches, not separate projects

| | Development | Staging | Production |
|---|---|---|---|
| Database | Neon branch `dev/<name>`, one per developer, disposable | Neon branch `staging` | Neon branch `production` (default) |
| Vercel | `localhost` | Preview deployments | `os.pravshi.com` |
| Data | Seed data only, never real | Seed data | Real |
| Access | All developers | All developers | **Founder + one maintainer** |
| Migrations | Applied freely; branch is thrown away when wrong | Automatic on merge to `develop` | **Manual approval gate** on merge to `main` |

Branching is the reason this is better than three separate databases: a developer who breaks their
schema deletes the branch and makes a new one from production's structure in seconds, and a pull
request can run its migration against an **ephemeral branch created for that PR** and destroyed on
merge. Migration review stops being an act of faith.

**Interns never receive production credentials.** Hard rule, and the reason the seed data in
[database.md §10](../../architecture/database.md) exists.

Deployment path: PR → ephemeral Neon branch → CI (typecheck, lint, unit, RLS suite, permission
matrix, E2E) → merge to `develop` → staging migrates and deploys → verify → PR to `main` →
**manual approval** → production migration → production deploy → smoke test.

### 29.2 GitHub

The `pravshi` organisation already exists, owned by the account `prasanthnaidu0987@gmail.com` —
which is **not** the account this work is being done from. Before Phase 0 can complete, one of two
things has to happen: either that account grants your working account the **Owner** role on the
organisation, or that account performs the six setup steps below itself.

Owner-level actions required (nobody else can do these):

1. Create the private repository `pravshi/pravshi-os`.
2. Create the teams from §28 and set repository permissions.
3. Enable branch protection on `main` and `develop`.
4. Enable secret scanning **with push protection**, Dependabot, and CodeQL.
5. Create the GitHub Environments `staging` and `production`, with **required reviewers** on
   `production`.
6. Add the Actions secrets: `NEON_API_KEY`, `DATABASE_URL_STAGING`, `DATABASE_URL_PRODUCTION`,
   `VERCEL_TOKEN`, `R2_*`, `RESEND_API_KEY`.

Incidentally, this splits credential custody across two accounts from day one, which is exactly what
risk R3 asks for. Make it deliberate rather than accidental: write down who holds what.

### 29.3 DNS — GoDaddy registrar, Cloudflare in front

**First, establish which service is actually authoritative**, because the record goes in one place
and only one:

```
nslookup -type=NS pravshi.com
```

- **If the answer is `*.ns.cloudflare.com`** — the usual arrangement — GoDaddy is only the
  registrar, and **all records are managed in the Cloudflare dashboard**. Adding it at GoDaddy will
  do nothing at all, silently, which is a genuinely confusing hour to lose.
- **If the answer is `*.domaincontrol.com`**, GoDaddy still serves DNS and the record goes there.

**The record**, in whichever service is authoritative:

| Type | Name | Value | TTL | Proxy |
|---|---|---|---|---|
| `CNAME` | `os` | `cname.vercel-dns.com` | Auto / 300 | **DNS only — grey cloud** |

**[DECISION] Grey cloud, not orange.** Vercel already provides a CDN and issues the TLS certificate
automatically. Proxying through Cloudflare on top of it means two CDNs in series, and it blocks
Vercel's certificate issuance unless you also configure Cloudflare's origin certificates and set SSL
mode to **Full (strict)**. That is real complexity bought for no benefit. If you later want
Cloudflare's WAF specifically in front of the app, turn the proxy on **after** the certificate is
issued and switch SSL to Full (strict) in the same change — never before.

**Do not touch the apex.** `pravshi.com` keeps pointing wherever your marketing site lives. This
change adds one subdomain and alters nothing else.

Verify with `dig os.pravshi.com` before assuming a failure is Vercel's; propagation on a 300-second
TTL is minutes, not hours.

### 29.4 Bootstrap

Runs once, reads `BOOTSTRAP_OWNER_EMAIL` from the environment, and in a single transaction creates
the organization, seeds every role and permission, creates the owner `people` row, an `ACTIVE`
engagement, and the SUPER_ADMIN grant, then writes an audit entry and prints a **one-time setup
link** for the owner to set their password and enrol MFA. It **refuses to run if any SUPER_ADMIN
already exists.** No email address is ever compiled into the application (spec rule 8).

Complete `.env.example`, with every variable explained and no values, ships with Phase 0 (spec §61).

---

## 30. Backup & Recovery

| Layer | Mechanism | Frequency | Retention |
|---|---|---|---|
| Database | **Neon history retention** — restore to any point inside the window by branching from a timestamp | Continuous | Free tier is short (hours). **Extend this before Phase 5.** |
| Database | `pg_dump` from GitHub Actions → encrypted into Cloudflare R2 | Nightly | 30 daily, 12 monthly |
| Database | A named Neon branch taken immediately before every production migration | Per deploy | 7 days |
| Files | R2 bucket versioning + a weekly copy to a second bucket in another region | Continuous / weekly | 30 days |
| Schema | Migrations in git | Every change | Forever |
| Config | Documented in the repo; secrets in a password manager | On change | — |

Neon's restore model is worth understanding because it is genuinely different from a backup file:
you **branch from a past timestamp**, inspect the result, and then promote it. That makes "restore
to 20 minutes before the bad migration" a two-minute operation rather than an outage — but it only
works inside your history-retention window, and on the free tier that window is short. **Extending
retention is the one thing on this list worth paying for**, and it should be done before real HR
documents exist.

The nightly `pg_dump` is not redundant with that. It protects against the case Neon's own retention
cannot: losing access to the Neon account itself. A backup that lives only inside the system it is
backing up is not a backup.

**Targets: RPO 24 hours — minutes, inside the retention window. RTO 4 hours.** These are
meaningless until proven, so: **a restore drill every quarter**, restoring into a scratch branch,
timed and written up. A backup you have never restored is a hope.

The recovery runbook, the incident-response process, and the data-export procedure — an employee's
right to their own data under the DPDP Act — are written in Phase 8, before launch.

---

## 31. Testing Strategy

**[DECISION] The permission test suite is written in Phase 1, before any business module.** It is
the one piece of infrastructure that pays for itself in every subsequent phase, because it lets you
build fast without wondering whether you just leaked HR data.

| Layer | Tool | What it proves |
|---|---|---|
| Unit | Vitest | Scope resolution, code generation, state transitions, date logic |
| Integration | Vitest + test database | Services enforce permissions and write audit entries |
| **RLS / database** | pgTAP or SQL run as impersonated JWTs | **Rows are invisible even to raw SQL from the wrong user** |
| **Permission matrix** | Data-driven Vitest suite generated from [security.md](../../architecture/security.md) | Every (role × permission × scope) cell behaves as documented |
| API authorization | Vitest + fetch | Every Server Action and Route Handler rejects the unauthorised |
| E2E | Playwright, one session per seeded role | Real journeys work, and forbidden URLs 404 |
| Security regression | Playwright + CI scripts | No public buckets; runtime role cannot bypass RLS; every table has RLS enabled and forced; headers present |

The specific assertions from your §59, each becoming a named test: Sales cannot read HR · Intern
cannot read Finance · Developer cannot read HR · HR cannot modify SUPER_ADMIN · suspended users
cannot log in · offboarded users lose project access · direct URLs do not bypass scope · the API
does not honour permissions the UI hid.

**Anything that touches `src/lib/authz/**` or `drizzle/**` requires a test in the same
PR.** Enforced by CODEOWNERS review, not by good intentions.

---

## 32. MVP Scope

V1 is the smallest system that lets PRAVSHI stop using the Sheet without losing control.

**In V1:** authentication and invitations · users, roles, permissions, scopes · departments and
teams · people, engagements, employees, interns · Sales CRM (leads, clients, pipeline) ·
projects and tasks · HR documents with secure storage · policies and acknowledgement ·
onboarding and offboarding checklists · recruitment (openings, candidates, interviews) ·
role-aware dashboards · audit logs · admin configuration surfaces.

**Explicitly not in V1,** with the reasoning: performance reviews and KPIs (needs a year of real
data to model well) · leave and attendance (needs the legal position settled first) · the approval
framework (only two workflows need it today; build it when there are five) · access requests ·
global search · analytics and reports beyond dashboard counters · email notifications beyond
invites · Google Drive API integration · AI · public API · mobile app.

**Cut this if you need to ship sooner:** recruitment (Phase 6) can wait — hiring works on a
spreadsheet in a way sales does not.

---

## 33. Future Scope

Phase 9 and beyond, roughly in the order the value arrives: approvals framework → access requests →
global search with a command palette → email and digest notifications → performance and goals →
leave and attendance → Google Drive API mirror → GitHub and Workspace provisioning automation →
reporting and analytics → e-signature integration → permission-aware AI assistants → public API →
optional multi-tenant SaaS.

**On the SaaS question:** the architecture keeps that door open at near-zero cost (`org_id`
everywhere, no hard-coded owner, configurable everything). But do not build a single feature *for*
external customers until PRAVSHI has used the system internally for at least six months. Your rule
20 and my recommendation agree here.

---

## 34. Development Phases

Detail, task lists and exit criteria: **[build-plan.md](../../architecture/build-plan.md)**.

| Phase | Deliverable | Est. (solo, AI-assisted) |
|---|---|---|
| 0 | Foundation: repo, environments, CI, design system, `.env.example` | 1 week |
| **1** | **Identity & Access core: auth, RBAC, RLS, audit, admin users — plus the permission test harness** | **2–3 weeks** |
| 2 | People: profiles, engagements, employees, interns, lifecycle | 2 weeks |
| 3 | Sales CRM + Sheets migration | 2 weeks |
| 4 | Projects & tasks | 2 weeks |
| 5 | Documents, secure storage, policies | 2 weeks |
| 6 | Recruitment, onboarding, offboarding | 2–3 weeks |
| 7 | Dashboards, notifications, search | 2 weeks |
| 8 | Hardening, backups, runbooks, security review, launch | 1–2 weeks |
| | **Total to production** | **~16–19 weeks** |

**Phase 1 is the keystone.** Everything after it is comparatively mechanical. If Phase 1 is rushed,
every later phase inherits the debt, and the debt is measured in incidents.

---

## 35. Estimated Complexity

| Dimension | V1 estimate |
|---|---|
| Tables | 42–48 |
| Permissions | ~120 |
| RLS policies | ~90 (kept low by shared `authz.*` helper functions) |
| Pages / routes | ~60 |
| Server Actions | ~120 |
| Application code | 18,000–25,000 lines |
| SQL migrations | 30–40 files |
| Tests | 350–500 |

This is a genuinely substantial system — comparable to a small commercial SaaS product. It is
achievable solo with AI assistance in the timeline above **only** if the phase gates are respected
and scope does not grow mid-phase.

---

## 36. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Scope explosion** — 14 modules, all "urgent" | High | High | Phase gates; no new module until the previous one is in real production use for two weeks |
| R2 | RLS complexity slows development or produces subtle holes | Medium | High | Shared `authz.*` helpers; test harness first; policy review checklist |
| R3 | **Bus factor of one** | High | High | Documentation as you go; boring stack; no clever abstractions; ARCHITECTURE.md kept current |
| R4 | Dual source of truth during Sheets migration | High | Medium | One-way, per-module cutover; read-only Sheet with a banner; 90-day fallback |
| R5 | Legal exposure from intern classification or templates | Medium | High | Professional review before Phase 6 ships (§26) |
| R6 | Neon lock-in or pricing change | Low | Low | Plain Postgres, no proprietary extensions, no vendor auth function in any policy; exit is a `pg_dump` and a connection-string change |
| R7 | Interns given production access "just this once" | Medium | High | Environment separation is a hard rule; production credentials held by two people |
| R8 | RLS performance degrades as data grows | Low (at your scale) | Medium | Index every predicate column; `(select …)` initplan pattern; monitor slow queries |
| R9 | Nobody adopts it and the team drifts back to Sheets | Medium | High | Ship Sales first (highest daily pain); make the Sheet read-only; dogfood before mandating |
| R10 | Storing personal data without a DPDP posture | Medium | High | Data minimisation now; retention policy in Phase 8; counsel review (§26) |

R1, R3 and R9 are the ones that actually kill projects like this. R2 gets the attention; R1 does
the damage.

---

## 37. Recommended Decisions

1. **Build Phase 1 properly, even when it feels slow.** Identity and access is the product; the rest
   is CRUD.
2. **Extend Neon's history retention before Phase 5.** Region is settled (Singapore); retention is
   now the cheapest insurance on this list (§30), and the default window is short.
3. **Keep authentication provider-agnostic and decide Google Workspace on its own merits, later.**
   The design now costs you nothing to defer it. If you do adopt Workspace, the win is real — one
   identity, one offboarding action, MFA enforced centrally — but it is no longer a prerequisite for
   anything.
4. **Ship Sales first among the business modules** (Phase 3, before projects and tasks). Confirmed:
   it is where the daily pain and the adoption win are.
5. **Drive stays index-only until Phase 5.** Do not take on API credentials before you need them.
6. **Do not build the approvals framework, performance module, or leave module in V1.** They will be
   wrong if built before you have real data.
7. **Book the employment-lawyer conversation before Phase 6**, not after — the templates it produces
   are inputs to onboarding.
8. **Pay for one external security review** before real HR data is loaded. It is the cheapest
   insurance available for a system holding identity documents.
9. **Two humans hold production credentials.** The GitHub organisation already splits custody
   between two accounts — make that deliberate and write down who holds what, rather than leaving it
   an accident of how the org was created.
10. **Every phase ends with the previous phase in real use.** Not demoed — used.
11. **The application must never connect to Postgres as the schema owner.** Let CI assert that the
    runtime role has neither `BYPASSRLS` nor table ownership. This replaces the `service_role`
    discipline a Supabase design would have needed, and it guards against the worst failure mode
    available here: RLS that appears enabled and quietly does nothing.
12. **Do not commercialise before six months of internal use.** The internal product is the
    validation.

---

## 38. Exact Next Steps

### 38.1 Answers received — 6 September 2026

| # | Question | Answer | Effect on the architecture |
|---|---|---|---|
| 1 | Google Workspace | **Not decided.** Must not be a Phase 0 dependency. | Auth is now a self-hosted, provider-agnostic layer (§25). Google OAuth is an additive switch later, with no schema or permission changes. |
| 2 | DNS | **GoDaddy registrar, Cloudflare proxy/CDN.** | §29.3: establish which service is authoritative, then one `CNAME os → cname.vercel-dns.com`, **grey cloud**. |
| 3 | GitHub | **`pravshi` org exists**, owned by `prasanthnaidu0987@gmail.com`. Private repo `pravshi/pravshi-os`. | §29.2: six owner-level setup actions, which need either an Owner grant to the working account or the owner performing them. |
| 4 | Database | **Neon Postgres, already provisioned.** No Supabase. | The largest change. Neon gives Postgres but not auth or storage: Better Auth replaces one, Cloudflare R2 the other, and RLS is now driven by `SET LOCAL` session context instead of a vendor JWT (§3, §4, §17, §25). Running cost drops to roughly $0–20/month. |
| 5 | Build order | **Confirmed in full and fixed:** 0 Foundation · 1 Identity/Auth/RBAC/RLS/Audit · 2 People · 3 Sales CRM · 4 Projects & Tasks · 5 Documents/Policies · 6 Recruitment/Hiring · 7 Dashboards/Notifications/Search · 8 Hardening/Launch. | No change — this is the order already in §34. Sales is the immediate business priority; Projects & Tasks follows it. Not to be reordered. |

### 38.2 Outstanding before Phase 0

The founder will supply these two; Phase 0 does not start until both are in hand:

1. ~~The Neon project's region.~~ **Answered: AWS Asia Pacific 1, Singapore.** Vercel moves to
   `sin1` as a consequence, and the cross-border data question in §26 is now live.
2. **Confirmation that GitHub Organization Owner access is sorted** — either an Owner grant on the
   `pravshi` organisation, or the owner account performing the six actions in §29.2. **Still
   outstanding**, and it blocks four specific Phase 0 tasks (see the Phase 0 plan).

Resolved *during* Phase 0, not before it — no action needed now:

3. **Which service is authoritative for `pravshi.com` DNS.** One `nslookup` answers it (§29.3). If
   the nameservers are Cloudflare's, the record goes in Cloudflare and adding it at GoDaddy does
   nothing at all, silently.

### 38.3 Phase 0, on your approval

1. Initialise the repository and push to `pravshi/pravshi-os`, private.
2. Configure the Neon branches: `production`, `staging`, and a `dev/*` pattern; create the
   `app_owner` / `app_user` / `app_admin` roles and prove that `app_user` cannot bypass RLS.
3. Create the Vercel project, pin functions to `sin1`, wire the three environments.
4. Create the Cloudflare R2 buckets, private, with the presigned-URL credentials scoped to them.
5. Scaffold Next.js + TypeScript + Tailwind + shadcn/ui with the module structure from §24, plus
   Drizzle and the `withAuthorizedDb()` helper — that helper exists before the first table does.
6. Write `.env.example`, `README`, `ARCHITECTURE`, `SECURITY`, `CONTRIBUTING`.
7. Set up GitHub Actions CI, branch protection, CODEOWNERS, and the ephemeral-Neon-branch-per-PR job.
8. Add the DNS record and deploy an empty authenticated shell to `os.pravshi.com` — confirming the
   whole pipeline works end to end **before** a single business feature exists.

Phase 0 exists so that the first time you deploy is not also the first time you discover that DNS,
environment variables, database roles and migrations are broken.

---

## Appendix: Decomposition note

Per the brainstorming process, this specification covers a **program**, not a single project. Each
phase in §34 gets its own focused spec and implementation plan before it is built. This document is
the constitution they all answer to; it should be revised deliberately, and every revision should
be a commit with a reason.

**The build plan follows: [PRAVSHI OS V1 BUILD PLAN](../../architecture/build-plan.md).**
