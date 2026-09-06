# PRAVSHI OS — V1 BUILD PLAN

Companion to the [Master Blueprint](../superpowers/specs/2026-09-06-pravshi-os-master-blueprint.md).
**Phase order confirmed by the founder on 2026-09-06 and fixed. No application code has been written.**

> **The order below is not to be changed.** Sales (Phase 3) is the immediate business priority, and
> Projects & Tasks (Phase 4) follows it. Any future proposal to resequence needs an explicit founder
> decision, not a judgement call mid-build.

---

## How this plan works

Nine phases. Each has a **deliverable**, an **exit criterion**, and a **demo** — the thing you can
actually do at the end. A phase is not finished when the code exists; it is finished when the exit
criterion is met and the previous phase is in **real use**.

Three rules that make the difference between shipping and drifting:

1. **No phase starts until the previous one's exit criterion is met.** Not "mostly met".
2. **Each phase gets its own spec and implementation plan** before code. This document is the
   program; those are the projects.
3. **No new module until the last one has been used by real people for two weeks.** Adoption is the
   test that matters, and it is the one this kind of project usually fails.

Estimates assume a solo founder working with AI assistance at a steady pace. They are ranges because
Phase 1 in particular rewards care.

---

## Phase 0 — Foundation · 1 week

Nothing user-facing. The purpose is that the first production deploy is boring.

- Private repo `pravshi/pravshi-os`; `main` / `develop` branches; protection rules; CODEOWNERS
  covering `drizzle/**` and `src/lib/authz/**`; PR template with the permissions question
- **Blocked until resolved:** the six org-owner actions in Blueprint §29.2 need either an Owner grant
  on the `pravshi` organisation or the owner account performing them
- Next.js 15 + TypeScript strict + Tailwind v4 + shadcn/ui; the module folder structure from
  Blueprint §24
- Neon branches `production`, `staging` and the `dev/*` pattern; the `app_owner` / `app_user` /
  `app_admin` roles created — and `app_user` **proven** unable to bypass RLS before anything is built
  on top of it
- Cloudflare R2 buckets, private, with presigned-URL credentials scoped to them
- Vercel project, functions pinned to `sin1` (co-located with Neon Singapore); preview deployments from PRs
- GitHub Actions: typecheck, lint, test, build; the runtime-role assertion (no `BYPASSRLS`, owns
  nothing); the "every table has RLS enabled **and forced**" migration linter; an ephemeral Neon
  branch per pull request (all pass trivially now, and stay honest later)
- `.env.example` fully documented, no values; secrets in Vercel and GitHub environment stores
- `README`, `ARCHITECTURE`, `SECURITY`, `CONTRIBUTING`, `DEVELOPMENT`
- Sentry; a `/health` route; the `os` CNAME added in whichever service is authoritative for DNS
  (Blueprint §29.3), **grey-clouded**, TLS verified against a placeholder page
- The design system foundation: colour tokens, typography scale, spacing, dark/light, and the
  shared shell (sidebar, top bar, page header, table, empty/loading/error states)

**Exit:** a signed-out placeholder page is live at `os.pravshi.com`, deployed through the full CI
pipeline, with a migration applied to production and error reporting confirmed working.
**Demo:** "Here is the site, here is the pipeline that put it there."

---

## Phase 1 — Identity & Access Core · 2–3 weeks · **THE KEYSTONE**

Everything else in this plan is comparatively mechanical CRUD. This phase is the product.

**Database:** `organizations` · `people` · `engagements` · `engagement_events` · `departments` ·
`teams` · `team_members` · `roles` · `permissions` · `role_permissions` · `person_roles` ·
`record_grants` · `invitations` · `audit_logs` (partitioned) · `login_events` · `identity_counters`

**The `authz` schema** — every helper function from [database.md §4.1](database.md), the standard
policy template, and RLS enabled on all of the above.

**Auth (Better Auth, self-hosted):** email + password with a breach-list check · **no signup route
at all** · invitation flow (create → email via Resend → accept → set credential) · TOTP MFA with
`aal2` required for privileged roles · database-backed sessions with immediate revocation · a
provider interface left open so Google OAuth is a later switch rather than a rewrite

**The `withAuthorizedDb()` bridge** — transaction, `SET LOCAL app.*`, RLS context. Built **before**
the first business table, because every later phase depends on it being the only way in.

**Bootstrap:** the idempotent, env-driven first-SUPER_ADMIN script that refuses to run twice.

**Application layer:** `requirePermission` · scope resolution · the audit writer · the lint rule
enforcing the check comes first · the error envelope.

**UI:** login, MFA challenge, invite acceptance, access-denied, the app shell with
permission-filtered navigation, `/admin/users`, `/admin/roles` (the permission grid with scope
selectors), `/admin/departments`, `/admin/audit-logs`, `/me/security`.

**Tests — written in this phase, not later:** the full harness from
[security.md §5](security.md#5-testing-strategy), with the eight seeded fixture accounts.

**Exit:** every assertion in security.md §5.2 passes in CI; you can invite a real person, assign
roles and scopes, watch them log in, suspend them, and see all of it in the audit log.
**Demo:** invite someone, give them a role, take it away, show the trail.

> If this phase feels slow, that is it working. Rushing here is the only decision in this plan that
> cannot be corrected later.

---

## Phase 2 — People · 2 weeks

**Database:** `employment_details` · `emergency_contacts` · `person_departments` · `internships` ·
document-type stubs.

**Features:** employee directory with permission-filtered columns · person detail (overview,
engagement, history, access) · engagement creation and the transition state machine · intern
records with mentor, dates and reviews · `/me` self-service profile · org chart data (rendered in
Phase 7) · sensitive-field policies for DOB, compensation and emergency contacts.

**Exit:** every real PRAVSHI person exists in the system with the correct role, department, manager
and engagement type; HR can manage them; nobody can see what the matrix says they cannot.
**Demo:** the real team, in the real directory, with the real hierarchy.

---

## Phase 3 — Sales CRM · 2 weeks

The first module that changes daily working life — which is why it comes before Projects.

**Database:** `leads` · `clients` · `client_contacts` · `pipeline_stages` (configurable) ·
`lead_activities`.

**Features:** lead list with search, filters, sort, pagination, saved views · lead detail with an
activity timeline · pipeline kanban · lead → client conversion as one audited transaction ·
follow-up dates driving a "due today" view · owner assignment with `leads.assign` ·
export behind its own permission, rate-limited and audited · a basic sales dashboard.

**Migration:** export the Sheet → transform → import to staging → verify counts and spot-check
against source → import to production → **set the Sheet read-only with a banner pointing here** →
keep it as a 90-day fallback → archive. One-way. Never deleted.

**Exit:** the sales team works in PRAVSHI OS for a full week without opening the Sheet.
**Demo:** the Sheet, read-only, with a banner.

---

## Phase 4 — Projects & Tasks · 2 weeks

**Database:** `projects` · `project_members` · `milestones` · `tasks` · `task_comments` ·
`project_links`.

**Features:** project list and detail (overview, tasks, milestones, members, links, activity) ·
member management, which is what `PROJECT`-scoped access actually runs on · tasks with the standard
views (my, team, overdue, due today, upcoming, unassigned) · comments and activity history ·
developer and vibecoder dashboards.

**Exit:** a developer and a vibecoder can each see exactly their assigned projects and tasks, and
provably nothing else.
**Demo:** log in as an intern; the app is small and correct.

---

## Phase 5 — Documents & Policies · 2 weeks

**Database:** `document_types` · `documents` · `document_versions` · `policies` ·
`policy_versions` · `policy_acknowledgements`.

**Storage:** private Cloudflare R2 buckets · server-issued presigned PUT URLs with content-type and
size validation · random UUID object keys ·
the download route with authorize-then-audit-then-sign · access levels · versioning · verification
workflow.

**Features:** HR document management per person · required-documents tracking with outstanding
indicators · the corporate records index (Drive **link-only**, per Blueprint §27) · policy
publishing, versioning and acknowledgement · a compliance view of who has acknowledged what ·
`/me/documents` and `/me/policies`.

**Exit:** no document byte is reachable without a permission check and an audit entry; a bucket
cannot be read directly; the security regression tests prove both.
**Demo:** try to download someone else's offer letter and fail, visibly, in the log.

---

## Phase 6 — Recruitment / Hiring (with onboarding & offboarding) · 2–3 weeks

**Database:** `job_openings` · `applications` · `interviews` · `interview_scorecards` · `offers` ·
`onboarding_templates` · `onboarding_template_tasks` · `onboarding_instances` · `onboarding_tasks` ·
`offboarding_instances` · `offboarding_tasks`.

**Features:** openings and the candidate pipeline · CV upload into `hr-documents` · interview
scheduling · scorecards with the write-once, no-peeking rule · the `HIRED` transaction that creates
person + engagement + onboarding instance · onboarding templates per department and engagement type ·
**offboarding checklists auto-generated from completed access tasks** · access-revocation attestation
· intern completion and conversion flows.

**Scope note.** The founder's phase list names this phase "Recruitment / Hiring". Onboarding and
offboarding stay here rather than becoming a separate phase: they are the machinery hiring feeds
into, they share the template/instance model, and splitting them would mean building the hiring
pipeline with nowhere for a hired person to go.

**Prerequisite:** the employment-lawyer conversation (Blueprint §26) — its output is the template
set this phase configures.

**Exit:** one real hire goes end to end through the system, and one real exit does too.
**Demo:** onboard someone for real.

---

## Phase 7 — Dashboards, Notifications & Search · 2 weeks

**Features:** role-aware dashboards (admin, HR, sales, developer, employee) built from widgets that
respect permissions · in-app notifications with a bell and a read state · notification triggers
(task assigned, task overdue, document pending, policy acknowledgement due, interview scheduled,
internship ending in 14 days, review approaching) · email digests via Resend · **permission-filtered
global search** across people, leads, clients, projects, tasks and documents · the ⌘K command
palette · the org chart.

**The search rule, restated because it is the easiest thing here to get wrong:** search executes
through the same RLS-protected queries as every list view. It never has its own index of everything.
A user must not be able to confirm a record exists by searching for it.

**Exit:** every user's landing page is useful without navigating; search returns nothing forbidden,
proven by test.
**Demo:** log in as five different roles and show five genuinely different, useful home pages.

---

## Phase 8 — Hardening & Launch · 1–2 weeks

- Full production checklist (spec §63), item by item, with evidence
- Backups verified by an **actual restore into a scratch project**, timed
- `INCIDENT-RESPONSE.md`, `DISASTER-RECOVERY.md`, `ACCESS-CONTROL.md`, the data-export procedure
- Retention policy implemented; the quarterly access-review report
- Rate limits tuned; security headers verified; CSP with no `unsafe-inline`
- Performance pass: RLS query plans, N+1s, table pagination at scale
- Accessibility pass: keyboard navigation, focus states, contrast, screen-reader labels
- **External security review** (recommendation 8) before real HR data is loaded
- Onboard every employee; make PRAVSHI OS the announced source of truth

**Exit:** the whole company is on it, the Sheets are archived, backups have been restored once for
real, and there is a written procedure for the day something goes wrong.

---

## Phase 9+ — Future

Approvals framework → access requests → performance and goals → leave and attendance →
Google Drive API mirror → Workspace and GitHub provisioning automation → reporting and analytics →
e-signature → permission-aware AI → public API → optional SaaS.

Each gets its own spec when there is real evidence it is needed. Not before.

---

## Timeline

| Phase | Weeks | Cumulative |
|---|---|---|
| 0 Foundation | 1 | 1 |
| 1 Identity & Access | 2–3 | 3–4 |
| 2 People | 2 | 5–6 |
| 3 Sales CRM | 2 | 7–8 |
| 4 Projects & Tasks | 2 | 9–10 |
| 5 Documents & Policies | 2 | 11–12 |
| 6 Recruitment & Lifecycle | 2–3 | 13–15 |
| 7 Dashboards & Search | 2 | 15–17 |
| 8 Hardening & Launch | 1–2 | **16–19** |

**Four months to a real internal operating system**, if scope holds. It will not hold by itself —
holding it is your job, and the phase gates are the tool.

---

## What to do if you fall behind

The phase *order* is fixed, but scope inside a phase can shrink. Each of the following is a
founder decision, never a mid-build judgement call. In priority order, cut:

1. **Phase 6 recruitment** — hiring survives on a spreadsheet in a way sales does not. Keep
   onboarding/offboarding, drop the candidate pipeline to Phase 9.
2. **Phase 7 search and the command palette** — nice, not necessary at 20 people.
3. **Phase 5 corporate records index** — Drive folders work; keep HR documents, which do not.

**Never cut:** Phase 1 completeness, the permission test harness, the audit log, backups, or the
external security review before real HR data. Those are not features; they are the reasons this is a
system rather than a liability.
