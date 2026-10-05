# ADR-005: Workflow engine architecture decisions (Phase 5)

Status: Accepted | Date: 2026-10-04 | Deciders: Nani

## Context

This record captures the binding architecture decisions for the Phase 5
Workflow Engine, in two layers:

1. **D1–D10** — the foundational decisions from the Phase 5 architecture audit
   (`~/workspace/goals/pravshi-os-build/hidden_files/phase5-architecture-audit.md`,
   §7), which all implementation and review work proceeded against.
2. **F-fixes (post-review decisions)** — decisions taken during the Wave 5/6
   review cycle in response to the independent security review
   (`~/workspace/phase5-audit/a16-security-review.md`) and independent code
   review (`~/workspace/phase5-audit/a17-code-review.md`), and verified in the
   implementation tree (`~/workspace/phase5/tree`).

The central constraint shaping every decision: there is **no service /
background identity**. Every database write must flow through
`withAuthorizedDb` with a real `AuthContext`, and the codebase's "no synthetic
actor" rule forbids fabricating one. All of D2, D7, and the F-fixes are answers
to that constraint.

---

## D1. Synchronous in-request execution (Phase 5); durable async is Phase 6

**Context:** Phase 5 had to choose between building a job queue + worker pool
now or executing automations inline. The repo has no queue, worker, cron, or
timer infrastructure at all (audit §4), so durable async would have been a
large new subsystem with its own security surface.

**Decision:** No queue, no worker, no scheduler in Phase 5. Services emit
domain events post-commit; the engine matches → evaluates → executes **inline,
awaited in the originating request**, each workflow run in its own
`withAuthorizedDb` transaction. Phase 6 adds the outbox + workers behind the
same `WorkflowEvent` contract (see Phase 6 handoff).

**Consequences:**
- An early implementation detached the engine with fire-and-forget (`void`),
  which both defeated the recursion bound (see (a) below) and left the flagship
  "deal won → create project → spawn tasks" flow unreliable on the serverless
  target (P0-1, P0-2 in the code review). The adopted fix was to **await** the
  pipeline inside the request while keeping `dispatchWorkflowEvent`'s
  never-throw contract (internal try/catch → Sentry).
- If a workflow's actions are slow, the triggering request is slow — this is a
  known, accepted Phase 5 trade-off, and the precise reason Phase 6 replaces
  the in-request pipeline with durable async.

## D2. Execution authority = the trigger actor (no privilege escalation)

**Context:** With no background identity available, the engine had to run as
*someone*. Alternatives were a synthetic "system actor" (forbidden by the
no-synthetic-actor rule) or the triggering user's real identity.

**Decision:** Workflow actions execute with the **triggering user's real
`Authorization`** (for MANUAL triggers, the executing user). Actions call the
existing domain services, so a workflow can only do what that user is permitted
to do; RLS re-enforces everything. A workflow can never grant power its
trigger actor lacks. Action denial → step FAILED, execution FAILED, fully
recorded.

**Consequences:**
- The security review (A16 §3) verified all six action executors call existing
  services with the actor's real `Authorization`; no service is bypassed, none
  reimplemented, no privilege synthesized. **PASS.**
- No Phase 6/9 "workflow-owner / system-actor" model is invented here; that
  stays an explicit, consent-based future decision (documented in the Phase 6
  handoff).

## D3. Emission points are the service functions, post-commit

**Context:** Domain services (`createDeal`, `moveTask`, `assignTask`, …) are
already the mutation choke points; `withAuthorizedDb` commits before returning.

**Decision:** A `dispatchWorkflowEvent(auth.ctx, event)` call placed **after**
the `await withAuthorizedDb(…)` in a service runs post-commit, only on real
mutations (noops don't emit). The dispatcher is wrapped so engine failures can
never break the originating mutation (catch → Sentry → FAILED execution
record).

**Consequences:** Events are durable facts (the row committed) before any
automation runs on them. Payloads carry before/after snapshots so the engine
never re-reads ambiguously.

## D4. Recursion bound — depth 5 per request, tracked per event via AsyncLocalStorage

**Context:** Chained workflows are a feature (deal won → project created →
tasks spawned), but unbounded chains are a runaway-automation /
resource-exhaustion risk. The audit specified a depth-5 bound per request.

**Decision:** See post-review decision **(a)** below for the binding mechanism.

**Consequences:** The self-perpetuating loop (`task.created` → `create_task`)
is impossible beyond depth 5; the drop is recorded with a Sentry breadcrumb.

## D5. Structured conditions only

**Context:** A general expression language or `eval` would give workflow
authors arbitrary code execution inside the request path.

**Decision:** JSON condition trees against a strict field/operator allowlist
(§11 of the audit; 12 operators, closed `deal.`/`task.`/`project.`/`event.`
field prefixes). No `eval`, no expression language, no user code. Unknown
field/operator → validation error **at workflow save time**, never at
execution. DoS bounds: max condition depth 5, max 50 leaf nodes.

**Consequences:** Verified by both reviews — zero `eval`/`new Function` hits in
the workflow surface; the evaluator is pure data-walking, fail-closed, with
prototype-pollution segments (`__proto__`/`constructor`/`prototype`) rejected.

## D6. Actions reuse services; future actions are contracts, not stubs-that-lie

**Context:** Phase 6+ needs `send_notification`, `send_email`, `webhook`,
`run_ai_action`. Shipping fake implementations would silently mislead users;
omitting them entirely would leave no design record.

**Decision:** Phase 5 implements exactly six actions — `create_task`,
`create_project`, `update_deal`, `update_task`, `assign_task`,
`link_deal_project` — each executing through the existing domain service.
Phase 6+ actions exist in the registry as `implemented: false` with their
input contracts documented; the UI hides them and the engine rejects them with
a clear error if forced.

**Consequences:** Executors inherit the services' org scoping, validation,
history writes, and audit entries. No service is bypassed, none is
reimplemented.

## D7. Execution records are written via SECURITY DEFINER functions

**Context:** `workflow_executions` / `workflow_execution_steps` must be
writable by the engine running as *any* trigger actor, but the tables are
SELECT-only for `app_user` (execution history is a compliance record).

**Decision:** Four functions — `workflow_record_execution`,
`workflow_finish_execution`, `workflow_record_step`, `workflow_finish_step` —
all `SECURITY DEFINER ... SET search_path = ''`, deriving actor/org from the
transaction context (like `write_audit_log`), verifying the workflow's org
matches, rejecting blank/overlong inputs, never accepting a caller-supplied
actor. RLS on executions/steps grants `app_user` SELECT only (gated on
`workflows.view`).

**Consequences:** No synthetic actor is ever fabricated; actor/org are
transaction-derived facts. See (c) below for the post-review hardening of these
functions.

## D8. Webhook/scheduled triggers are Phase 5 contracts, Phase 6+ runtime

**Context:** A workflow engine without `scheduled`/`webhook`/`task.overdue`
triggers looks incomplete, but their runtimes (signature verification, replay
protection, rate limits, a timer loop) are substantial new security surface.

**Decision:** Their trigger-type entries, config schemas, and security
requirements are specified now (audit §§9–10, D8); no runtime is wired. A
workflow with a deferred trigger type can be saved as DRAFT but can never be
ACTIVATEd (`INVALID_REQUEST: trigger type not yet supported`).

**Consequences:** The engine's trigger registry distinguishes implemented from
deferred types at the schema level; users cannot activate something that cannot
fire. The deferred contracts are the Phase 6 handoff.

## D9. JSONB for trigger/condition/action config with generated-column indexing

**Context:** Workflow config is semi-structured, but trigger matching is a hot
query.

**Decision:** Relational columns for query-critical fields (`status`,
`org_id`); a STORED generated column `trigger_type` + composite index
`(org_id, status, trigger_type)` for matching. Conditions/actions stay JSONB —
validated by zod at the boundary.

**Consequences:** The match query is index-narrowed to the org's ACTIVE
workflows for one trigger type; no full-table scan per mutation.

## D10. Frontend under `src/app/(app)/workflows/`, desktop-first

**Context:** Nani's standing UI principle: Pravshi OS is an operating system
people use on a laptop for work; mobile only needs to be functional.

**Decision:** Follows the established page/`_actions`/`_components`/`_types`/
`_permissions` pattern. Sidebar gains an **Automations** section →
`Workflows` (`/workflows`, gated on `workflows.view`). Mobile keeps its four
tabs; workflows is desktop-primary but deep-linkable.

---

## Post-review decisions (F-fixes)

### (a) Awaited in-request dispatch with AsyncLocalStorage depth tracking — the D4 mechanism

**Context:** The independent code review (A17 P0-1) and security review (A16
§7, HIGH) found the D4 depth bound **defeated in production**: the engine was
fire-and-forget (`void runWorkflowsForEventAsync(…)`), so the synchronous
`currentDepth` counter in `dispatchWorkflowEvent` decremented immediately
after kickoff — before any action executed. Every chained dispatch observed
depth ≈ 0. A `task.created` → `create_task` workflow would loop unboundedly
(each iteration writes a fresh task + execution + step rows; the dedup
constraint can't stop it because each iteration is a new occurrence). The
`__eventSystemSelfTest` only exercised a synchronous test double, so it
"proved" a bound that didn't hold on the real path. Separately, the
detachment violated D1 (P0-2): the HTTP response could return before workflow
actions ran, unreliable on the Vercel serverless target.

**Decision:** Two changes, both verified in the tree:
1. The engine pipeline is now **awaited inside the originating request**
   (`engine.ts:513 `await runWorkflowsForEventAsync(auth, event)``), matching
   D1/§13; `dispatchWorkflowEvent` keeps its never-throw contract via internal
   try/catch.
2. Depth is tracked on the **event across the async boundary** using
   `node:async_hooks` `AsyncLocalStorage` (`events.ts:34,95`), not a
   sync-stack counter. Chained dispatches inherit and increment the depth;
   events at depth ≥ 5 are dropped with a Sentry breadcrumb (§13 step 1).
   Manual execution (`executeWorkflowManual`) awaits `processWorkflow` and was
   already synchronous.

**Consequences:** D4 is now reachable in production; a chaining test must
re-verify it (see A17's recommended fix order). The module-global counter's
cross-request sharing problem disappears with ALS. The deadlock trade-off:
awaited execution lengthens the triggering request — accepted, and precisely
what Phase 6's durable async removes.

### (b) `workflow_find_matching` SECURITY DEFINER — automations fire for actors without `workflows.view`, actions stay under trigger-actor authority

**Context:** A16 §3 (observation): the trigger matcher ran under the trigger
actor's RLS, and the `workflows_select` policy requires `workflows.view`. Users
without that key (SALES, EMPLOYEE, INTERN, DEVELOPER — none hold any
`workflows.*` permission) therefore **never triggered automations on their
own actions**; the matcher silently returned zero rows. This was fail-closed,
but it made automation coverage permission-dependent — the flagship "deal WON
→ create project" scenario wouldn't fire when a sales rep moved the deal.

**Decision:** The matcher moved into the database as
`public.workflow_find_matching(p_trigger_type, p_org_id)` (`0044:742`) —
`SECURITY DEFINER`, `SET search_path = ''`, `REVOKE ALL FROM PUBLIC`, `GRANT
EXECUTE TO app_user`. It returns the caller's org's ACTIVE, non-deleted
workflows for one trigger type (index-narrowed, `(org_id, status,
trigger_type)`), **bypassing the `workflows.view` RLS requirement by design**.
Tenant scoping is enforced inside (org from `authz.org_id()`, asserted against
`p_org_id` — the F9 pattern in (c)). D2 is unchanged: **actions still execute
under the trigger actor's own Authorization**; definitions carry no secrets
(audit §17).

**Consequences:** Automations now fire on every trigger actor's mutations
regardless of their workflow permissions; action authority remains exactly the
actor's — a sales rep's workflow can't do anything the sales rep couldn't do
manually. Corrupt definition rows are fail-closed at parse time
(`parseWorkflowRow` skips with a Sentry warning), never breaking the request.

### (c) Definer functions assert the explicit `p_org_id` against the transaction context (F9)

**Context:** The five workflow SECURITY DEFINER functions each take an
explicit `p_org_id` parameter (for composability). Without an assertion,
a mismatched `p_org_id` would be a tenant-scoping landmine.

**Decision:** Every definer — `workflow_record_execution`,
`workflow_finish_execution`, `workflow_record_step`, `workflow_finish_step`,
and `workflow_find_matching` — derives the org from `authz.org_id()` (the
transaction context) and **raises 42501 unless `p_org_id` is not distinct
from it** (0044:396, 497, 586, 669, 766; the same anti-tamper pattern as
`authz.org_id()` itself).

**Consequences:** A caller cannot scope a record/finish/match call to an org
other than their own; cross-tenant reference attempts fail closed with 42501.

### (d) Circular-import fix — trigger/action constants live in `schema.ts`

**Context:** `WORKFLOW_TRIGGER_TYPES` / `WORKFLOW_ACTION_TYPES` were consumed
by both the zod layer and the runtime engine, creating a circular import
between `events.ts` and `schema.ts` (runtime modules pulling in the schema
module pulling in runtime helpers).

**Decision:** All shared constants (`WORKFLOW_TRIGGER_TYPES`,
`WORKFLOW_ACTION_TYPES`, `IMPLEMENTED_TRIGGER_TYPES`,
`DEFERRED_ACTION_TYPES`, max-depth/leaf bounds) live in
`src/lib/workflows/schema.ts`, the leaf module with no runtime dependencies.
`events.ts`, `actions.ts`, `triggers.ts`, `engine.ts` import them from there.

**Consequences:** Pure-logic modules stay import-light; no import cycle, no
accidental dragging of the db pool / env validation into unit-testable modules.

### (e) `workflows.delete` is admin-only (no role grants; follows the `projects.delete` precedent)

**Context:** The permission catalogue needs a delete key for the soft-delete
dispatch path, but deleting an automation definition is an access-affecting
operation (a workflow can move deals, assign tasks, create projects) — audit
severity HIGH.

**Decision:** `workflows.delete` is seeded and dispatched through
`crm_soft_delete()` (`0044:819–863`), but **granted to no role** in
`seed_system_roles` (0044:1002–1069) — only the ADMIN-at-GLOBAL /
SUPER_ADMIN backfill entries carry it (0044:1235–1299). Deletion goes through
the DELETE route (`workflows.delete` + workflow target probe); there is no
DELETE RLS policy, so deletion is possible only via the definer path.

**Consequences:** PROJECT_MANAGER and below can create/edit/activate/pause but
never delete a workflow; only admins can remove definitions. Execution history
is append-only regardless (no delete path exists for executions/steps).

### (f) Company/contact/activity triggers deferred — no emission points wired in Phase 5

**Context:** The §9 event contract lists `company.created`, `contact.created`,
and activity events as entity types, and A12 was assigned to wire them. The
independent review found zero `dispatchWorkflowEvent` calls in
`companies.ts`, `contacts.ts`, `activities.ts` (the `company.created` /
`contact.created` strings present there are app-layer audit actions, not event
emissions).

**Decision:** Company/contact/activity triggers are **deferred**. The trigger
types stay defined in the contract, but no runtime emits them in Phase 5 —
wiring partial, untested emission points late in the cycle was judged riskier
than a clean deferral. Implemented trigger types in Phase 5 are exactly:
`deal.created`, `deal.updated`, `deal.stage_changed`, `task.created`,
`task.status_changed`, `task.assigned`, `project.created`, `manual`.

**Consequences:** A workflow cannot trigger on company/contact/activity
events in Phase 5. The Phase 6 handoff owns the emission-point contracts (see
`docs/phase6-workflows-handoff.md`).

---

## Known open recommendation (not decided here)

A16 §2 (MEDIUM): the four record/finish definer functions check only
`authz.is_active()` — not any `workflows.*` permission — so any active org
member could call them directly to inject bogus execution rows, tamper with
execution history, or pre-claim `(workflow_id, dedup_key)` pairs (dedup
poisoning, suppressing a legitimate automation). The review recommended an
`authz.has('workflows.execute')` (or at minimum `'workflows.view'`) probe
inside each function, following the `crm_soft_delete()` M1 probe precedent.
**This probe is not present in the tree at this writing** (definers enforce
`is_active()` only). Decided: the integration/release path must either apply
the probe or record an explicit risk-acceptance before merge.

## Consistency

- **No second authorization model.** The definer matcher (b) answers one
  question ("which ACTIVE workflows match this trigger type for my org?") and
  makes no authority decision; authority stays with the trigger actor's real
  `Authorization` (D2) and the existing `requirePermission`/`withPermission`
  boundary on every route, page, and server action.
- **Least privilege.** The definers grant `app_user` exactly the narrow
  operations named; RLS on executions/steps remains SELECT-only; there is still
  no DELETE path for execution history anywhere.
- **Tenant isolation: unchanged and strengthened.** The F9 `p_org_id`
  assertions and the in-function org derivation close the parameterized-org
  vector; cross-org references fail closed with 42501 at the org-guard
  triggers and inside every definer.
