# Phase 6 Handoff — Workflow Engine Deferred Contracts

Phase 5 defined these contracts but built **no runtime** for them. Phase 6
(Automation + Background Jobs) owns them. This document is the checklist: each
item states what Phase 5 left behind, where it lives in the tree, and what
Phase 6 must build.

Related: ADR-005 (D1, D6, D8, and post-review decision (f)) in
`docs/architecture/adr/005-workflow-engine-decisions.md`; architecture audit
§20.

---

## 1. Deferred trigger types

Defined in the trigger registry (`src/lib/workflows/schema.ts` —
`WORKFLOW_TRIGGER_TYPES`), but absent from `IMPLEMENTED_TRIGGER_TYPES`, so
they can be saved on DRAFT workflows and **can never be activated** (attempts
get `INVALID_REQUEST: trigger type not yet supported`).

| Trigger | Phase 5 left | Phase 6 must build |
|---|---|---|
| `scheduled` | Trigger-type entry + config schema (`cron`-style schedule + timezone in `TriggerConfig`) | A timer/cron loop (no scheduler exists anywhere in the codebase); schedule storage + evaluation; emission of `scheduled` events with stable dedup keys per schedule tick |
| `webhook` | Trigger-type entry + config schema (URL path, expected signature scheme) + documented security requirements: **signature verification, replay protection, rate limits** | The HTTP receiver, HMAC (or equivalent) signature verification, replay-window enforcement, per-org rate limiting, payload → `WorkflowEvent` mapping |
| `task.overdue` | Trigger-type entry; the `task.overdue` contract is defined, not emitted | A sweep that finds tasks past `due_date` not yet notified and emits `task.overdue` events with per-occurrence dedup keys (so a task doesn't re-notify every sweep) |

**Also deferred:** `company.created`, `contact.created`, and activity events
(ADR-005 (f)). The event shapes are in the §9 contract; Phase 6 must add the
`dispatchWorkflowEvent` emission points to `src/lib/crm/companies.ts`,
`contacts.ts`, and `activities.ts` — **post-commit**, mirroring the
deals/tasks/projects emission pattern. The `company.created` / `contact.created`
strings currently present in those files are app-layer audit actions, not
event emissions — do not mistake them for wired triggers.

**Watch for:** when the scheduled/webhook runtimes land, re-run the trigger-type
activation check on the edit path — an ACTIVE workflow must never be editable
onto a type with no runtime (the Phase 5 code review flagged the analogous
gap for deferred types; the invariant to preserve is "ACTIVE ⇒ implemented
trigger type").

---

## 2. Deferred action types

Registry entries exist with `implemented: false`; input contracts are
documented in `src/lib/workflows/schema.ts` (and `actions.ts` trims the stray
`'scheduled'` entry out of the action registry — it is a *trigger* type; keep
it out). The builder UI hides them; the engine rejects them with a clear error
if forced.

| Action | Phase 5 left | Phase 6 must build |
|---|---|---|
| `send_notification` | Registry entry (`implemented: false`) + input contract (recipient, title, body, link) | The notification delivery path — and decide its relation to the existing in-app notification surface, if any, introduced by Phase 8 |
| `send_email` | Registry entry + input contract (to, subject, body/template) | Email provider integration + template rendering (plain path lookup only — no expression engine, same rule as Phase 5 templates) + bounce/error recording on steps |
| `webhook` | Registry entry + input contract (URL, method, headers, payload template) | **Outbound** HTTP executor with SSRF protections (this is the highest-risk deferred action — the security review's SSRF-shape checklist item applies): URL allowlist / private-range blocking, timeouts, retry policy, secret header handling |
| `run_ai_action` | Registry entry + input contract | Phase 9 (AI Foundation) territory — Phase 6 should keep the registry entry reserved and not stub it |

**D2 authority note:** every deferred action must execute under the trigger
actor's authority or an explicitly consented Phase 6/9 actor model (ADR-005
D2). Phase 6 must not invent a silent "system actor" — the "no synthetic
actor" rule still binds.

---

## 3. Durable async execution replaces the in-request pipeline

Phase 5 executes workflows **awaited inline in the originating request**
(ADR-005 (a)). Phase 6 replaces this with durable async. The seam is already
designed:

- **`WorkflowEvent` is the queue message shape.** Phase 6 persists it —
  the outbox table is Phase 6's to add (its own migration; do not reuse
  0044). Phase 5's `dispatchWorkflowEvent` is the in-process stand-in for the
  outbox writer: keep its signature and never-throw contract; swap the
  transport underneath.
- **Execution statuses already model queued/in-flight:** `PENDING` /
  `RUNNING` on `workflow_executions` exist precisely so Phase 6 can represent
  "claimed by a worker" vs "finished". Phase 6 adds **retry counters and lease
  columns** via its own migration (expiry-based re-claim so a dead worker
  doesn't strand a run forever).
- **Idempotency primitives are already in place:** the `(workflow_id,
  dedup_key)` unique constraint + `ON CONFLICT DO NOTHING` claim pattern
  (`workflow_record_execution` returning NULL on duplicate) is exactly the
  claim mechanism a multi-worker Phase 6 needs — keep it.
- **Depth bound must survive the transport change.** The Phase 5 mechanism is
  `AsyncLocalStorage` depth tracking on the event (ADR-005 (a)). When events
  cross a queue boundary, the depth must be **stamped on the queued event**
  (e.g. `WorkflowEvent.dispatchDepth`, incremented per chained dispatch,
  dropped at > 5) — the in-request ALS context will not exist in a worker.
  Do not reintroduce a sync-stack counter.
- **D1 trade-off flips:** the awaited in-request pipeline lengthens the
  triggering request; Phase 6's durable execution removes that cost, but must
  preserve the Phase 5 guarantee that a committed mutation's automation
  actually runs (at-least-once with dedup, not at-most-once).

---

## 4. `ActionConfig.key` — reserved field, wire the step-level idempotency

`ActionConfig.key` ("deterministic key for step-level idempotency where the
action is naturally keyed") is **stored on the action config and exposed in
the builder UI, but never consumed** — `engine.ts:processWorkflow` never reads
`action.key` (code review P2-1).

Phase 6 decision required: either
(a) wire it — skip a step whose key already completed within the execution
(matters most once actions can be retried by workers), or
(b) remove it from the builder UI and the schema.

Do not leave it in the ambiguous middle: a visible, stored, inert field is a
trust bug waiting to happen (users will assume idempotency they don't have).

---

## 5. `task_reminders.is_sent` — still reserved for the Phase 6 automation sweep

`task_reminders.is_sent` is **Phase 6 territory** (audit §6 debt #9, §20.5).
Phase 5 defined only the `task.overdue` *trigger contract* (item 1 above).
Phase 6's first automation consumer is the reminder sweep: no scheduler
exists, so Phase 6 builds both the timer infrastructure and the sweep that
marks `is_sent`. Do not touch `is_sent` for any Phase 5 purpose.

---

## 6. Open items Phase 6 should be aware of

- **A16 §2 (MEDIUM) — definer permission probes.** At this writing, the four
  record/finish SECURITY DEFINER functions enforce only `authz.is_active()`,
  not any `workflows.*` permission (ADR-005 "Known open recommendation").
  If the probe wasn't applied before Phase 5's merge, Phase 6's workers will
  call these functions too — settle the probe question before widening the
  caller set.
- **Deferred trigger security requirements (D8):** webhook receivers need
  signature verification, replay protection, and rate limits *before* any
  automation can fire from them — these are merge-blockers for the webhook
  trigger, not follow-ups.
- **Outbound webhook SSRF:** the `webhook` action executor is the single
  highest-risk new network surface; it needs the full adversarial review
  treatment (private-range blocking, redirects, timeouts, secret handling)
  that Phase 5's engine never needed.
- **Manual-execution semantics under async:** `executeWorkflowManual`
  currently awaits `processWorkflow` and returns `202 { executionId, status }`.
  Under durable async, decide whether manual runs enqueue like everything
  else (status becomes eventually-consistent) or stay synchronous — and keep
  the API contract honest either way.
