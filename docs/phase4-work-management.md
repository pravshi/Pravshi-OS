# Phase 4 — Work Management

Developer documentation for the Work Management module (`/api/work/*`). Phase 4 of Pravshi OS.

> Status: DB (migration 0042) and core API routes are implemented. Subtask routes, reminder routes, UI pages, and CRM-integration UI are still in progress — anything not yet built is marked **TBD pending implementation**. This document tracks contracts, not aspirations: it only describes what the contract specifies or what the implementation contains.

---

## 1. Overview

Work Management gives every org a lightweight project/task system that lives alongside the CRM. It is built for delivery: sales closes a deal, delivery runs it as a project, and tasks track the actual work.

### Key concepts

| Concept | Meaning |
|---|---|
| **Project** | A container for tasks. Optional `deal_id` links it to the CRM deal it delivers. Archived (not deleted) when finished — `is_archived`. |
| **Task** | A unit of work. Has `status` (`todo` → `in_progress` → `done`), `priority` (`low`/`medium`/`high`/`urgent`), optional `due_date`, optional single assignee (`assignee_person_id`). A task may belong to a project, or be ungrouped (`project_id` NULL = backlog). |
| **Subtask** | A task with `parent_task_id`. Subtasks inherit the parent's org and project; deleting a parent hard-deletes the whole subtree. **TBD pending implementation** (DB support exists; API routes `/api/work/tasks/[id]/subtasks` not yet built). |
| **Member** | A `people` row joined to a project via `project_members`, with `role_in_project` of `manager` or `member`. Project-level managers can manage that project's roster without holding the global `projects.manage_members` permission. |
| **Reminder** | A scheduled nudge for a task (`task_reminders` per the contract). **TBD pending implementation** — table and API routes not yet built; no reminder processing exists. |

### Design rules (from the contract)

- **Soft-delete by default.** Projects and tasks soft-delete via `deleted_at` (the `crm_soft_delete()` path). Hard-delete of a task is the one exception: allowed only for the task's creator or ADMIN via `tasks.delete`.
- **Archiving ≠ deleting.** Finishing a project sets `is_archived = true`; archived projects are hidden from default list queries.
- **Org is the tenant boundary.** Every row carries `org_id`; cross-org references are rejected by BEFORE triggers with `42501`.
- **No synthetic actors.** `created_by`/`added_by` are nullable, deliberately *not* FKs to `people` — deleting a person must never block reads of work they created.

---

## 2. Data model

Migration: `drizzle/0042_work_management.sql`.

```
organizations
  └── work_projects ──(deal_id)──▶ deals            [ON DELETE SET NULL]
        ├── project_members ──(person_id)──▶ people
        └── work_tasks ──(project_id)──▶ work_projects   [ON DELETE SET NULL on hard delete]
              ├── work_tasks.assignee_person_id ──▶ people
              └── work_tasks.parent_task_id ──▶ work_tasks  [ON DELETE CASCADE, subtree delete]
```

### `work_projects`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | default `gen_random_uuid()` |
| `org_id` | uuid FK → organizations | tenant key; UNIQUE `(org_id, id)` |
| `name` | text NOT NULL | blank rejected; unique per org among live rows |
| `description` | text | nullable |
| `deal_id` | uuid FK → deals, nullable | ON DELETE SET NULL; org-pinned by trigger |
| `is_archived` | boolean NOT NULL | default false |
| `created_by` | uuid, nullable | attribution only, no FK |
| `created_at` / `updated_at` / `deleted_at` | timestamptz | soft-delete |

Indexes: `(org_id)` live-only, `(org_id, name)` unique live-only, `(org_id, deal_id)` live-only.

### `project_members`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK → organizations | UNIQUE `(org_id, id)` |
| `project_id` | uuid FK → work_projects NOT NULL | ON DELETE CASCADE |
| `person_id` | uuid FK → people NOT NULL | |
| `role_in_project` | text NOT NULL | `'manager'` \| `'member'`, default `'member'` |
| `added_by` | uuid, nullable | attribution only, no FK |
| `added_at` | timestamptz NOT NULL | default now() |

Constraints: UNIQUE `(project_id, person_id)` — one membership row per person per project. Hard-deleted via the manager-gated DELETE policy (no soft-delete).

### `work_tasks`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK → organizations | UNIQUE `(org_id, id)` |
| `project_id` | uuid FK → work_projects, nullable | NULL = ungrouped backlog; ON DELETE SET NULL |
| `title` | text NOT NULL | blank rejected |
| `description` | text | nullable |
| `status` | text NOT NULL | `'todo'` \| `'in_progress'` \| `'done'`, default `'todo'` |
| `priority` | text NOT NULL | `'low'` \| `'medium'` \| `'high'` \| `'urgent'`, default `'medium'` |
| `due_date` | date, nullable | |
| `assignee_person_id` | uuid FK → people, nullable | single assignee |
| `parent_task_id` | uuid self-FK, nullable | ON DELETE CASCADE; `parent_task_id != id` |
| `created_by` | uuid, nullable | attribution; doubles as the creator arm of the DELETE policy |
| `created_at` / `updated_at` / `deleted_at` | timestamptz | soft-delete |

Indexes: `(org_id)`, `(project_id)`, `(assignee_person_id)`, `(parent_task_id)`, `(org_id, due_date)` — all live-only.

### `task_reminders`

Contract: `(id, org_id, task_id, person_id, remind_at, is_sent, created_at)`. **TBD pending implementation** — not in migration 0042 yet.

### RLS summary (FORCE RLS, all tables)

- Org-scoped, `deleted_at IS NULL` excluded (where the column exists), `is_active()`-gated.
- No owner columns on these tables, so policies gate on `authz.has('<key>')` (permission at any scope), not an owner-based scope CASE.
- `project_members` adds a **self-membership arm**: members can read membership rows of projects they belong to even without `projects.view`; a project-level `manager` can INSERT/UPDATE/DELETE that project's members without the global `projects.manage_members` key.
- `work_tasks` carries the one DELETE policy in the module: creator hard-delete (`created_by = authz.person_id()`) or `tasks.delete` key. `work_projects` has **no** DELETE policy — projects delete only via `crm_soft_delete()` with `projects.delete`; hard-delete is revoked for runtime roles.
- Cross-org FK protection: six BEFORE triggers (`work_tasks_project_org_guard`, `work_tasks_assignee_org_guard`, `work_tasks_parent_org_guard`, `project_members_project_org_guard`, `project_members_person_org_guard`, `work_projects_deal_org_guard`) reject foreign-org references with `42501` before any FK check. Subtasks must also carry the parent's `project_id` when the parent is grouped.
- Audit: `audit_row_change()` at HIGH, whole-row, on all three tables.

---

## 3. API reference

Base path: `/api/work/*`. All routes require an authenticated session and go through `withPermission({ permission })` — missing/invalid session → auth envelope error, lacking the permission → `FORBIDDEN`. All responses carry `Cache-Control: no-store`.

### Conventions

- IDs are UUIDs (zod-validated; invalid → `400 INVALID_REQUEST`).
- List endpoints return `{ rows, total, limit, offset }`.
- Invisible or deleted resources are concealed as **404** (never 403) — you cannot distinguish "doesn't exist" from "no access".
- Validation failure → `400 { error: "INVALID_REQUEST", message: "<field>: <reason>" }`.
- Domain rule violations (e.g. duplicate membership, cross-org reference hitting the 42501 trigger backstop, archive guards) → `400 { error: "INVALID_REQUEST", message: "<reason>" }`.
- Everything else unexpected → `500 { error: { code: "INTERNAL", message: "Something went wrong.", requestId? } }`.

### Endpoints

| Method | Path | Permission | Request | Response |
|---|---|---|---|---|
| GET | `/api/work/projects` | `projects.view` | `?search=&limit=&offset=&includeArchived=&sort=&order=` — search matches name prefix; sort ∈ `name\|createdAt\|updatedAt` | `200 { rows, total, limit, offset }`; row = `{ id, name, description, isArchived, createdBy, createdAt, updatedAt }` |
| POST | `/api/work/projects` | `projects.create` | `{ name, description? }` | `201` + the project |
| GET | `/api/work/projects/[id]` | `projects.view` | — | `200` + project, or 404 |
| PATCH | `/api/work/projects/[id]` | `projects.edit` | `{ name?, description?, isArchived? }` | `200` + updated project |
| DELETE | `/api/work/projects/[id]` | `projects.delete` | — | `200` + archived project. **Archive, not delete**: sets `is_archived`; there is no project hard-delete path |
| GET | `/api/work/projects/[id]/tasks` | `tasks.view` | `?search=&limit=&offset=&status=&priority=&assigneePersonId=&sort=&order=`; `projectId` forced from path | `200 { rows, total, limit, offset }`; invisible project → 404 |
| GET | `/api/work/projects/[id]/members` | `projects.view` | — | `200` member list; invisible project → 404 |
| POST | `/api/work/projects/[id]/members` | `projects.manage_members` (or project-level `manager`) | `{ personId, roleInProject? }` | `201` + the member list |
| DELETE | `/api/work/projects/[id]/members/[personId]` | `projects.manage_members` (or project-level `manager`) | — | `200 { ok: true }`; 404 when project invisible or person not a member |
| GET | `/api/work/tasks` | `tasks.view` | `?search=&limit=&offset=&projectId=&status=&priority=&assigneePersonId=&sort=&order=` — search matches title prefix; sort ∈ `title\|status\|priority\|dueDate\|createdAt\|updatedAt` | `200 { rows, total, limit, offset }` |
| POST | `/api/work/tasks` | `tasks.create` | `{ title, projectId?, description?, status?, priority?, dueDate?, assigneePersonId? }` | `201` + the task |
| GET | `/api/work/tasks/[id]` | `tasks.view` | — | `200` + task, or 404 |
| PATCH | `/api/work/tasks/[id]` | `tasks.edit` | `{ title?, description?, status?, priority?, dueDate?, assigneePersonId?, projectId? }` — `assigneePersonId` accepts a person UUID or `null` to unassign; `projectId` moves the task (same-org validated; cross-org → 400) | `200` + updated task |
| DELETE | `/api/work/tasks/[id]` | `tasks.delete` | — | `200 { ok: true }` (soft delete: `deleted_at = now()`) |
| POST | `/api/work/tasks/[id]/move` | `tasks.edit` | `{ status }` — kanban move; changes **only** status. Same-status move is a 200 no-op. Cross-project moves are forbidden here — use PATCH with `projectId` | `200 { ok, taskId, fromStatus, toStatus }` |
| GET | `/api/work/tasks/mine` | `tasks.view` | `?search=&limit=&offset=&projectId=&status=&priority=&sort=&order=` — assignee forced to the caller's person id | `200 { rows, total, limit, offset }` |
| *any* | `/api/work/tasks/[id]/subtasks` | — | — | **TBD pending implementation** |
| *any* | `/api/work/tasks/[id]/reminders` | — | — | **TBD pending implementation** |

Task row shape: `{ id, projectId, projectName, title, description, status, priority, dueDate, assigneePersonId, assigneeName, createdBy, createdAt, updatedAt }`. Member row shape: `{ personId, name, roleInProject }` (ordered by `added_at`).

Error codes you will see:

| Status | Body | Meaning |
|---|---|---|
| 400 | `{ error: "INVALID_REQUEST", message }` | zod validation or service domain-rule failure |
| 401 | `{ error: { code: "UNAUTHENTICATED", … } }` | no/invalid session |
| 403 | `{ error: { code: "FORBIDDEN", … } }` | session valid but permission key (at any scope) not held |
| 404 | `{ error: { code: "NOT_FOUND", … } }` | row missing, deleted, archived-out-of-scope, or invisible to caller |
| 500 | `{ error: { code: "INTERNAL", message: "Something went wrong.", requestId? } }` | unexpected failure; no detail on the wire |

---

## 4. Permissions

Work Management reuses the legacy `projects.*` / `tasks.*` catalogue keys (seeded in 0008; Phase 4 matrix in migration 0042). **No new permission keys** were introduced. Note: scopes below are the *maximum granted scope*; RLS further restricts reads to the caller's org and, for members, to projects they belong to.

| Role | projects.* | tasks.* |
|---|---|---|
| SUPER_ADMIN | all, GLOBAL | all, GLOBAL |
| ADMIN | `view/create/edit/manage_members/delete`, GLOBAL | `view/create/edit/assign/delete`, GLOBAL |
| MANAGER | `view/create/edit`, DEPARTMENT | `view/create/edit`, DEPARTMENT |
| SALES_MANAGER | `view/create/edit/manage_members`, DEPARTMENT | `view/create/edit/assign`, DEPARTMENT |
| PROJECT_MANAGER | `view/create/edit/manage_members`, DEPARTMENT | `view/create/edit/assign`, DEPARTMENT |
| DEVELOPER | `view/edit`, PROJECT | `view/create/edit/assign`, PROJECT |
| VIBECODER | `view`, PROJECT | `view/create/edit`, PROJECT |
| SALES | `view`, SELF | `view/create/edit`, SELF |
| INTERN | `view`, PROJECT | `view/create/edit`, SELF |
| EMPLOYEE | — | `view/create/edit`, SELF |
| FINANCE | `view`, GLOBAL | — |
| HR_ADMIN / HR_MANAGER / MARKETING | — | — |

Key rules:

- `tasks.create` rides with `tasks.view` at each role's existing scope — no role gains task visibility it didn't already hold. Roles that never held `tasks.view` (HR_*, FINANCE, MARKETING) gain nothing.
- `tasks.delete` is **not** seeded to non-admin roles. Non-admins delete only tasks they created, through the `work_tasks` DELETE RLS policy (`created_by = authz.person_id()`), not a grant.
- `projects.delete` is ADMIN/GLOBAL (and SUPER_ADMIN). Project DELETE goes through `crm_soft_delete('work_project', …)` which archives-fails-closed on the key; the M1 probe inside `crm_soft_delete()` raises `42501` without it.
- `tasks.comment` exists in the catalogue but stays **ungranted to everyone** (fail closed) until the comments feature lands.
- Project-level managers (`role_in_project = 'manager'`) can manage that project's members without holding the global `projects.manage_members` key; members can read their project's roster without `projects.view`.

---

## 5. UI guide

> **TBD pending implementation** — no `/work` pages exist in the app yet. The notes below describe the intended surface from the contract so the UI agent builds against it; do not treat them as shipped.

Planned pages (routes TBD):

- **Projects list** — table/cards of projects with search, archived toggle, create-project action.
- **Project detail** — task kanban + members tab + settings (rename, archive).
- **My tasks** — tasks assigned to the current user.

### Kanban usage

Three columns driven by task `status`: **To do** (`todo`), **In progress** (`in_progress`), **Done** (`done`). Dragging a card between columns calls `POST /api/work/tasks/[id]/move` with `{ status }`. That endpoint changes *only* status — moving a card to another project's board must go through `PATCH /api/work/tasks/[id]` with `projectId` (same-org enforced; cross-org → 400).

### Keyboard shortcuts

**TBD pending implementation** — no shortcuts are defined yet. (Suggested candidates for the UI agent: `n` new task, `/` focus search, `1/2/3` filter by status column, `?` shortcut help. Not specified by the contract.)

---

## 6. CRM integration

The CRM seam is `work_projects.deal_id` → `deals.id`:

- A project optionally links to **the deal it delivers** — the *Deal → Project → Tasks* flow that future automation builds on.
- `deal_id` is org-pinned: `work_projects_deal_org_guard()` rejects a deal from another org with `42501`.
- A deal **hard-delete nulls** `deal_id` (`ON DELETE SET NULL`) — project history survives the deal.
- Query direction is project-first: find projects by deal via the `(org_id, deal_id)` index. No deal→project FK exists on the CRM side.

CRM-integration UI (e.g. "create project from deal" on the deal page) is **TBD pending implementation**.

---

## 7. Testing

Commands (from `package.json`, run in the repo root):

| Command | What it runs |
|---|---|
| `pnpm test` (`vitest run`) | Unit/integration tests in `tests/` |
| `pnpm test:watch` | Vitest watch mode for development |
| `pnpm e2e` (`playwright test`) | Playwright end-to-end tests in `e2e/` |
| `pnpm typecheck` (`tsc --noEmit`) | TypeScript type check |
| `pnpm lint` | ESLint |

Phase 4 specifics:

- DB: migration 0042 includes in-migration verification blocks that fail the migration if permission grants are missing — apply with the standard drizzle flow and watch for those assertions.
- RLS/tenant isolation: test cross-org writes expect `42501` (task → project, task → assignee, subtask → parent, member → project/person, project → deal) and read probes across orgs expect 404.
- Soft-delete paths: `crm_soft_delete('work_project' | 'work_task' | 'task', id)` — requires the corresponding delete permission; without it the M1 probe raises `42501`.
- API: exercise the routes in §3 with a session holding each role in §4 to verify the matrix (especially creator-delete of tasks without `tasks.delete`, and project-level manager membership management without `projects.manage_members`).
- Phase 4 test files themselves are **TBD pending implementation** — the QA agent is still writing them. When they land, run the Phase 4 subset with `pnpm test tests/work` (adjust path to where the QA agent places them) and `pnpm e2e` for the work-management specs.
