# Phase 5 — Workflow Engine

User and operator documentation for workflow automations in Pravshi OS
(`Automations → Workflows` in the sidebar). Phase 5 of Pravshi OS.

> Status: the trigger/action engine, builder UI, execution history, and all
> eight Phase 5 trigger types are implemented. `scheduled`, `webhook`, and
> `task.overdue` triggers — and `send_notification`, `send_email`, `webhook`,
> `run_ai_action` actions — are defined as contracts but have **no runtime in
> Phase 5** (see "Deferred to Phase 6" below). Company/contact/activity
> triggers are likewise deferred.

---

## 1. What workflows do

A workflow is an automation rule with three parts — **WHEN** something happens,
**IF** conditions hold, **THEN** do these actions. The engine runs inline in
the request that caused the event: for example, when a deal is moved to a won
stage, an ACTIVE workflow can automatically create the delivery project, spawn
the onboarding tasks, and assign them — immediately, in the same request.

Workflows never act with more power than the person whose action triggered
them: every action runs **as the trigger actor** through the same services and
permissions they would use manually. If the actor couldn't do it by hand, the
step fails and the failure is recorded.

### Key concepts

| Concept | Meaning |
|---|---|
| **Workflow** | One automation definition: trigger + conditions + actions, with a status and a version. Soft-deleted, never hard-deleted. |
| **Trigger (WHEN)** | The event type the workflow listens for (`deal.stage_changed`, …). |
| **Conditions (IF)** | Structured rules evaluated against the event and a snapshot of the source record. All must match (within AND/OR groups). Empty = always runs. |
| **Actions (THEN)** | Ordered steps executed one by one. The first failing step stops the run. |
| **Execution** | One run of a workflow for one event occurrence. Append-only history — executions are never edited or deleted. |
| **Step** | One action attempt inside an execution, with its own status and sanitized result/error. |
| **Manual execution** | "Run now" — executes an ACTIVE workflow on demand as yourself, with a fresh run id. |

### Workflow statuses

| Status | Meaning |
|---|---|
| `DRAFT` | Being built. Never fires automatically. Manual execution is blocked. |
| `ACTIVE` | Live — fires on its trigger, and can be run manually. |
| `PAUSED` | Temporarily off. Kept for history; can be re-activated. |
| `ARCHIVED` | Retired. Cannot be edited or re-activated from the UI. |

Editing an ACTIVE workflow bumps its `version`; executions record which version
ran, so history always shows exactly what logic produced it.

---

## 2. Triggers (WHEN)

Phase 5 implements these eight trigger types:

| Trigger | Fires when | Useful for |
|---|---|---|
| `deal.created` | A deal is created | Welcome sequences, default task checklists on new deals |
| `deal.updated` | A deal is updated | Keep linked projects in sync with deal fields |
| `deal.stage_changed` | A deal moves pipeline stages (via **Move** or the deal editor) | Deal won → create delivery project; stage-gated notifications |
| `task.created` | A task is created | Auto-assign, default priority, spawn subtasks |
| `task.status_changed` | A task's status changes (`todo` → `in_progress` → `done`) | Done → notify or update the deal; stalled-task escalation |
| `task.assigned` | A task's assignee changes | "You were assigned" task creation for the assignee |
| `project.created` | A project is created | Kickoff checklist tasks on every new project |
| `manual` | Only via **Run now** — never fires automatically | One-off bulk operations, testing |

**Trigger filters (optional):** a small exact-match filter on the event
payload, e.g. `{ "isWon": true }` on `deal.stage_changed` so the workflow only
matches deals that were actually won. Filters use plain equality against the
event payload.

**Notes:**
- `deal.stage_changed` fires on **both** the pipeline Move action and a stage
  change made in the deal editor.
- `task.assigned` fires only on *re*-assignment, not when a task is created
  already assigned — assignment-at-creation does not emit a separate event.
- Won/lost evaluation always uses the pipeline stage's authoritative
  `is_won`/`is_lost` **flags**, never stage names.

---

## 3. Conditions (IF)

Conditions are structured rules — no code, no expressions. Each rule picks a
**field**, an **operator**, and a **value**; rules combine in nested AND/OR
groups.

**Available fields:**

| Prefix | Fields |
|---|---|
| `deal.` | `title`, `value` (numeric), `stage`, `probability` (0–100), `is_won`, `is_lost`, `owner_person_id`, `pipeline_id` |
| `task.` | `status`, `priority`, `assignee_person_id`, `project_id`, `due_date`, `title` |
| `project.` | `name`, `is_archived` |
| `event.` | `actor_person_id` (who caused the event), `type` |

**Operators:** `equals`, `not_equals`, `contains`, `not_contains`,
`greater_than`, `greater_than_or_equal`, `less_than`, `less_than_or_equal`,
`exists`, `not_exists`, `in`, `not_in`.

Anything outside this allowlist is rejected **when you save** the workflow —
never silently at runtime.

**Limits (save-time):** condition trees may nest at most 5 deep and contain at
most 50 rules. `exists`/`not_exists` take no value. The value's type must match
the field (e.g. uuid fields need uuids).

---

## 4. Actions (THEN)

Phase 5 implements these six actions, executed in order:

| Action | What it does | Required params |
|---|---|---|
| `create_task` | Creates a task | `title`; `projectId` optional (blank = ungrouped backlog) |
| `create_project` | Creates a project (can then link it to the deal) | `name`; `description` optional |
| `update_deal` | Updates deal fields | `dealId`; `probability`, `expectedCloseDate` optional |
| `update_task` | Updates task fields | `taskId`; `status`, `priority`, `dueDate` optional |
| `assign_task` | Assigns a task to a person | `taskId`, `assigneePersonId` |
| `link_deal_project` | Links a project to a deal | `projectId`, `dealId` |

**Template references:** any param can use `{{path}}` placeholders resolved
against the trigger — e.g. `{{event.entityId}}` (the deal/task/project that
fired the trigger), `{{deal.title}}`, `{{task.title}}`. Placeholders are
plain path lookups, not expressions; an unresolvable reference fails the step
with a clear error.

**Each action can carry a `key`:** a deterministic key reserved for
step-level idempotency (consumed by Phase 6; currently stored but not acted
on — see the Phase 6 handoff).

**Action limits (save-time rejections):**
- `update_deal` **cannot** change a deal's stage and cannot change
  `ownerPersonId` — stage moves must happen through the deal UI/pipeline, and
  ownership changes are not a workflow operation. Attempts fail the step with
  `INVALID_REQUEST` rather than silently doing nothing.
- Unknown or deferred action types (`send_notification`, `send_email`,
  `webhook`, `run_ai_action`) are rejected with a clear error — the UI hides
  them entirely.

---

## 5. Permissions required

Two layers:

1. **Managing workflows** needs the `workflows.*` permissions:

   | Permission | Allows |
   |---|---|
   | `workflows.view` | List and view workflows and execution history |
   | `workflows.create` | Create workflow definitions (as DRAFT) |
   | `workflows.edit` | Edit definitions |
   | `workflows.activate` | Activate / pause workflows |
   | `workflows.execute` | Run now (manual execution) |
   | `workflows.delete` | **Admin only** — soft-delete a definition (no role is granted this; only ADMIN / SUPER_ADMIN hold it) |

   Standard grants: ADMIN gets all six at GLOBAL scope; PROJECT_MANAGER gets
   view/create/edit/activate/execute at DEPARTMENT scope. Deletion stays on
   the admin path.

2. **Actions run as the trigger actor.** A workflow's actions go through the
   same services and the same permission checks as the person whose action
   caused the event. Consequences:
   - A `create_task` step needs the trigger actor to hold the task-creation
     permission; if they don't, that step fails (recorded, visible in
     execution history) and the run stops.
   - Workflows fire for **everyone's** actions — automations are not limited
     to users who can read workflow definitions. A sales rep moving a deal
     triggers the "deal won → create project" workflow even though they hold
     no `workflows.*` permission.
   - Manual **Run now** runs as *you*, with your permissions.

---

## 6. Execution history

Every run is recorded and append-only:

- **Workflow detail page → Executions tab** lists all runs: when, what
  triggered it, status, duration.
- Click a run for **step-by-step detail**: each action attempt, its resolved
  params, result, and any sanitized error. Errors never contain raw database
  messages or secrets — only ids/titles and clean error codes.

**Execution statuses:** `PENDING` → `RUNNING` → `SUCCEEDED` / `FAILED` /
`CANCELLED`. A run that skips because conditions didn't match is recorded as
`SUCCEEDED` with the decision noted.

**Deduplication:** each event occurrence carries a stable dedup key (e.g. the
deal-stage-history row for `deal.stage_changed`). If the same occurrence is
delivered twice, the second is a no-op — one workflow, one occurrence, one
execution. Re-assigning the same person, editing a deal twice, or clicking
Run now twice with fresh runs each behave exactly as their distinct
occurrences.

**Depth bound:** workflows that trigger other workflows (deal won → project
created → tasks spawned) chain up to **5 deep per originating request**; deeper
chains are dropped with a note, protecting the org from runaway loops.

---

## 7. Limits (Phase 5)

| Limit | Value | Why |
|---|---|---|
| Execution model | Synchronous, awaited in-request | No queue/worker yet — Phase 6 |
| Workflow chaining depth | 5 per request | Runaway-loop protection |
| Condition tree depth | 5 | DoS bound |
| Condition rules per workflow | 50 max | DoS bound |
| Conditions | Structured allowlist only | No code, no expressions, ever |
| Actions per workflow | 6 implemented types | Deferred types rejected at save |
| Execution history | Append-only | Compliance record; no delete path |
| `update_deal` scope | No stage changes, no owner changes | Rejected at the step, never silent |
| Builder UI | Desktop-first | Mobile: deep links work, tabs don't include Workflows |

---

## 8. Troubleshooting — why didn't my workflow fire?

Work through this checklist in order:

1. **Is the workflow ACTIVE?** DRAFT, PAUSED, and ARCHIVED workflows never
   fire automatically. Check the status badge on the workflow detail page.
2. **Is the trigger type implemented in Phase 5?** `scheduled`, `webhook`,
   and `task.overdue` triggers can be saved as DRAFT but can never fire —
   the builder shows them as unsupported. Likewise `company.created`,
   `contact.created`, and activity triggers have no emission points yet.
3. **Did the event actually occur on the emitting path?**
   - `deal.stage_changed` fires on pipeline **Move** and on stage edits in the
     deal editor — but not on plain field updates (those emit
     `deal.updated`).
   - `task.assigned` fires on re-assignment; a task *created* with an
     assignee does not emit it.
4. **Did the conditions match?** Check the execution history: a run with
   `SUCCEEDED` and a "skipped — conditions" decision means the trigger fired
   but your IF rules didn't match. Verify field values (`is_won` uses the
   stage's authoritative flag, not the stage name).
5. **Was this occurrence already handled?** Dedup is per-occurrence: the
   second delivery of the *same* event is intentionally a no-op. (Re-doing
   the underlying action — e.g. moving the deal again — creates a new
   occurrence.)
6. **Did an action step fail?** Open the execution → step detail. Steps fail
   visibly with a code (`INVALID_REQUEST`, `FORBIDDEN`, `NOT_FOUND`,
   `INTERNAL`). The most common cause: the **trigger actor** lacked the
   underlying permission for that action (see §5) — a workflow can't do what
   its triggerer couldn't do manually.
7. **Was the run dropped by the depth bound?** If your workflows chain
   (A triggers B triggers C …), chains stop at depth 5 — check for
   self-referential loops (`task.created` → `create_task` with no limiting
   condition).
8. **Is the row corrupt?** Hand-edited definition rows that fail validation
   are skipped fail-closed with a logged warning instead of breaking the
   page or the request. Re-save the workflow in the builder.

If none of the above applies, the Sentry breadcrumb trail on the dropped
execution (or the audit entries `workflow.created/updated/activated/paused/
executed`) will show exactly what the engine decided and why.
