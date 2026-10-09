# Phase 9 — AI Foundation

Developer and operator documentation for the AI Foundation module (`src/lib/ai/*`, `/api/ai/*`). Phase 9 of Pravshi OS.

> Status: implemented. Provider abstraction (deterministic mock by default, OpenAI-compatible adapter when configured), request orchestrator, permission-aware context builder, six read-only tools, eight capabilities, database-backed usage metering with per-org limits, three API routes, and the `AiSummaryPanel` UI on the six record detail pages. Migrations `0054_ai_foundation` and `0055_ai_permissions`.
>
> This document tracks the implementation, not aspirations: every env var name, route path, permission key and default value below was verified against the landed source. Design authority: the Phase 9 master prompt and `phase9-contract-review.md` (contract section numbers in parentheses refer to it).

---

## 1. Architecture

### 1.1 Logical flow

```
Record detail page (server component)
  └─ <AiSummaryPanel canUseAi={…}>          display gating only — not authorization
       └─ POST /api/ai/assist               withPermission('ai.use')
            └─ runAiRequest()               src/lib/ai/orchestrator.ts — the only path to a provider
                 ├─ limit evaluation        src/lib/ai/usage.ts + limits.ts (SECURITY DEFINER aggregates)
                 ├─ context builder         src/lib/ai/context/* — authorized services only
                 ├─ capability layer        src/lib/ai/capabilities.ts (prompt + output validation)
                 ├─ provider                src/lib/ai/provider/* (mock | openai-compatible)
                 ├─ tool registry           src/lib/ai/tools/* — read-only, dispatched server-side
                 └─ existing business services (src/lib/crm/*, src/lib/work/*) — the only data path
```

There are no separate microservices: this is a modular monolith following the repository's existing conventions (authorized DB context, RLS, catalogue permissions, §24 error envelopes).

### 1.2 Module map — `src/lib/ai/`

| File | Responsibility |
|---|---|
| `types.ts` | Single canonical declaration of the capability-id union and target entity types; the assist input, the success body, and the orchestrator outcome union the route maps to HTTP. |
| `schema.ts` | Zod schemas: the strict assist-request body and the structured summary output (strings ≤ 500 chars, lists ≤ 10). |
| `errors.ts` | `AiProviderError` + the normalized 7-code taxonomy (§3.2). Messages are static — provider bodies, headers and key material are never interpolated. |
| `config.ts` | `resolveAiConfig()` — provider selection and numeric config purely from `src/env.ts` values. |
| `capabilities.ts` | The 8-capability registry: per-capability instructions, request assembly from built context, structured-output parsing and source reconciliation. Fetches no data and executes no tools itself. |
| `orchestrator.ts` | `runAiRequest()` — the request lifecycle (§1.3). Owns the deadline, the bounded tool loop, metering calls and the audit entry. |
| `usage.ts` | Two-phase metering service (`beginAiUsageRequest`, `finalizeAiUsageRequest`, `recordAiUsageOutcome`), limit evaluation, limits read/upsert, monthly usage summary. |
| `limits.ts` | Pure limit logic: `AI_LIMIT_DEFAULTS`, `resolveEffectiveLimits()`, `checkLimits()` (§3 below). No DB access. |
| `provider/types.ts` | The `AiProvider` interface: `complete(req, signal)` with normalized messages, tool definitions/calls and usage metadata. No provider-specific type escapes this folder. |
| `provider/mock.ts` | Deterministic mock provider — the default (§2.2). |
| `provider/openai-compatible.ts` | Fetch-based adapter for any OpenAI-compatible chat-completions endpoint (§2.3). |
| `provider/index.ts` | `getAiProvider()` factory, including the not-configured stub (§2.4). |
| `context/builder.ts` | `buildContext()` — assembles per-capability context segments under hard size caps. |
| `context/recipes.ts` | Per-capability recipes with hard field allowlists (`CONTEXT_ALLOWLISTS`), projected from the existing CRM/work services. |
| `context/delimit.ts` | `<record_data>` serialization and untrusted-text escaping (§1.5). |
| `context/system-prompt.ts` | Versioned system-prompt builder (`AI_SYSTEM_PROMPT_VERSION = 'v1'`) with the instruction-hierarchy clause. |
| `context/types.ts` | Context target/source types; re-exports the capability ids from `types.ts` (single declaration). |
| `tools/registry.ts` | `AiTool` type, registry, and `dispatchToolCall()` — validation, permission pre-check, timeout, result mapping. Never throws. |
| `tools/crm-tools.ts` | The six read-only CRM/work tools and the composed `toolRegistry`. |

API + UI: `src/app/api/ai/assist/route.ts`, `src/app/api/ai/usage/route.ts`, `src/app/api/ai/usage/limits/route.ts`; `src/components/ai/AiSummaryPanel.tsx`, `ai-client.ts` (envelope-aware fetch), `can-use-ai.ts` (server-side display flag reading `authz.has('ai.use')`).

### 1.3 Request lifecycle — `runAiRequest()`

1. **Route authorization.** `withPermission('ai.use')` authenticates and authorizes before the orchestrator runs; refusals are the standard envelopes (401/403/404).
2. **Input validation.** Capability must be one of the eight ids; target shape and type must match the capability; `general_assistance` requires a `question` (≤ 2,000 chars). Violations → `400 INVALID_REQUEST`. Body ≤ 16 KB, strict object (unknown keys rejected).
3. **Limit evaluation.** Effective limits + counters are read in one transaction through the SECURITY DEFINER aggregates (§3.2). Denied → a terminal `LIMITED` usage row + audit entry → `429 AI_LIMITED` (with `retryAfterSeconds` in the error object when the decision supplies one — 60 for the per-minute limit, otherwise omitted).
4. **Not-configured check.** If a real provider is selected but its key or model is missing → a terminal `NOT_CONFIGURED` usage row + audit entry → `503 AI_NOT_CONFIGURED`. This runs before context building: records are never fetched for a request that cannot run.
5. **Context building.** Through the existing authorized services only (§1.5). An invisible or cross-tenant target surfaces as the service layer's `NOT_FOUND` (404) — it is never converted into an empty summary, and **no usage row is written** for a request that was never authorized to see its target.
6. **Metering begins.** The `STARTED` usage row is inserted. If this insert fails, the request is refused — there is no unmetered AI (fail-closed for AI, §3.2).
7. **Provider execution.** One `AbortController` deadline (`AI_TIMEOUT_MS`) bounds the whole execution. The adapter owns its own bounded retry policy (§2.3); the orchestrator adds no retries. Tool loop: tools are offered only to `general_assistance`; at most **3** tool dispatches per request, each through the registry dispatcher; results return to the model wrapped in `<record_data>` blocks. When the budget is spent, the model gets one final tool-less call to answer from what it has. Token usage accumulates across rounds.
8. **Output validation.** The capability layer validates the model's JSON against the summary schema and reconciles its source citations with the built context — citations to records that were not in context are dropped. Validation failure finalizes the row `FAILED` / `PROVIDER_BAD_RESPONSE` → `502 AI_PROVIDER_FAILED`.
9. **Finalize + audit.** The usage row is finalized (`SUCCEEDED` with reported token counts, attempts, tool-call count, duration; or `FAILED` with the taxonomy code), exactly one `ai.request` audit entry is written (§4.2), and the success body is returned: `{ requestId, capability, status: 'ok', summary: { headline, facts, suggestions, missingInformation }, sources: [{ entityType, entityId, label }], usage: { provider, model, totalTokens } }`.

A provider failure after step 6 finalizes the row `FAILED` with the normalized taxonomy code and returns `502 AI_PROVIDER_FAILED`; the client envelope carries only a safe static message — the taxonomy code lives in the usage row and server logs. In every failure mode the rest of the application is unaffected.

### 1.4 Capabilities

| Capability id | Target | Notes |
|---|---|---|
| `lead_summary` | deal | A "lead" in Pravshi OS is a deal in the NEW pipeline stage (`src/lib/analytics/crm.ts`); this is the deal recipe with lead-qualification instructions (missing info + next steps). No stage hard-check is performed. |
| `deal_summary` | deal | Status, stage, recorded value/expected close date, linked company/contact, activity, recorded risks. |
| `contact_summary` | contact | Identity as recorded + relevant interactions. |
| `company_summary` | company | Record + up to 20 contact briefs, 20 deal briefs, 20 activities. |
| `activity_summary` | activity — or a company/contact/deal (its activity history) | What happened and what remains open. |
| `project_summary` | project | Record + task counts (true total; by-status over the fetched 50) + first 20 task briefs. |
| `task_summary` | task | Record + project label. |
| `general_assistance` | optional target + required `question` | No pre-fetched records; the only capability offered tools. API-complete in V1; **no dedicated UI surface** (§5). |

Every capability returns the same structured summary shape. `facts` (grounded in the supplied records) and `suggestions` (model recommendations) are **structurally separate fields** end to end — schema, prompts and UI. The schema has no field that could hold an invented probability, revenue figure or close date, and every capability's instructions repeat that ban.

### 1.5 Security boundaries

- **The model is never an authorization authority.** Application authorization rules always take precedence over model output and model-requested tool calls.
- **Context only via authorized services.** The context builder calls the existing services (`getCompany`, `getContact`, `listContacts`, `getDeal`, `listDeals`, `getActivity`, `listActivities`, `getProject`, `getTask`, `listProjectTasks`) under the caller's `Authorization`. It never writes SQL against CRM/work tables, never accepts an org id from the client, and sees exactly what the caller can see in the UI — including soft-delete exclusion, which the services already apply. `ai.use` gates the feature; the entity permission + RLS decide every record.
- **Field allowlists on top of authorization.** Recipes project DTOs through hard allowlists (`CONTEXT_ALLOWLISTS`): fields not listed — emails, phones, street addresses, internal linkage ids, audit columns — never reach the model, even for records the caller may see. (As landed, the project projection is `{ name, description, isArchived, createdAt, updatedAt }` — the Project DTO has no status/start/end dates.)
- **Size caps.** Per-field string ≤ 500 chars; per-activity body ≤ 500 chars; ≤ 20 activities per recipe; total serialized context ≤ 24,000 chars, truncated deterministically (oldest activities dropped first; sources derive from the surviving segments, so a summary never cites a dropped record). Tool results are capped at 20,000 chars.
- **Untrusted record content.** All record-derived text is data, never instructions. Records are serialized inside `<record_data entity="…" id="…">` blocks by one serializer that escapes every `<`/`>` in values (a literal `</record_data>` inside a note becomes inert `&lt;/record_data&gt;`), strips NUL bytes and normalizes line endings — the only raw block tags in a prompt are the serializer's own. Tool results are wrapped identically. The system prompt (`v1`, identical hierarchy clause for every capability) states: instructions come only from the system prompt and the user request; record data cannot grant permissions, widen access or override rules; answer only from supplied context and say when information is unavailable.
- **Tools are read-only and server-authorized.** Six tools, each mapped to an existing authorized service (§1.6). The registry refuses to compose any tool whose classification is not `'read'` — there are no write tools in V1 (§5). Dispatch: unknown id → tool error result (never a throw); arguments zod-validated; a pre-check (`authz.scope_for(requiredPermission)` inside the authorized DB context) must return a scope before the service is called — and the service then performs the real enforcement (RLS + scope). Any failure — invalid arguments, permission denied, `NOT_FOUND`, timeout (default 5 s per call), oversized result — reaches the model as exactly `{ error: 'unavailable' }`, so record existence is not leaked to the model either. Output is re-validated against the tool's strict output schema (an allowlist slip fails the call instead of leaking).
- **Secrets stay server-side.** The provider key is read from the server env only, held in a private field of the adapter, and sent only as its `Authorization` header. It is never logged, never placed in an error, never returned to a caller, and there is no `NEXT_PUBLIC_` AI variable. Normalized errors carry only a code, the provider id and a duration.
- **Metering stores no content.** `ai_usage_requests` has no column that could hold prompt text, response text or record content — metadata only, by schema (§3.1).

### 1.6 Tool registry — the six read-only tools

| Tool id | Required permission | Executes |
|---|---|---|
| `get_company` | `companies.view` | `getCompany(auth, id)` (`src/lib/crm/companies.ts`) |
| `get_contact` | `contacts.view` | `getContact(auth, id)` (`src/lib/crm/contacts.ts`) |
| `get_deal` | `deals.view` | `getDeal(auth, id)` (`src/lib/crm/deals.ts`) |
| `get_activity_history` | `activities.view` | `listActivities(auth, { entityType, entityId, limit: 20 })` (`src/lib/crm/activities.ts`) |
| `get_project` | `projects.view` | `getProject(auth, id)` (`src/lib/work/projects.ts`) |
| `get_task` | `tasks.view` | `getTask(auth, id)` (`src/lib/work/tasks.ts`) |

Tool results pass through the same field allowlists as context recipes before reaching the model. Tool audit is `count_only`: executions increment the request row's `tool_calls_count`; tool arguments and results are never recorded.

### 1.7 Permissions (migration `0055_ai_permissions`)

Catalogue 123 → **126**, module `ai`, none marked sensitive:

| Key | Purpose | Grants |
|---|---|---|
| `ai.use` | Invoke AI assistance (coarse gate only — record access is per-record, §1.5) | SUPER_ADMIN GLOBAL, ADMIN GLOBAL, SALES_MANAGER DEPARTMENT, PROJECT_MANAGER DEPARTMENT, MANAGER DEPARTMENT, SALES SELF, EMPLOYEE SELF, INTERN SELF, FINANCE SELF, DEVELOPER PROJECT, VIBECODER PROJECT. **Not granted:** HR_ADMIN, HR_MANAGER, MARKETING (no CRM/work record access). Scopes mirror each role's widest existing record-view grant and never widen record access. |
| `ai.usage.view` | View the org's AI usage aggregates and limits | SUPER_ADMIN + ADMIN, GLOBAL |
| `ai.usage.manage` | Create/update the org's limit row, incl. the kill switch | SUPER_ADMIN + ADMIN, GLOBAL |

SUPER_ADMIN's grants arrive via the whole-catalogue cross join in `seed_system_roles()`; ADMIN's are explicit. Existing orgs were backfilled with the 0045 defensive pattern; new orgs converge through `seed_system_roles()`.

### 1.8 Frontend

`AiSummaryPanel` is mounted below the header card on the six record detail pages — companies, contacts, deals, activities (`src/app/(app)/crm/…/[id]`), work projects and work tasks (`src/app/(app)/work/…/[id]`) — each passing its capability, entity type/id, and a server-computed `canUseAi` flag. The flag is display gating only; the backend enforces `ai.use` and every record permission independently.

Panel states: idle ("Summarize" button) → loading (skeleton) → success (headline; **Facts**; **Missing information**; **Suggestions** under a visually distinct "AI suggestions" badge; sources as muted links to the records; provider/model as small muted text) → not-configured (calm message, no button) → limited (limit message; button disabled while the server-supplied `retryAfterSeconds` counts down) → error (safe message + Retry) → forbidden (access-denied message; normally unreachable because of display gating). No provider key, raw error or taxonomy code ever reaches the UI. No nav changes; no new pages.

---

## 2. Provider configuration and setup

### 2.1 Environment variables

All six are **optional**; with none of them set, the application boots and behaves exactly as before Phase 9, with AI running on the mock provider. They are declared as optional keys in the `runtimeSchema` in `src/env.ts` (with `AI_BASE_URL` validated as a URL when present) and listed, commented out with safe placeholders, in the "Phase 9 AI Foundation" section of `.env.example`.

| Variable | Meaning | Default / behaviour |
|---|---|---|
| `AI_PROVIDER` | Provider selector: unset or `mock` → deterministic mock; `openai-compatible` (alias `openai`) → the real adapter. Any other value falls back to the mock. | `mock` |
| `AI_MODEL` | Model id for the real adapter. Required only when a real provider is selected. | — |
| `AI_API_KEY` | Server-side provider key. Never prefix with `NEXT_PUBLIC_`; never logged. | — |
| `AI_BASE_URL` | OpenAI-compatible endpoint override — any compatible endpoint can be used (another vendor, a gateway, a self-hosted server). | `https://api.openai.com/v1` |
| `AI_TIMEOUT_MS` | Overall AI request deadline in milliseconds (positive integer; unparseable/non-positive values fall back to the default). | `30000` |
| `AI_MAX_OUTPUT_TOKENS` | Output token cap; clamped to 100–4000. | `800` |

Example (`.env`, placeholders only — never commit a real key):

```bash
# AI_PROVIDER=openai-compatible
# AI_MODEL=<your-model-id>
# AI_API_KEY=<redacted>
# AI_BASE_URL=https://api.openai.com/v1
# AI_TIMEOUT_MS=30000
# AI_MAX_OUTPUT_TOKENS=800
```

### 2.2 The mock provider (default)

`id: 'mock'`, `model: 'mock-deterministic'`. Zero network; behaviour is a pure function of the request — identical input produces identical output. It exists so the whole stack (UI, orchestrator, metering, tools, tests) runs end-to-end with no credentials.

- **Summary responses** are assembled from the context it was given: headline = the first context record's label; facts = up to five allowlisted `key: value` field lines present in the context; suggestions = a fixed, clearly generic pair ("Review this summary against the source records before acting on it." / "Follow up on any missing information noted above."); `missingInformation` reports that no context records were provided when there are none.
- **Text responses** (non-JSON) are prefixed `[mock]` so synthetic output is unmistakable: `[mock] Synthetic response. No live AI provider is configured for this workspace.`
- **Tool behaviour:** when tools are offered, it emits at most one tool call — for the first offered tool whose id appears verbatim in a user message (this is how tests drive the tool loop deterministically).
- **Usage numbers** come from a documented estimator (characters ÷ 4, ceiling). They are labelled by `provider: 'mock'` wherever recorded. The "never invent token counts" rule applies to real-provider reporting, not to this test double.

Because summaries are labelled with provider/model in the success payload and the panel shows them as muted text, mock output is identifiable wherever it surfaces. **Do not mistake a working mock response for a live model** — check `usage.provider` in the response, or the `provider` column of the usage rows (§4).

### 2.3 The OpenAI-compatible adapter

Selected with `AI_PROVIDER=openai-compatible` plus `AI_MODEL` and `AI_API_KEY`. Plain `fetch` — no SDK dependency. It POSTs `${AI_BASE_URL}/chat/completions` with `Authorization: Bearer <key>` and a body mapped from the provider interface (`responseFormat: 'json'` → `response_format: { type: 'json_object' }`; tools → the OpenAI function shape). Responses are zod-validated; usage is mapped field-by-field and **absent fields stay null — counts are never invented**.

Failure normalization (the full taxonomy is §4.3): 401/403 → `PROVIDER_AUTH`; 429 → `PROVIDER_RATE_LIMITED`; ≥ 500 → `PROVIDER_UNAVAILABLE`; other 4xx → `PROVIDER_REJECTED`; abort/timeout → `PROVIDER_TIMEOUT`; unparseable or schema-failing body → `PROVIDER_BAD_RESPONSE`.

Timeouts and retries: the orchestrator's deadline (`AI_TIMEOUT_MS` from invocation) is the overall budget; each attempt's deadline is the remaining budget. **Max 2 attempts**, only for retryable codes, with a 250 ms backoff before the second attempt; a 429's `Retry-After` replaces the backoff but is honoured only if it fits inside the remaining deadline. There is no provider fallback chain in V1.

### 2.4 Not configured — `AI_NOT_CONFIGURED`

If a real provider is selected but `AI_API_KEY` or `AI_MODEL` is missing, provider construction still succeeds and the app boots normally; the factory returns a stub whose `complete()` throws the typed `AI_NOT_CONFIGURED` error. The orchestrator detects this state before any record is fetched, records a `NOT_CONFIGURED` usage row, and the API returns **503** with the message "AI isn't configured for this workspace yet." The panel renders its calm not-configured state (no button). Nothing else in the application is affected — missing AI configuration can never break CRM work.

### 2.5 Startup validation

The runtime env schema (`src/env.ts`) validates shape only: all six AI keys are optional, none is required at boot, and a boot with all six unset (or all six set) is valid. Configuration *completeness* for a real provider is deliberately a request-time state (§2.4), not a boot failure.

---

## 3. Usage, cost and rate controls

### 3.1 The metering tables (migration `0054_ai_foundation`)

**`public.ai_usage_requests`** — one row per orchestrated request, written in two phases (§1.3 steps 6 and 9): inserted as `STARTED` before the provider is invoked, then updated in place to its final status. Provider retries and tool rounds never create rows. Columns: `org_id`, `person_id`, `request_id` (the app request id; unique per org — joins audit metadata), `capability` (CHECK over the eight ids), `provider`, `model` (NULL when the provider was never invoked), `status` (CHECK: `STARTED | SUCCEEDED | FAILED | LIMITED | NOT_CONFIGURED`), `prompt_tokens` / `completion_tokens` / `total_tokens` (provider-reported only; NULL = not reported), `provider_attempts`, `tool_calls_count`, `duration_ms` (set at finalize), `error_code` (taxonomy code only), `target_entity_type` / `target_entity_id` (attribution only), timestamps. **No prompt, response or record-content columns exist.**

RLS is enabled and forced. `app_owner` has full access. For `app_user`: SELECT requires `ai.usage.view` **or the row being the requester's own** (own-rows carve-out — the repo's standard notifications pattern; without it, Postgres applies the SELECT policy to the requester's own UPDATE/`RETURNING` and the two-phase finalize can never see its row; org-wide reads remain gated on `ai.usage.view`); INSERT/UPDATE are restricted to the requester's own rows under `ai.use`; there is no DELETE policy. Tenant-guard triggers reject cross-org `org_id` and out-of-org `person_id` with `42501`.

**`public.ai_org_limits`** — one row per org (absence of a row = code defaults): `enabled` (kill switch, default true), `monthly_request_limit`, `monthly_token_limit`, `max_requests_per_minute_per_user`, `max_concurrent_requests` (each NULL = default), `updated_by`, timestamps. RLS enabled and forced: SELECT gated on `ai.usage.view`; INSERT/UPDATE gated on `ai.usage.manage`; no DELETE.

**Aggregate functions.** The mid-request limit check must work for `ai.use` holders who do not hold `ai.usage.view`, so counters are read through two SECURITY DEFINER functions (the `notifications_recipient_exists` precedent): `public.ai_effective_limits(p_org_id)` returns the org's row merged over the defaults; `public.ai_usage_counters(p_org_id, p_person_id)` returns four aggregate numbers only. Both derive org/person from server-passed session values — never from the client — are revoked from PUBLIC, and are granted to `app_user`.

### 3.2 Counting rules and failure semantics

| Limit | Default | Counted from `ai_usage_requests` |
|---|---|---|
| Monthly requests / org | 5,000 | Current calendar month (UTC), status `SUCCEEDED` or `FAILED` |
| Monthly tokens / org | 2,000,000 | `sum(total_tokens)` over `SUCCEEDED` rows this month; NULL counts 0 — never invented |
| Requests / minute / user | 10 | The caller's rows in the trailing 60 s, status ≠ `LIMITED` |
| Concurrent / org | 4 | Rows `STARTED` within the last 5 minutes (stale rows from crashed requests age out automatically) |

- Check order: **enabled → concurrency → per-minute → monthly requests → monthly tokens**; first failure wins. `retryAfterSeconds` is 60 for the per-minute limit, otherwise null.
- `enabled = false` refuses every request with reason `disabled`.
- **A `LIMITED` or `NOT_CONFIGURED` outcome never consumes request or token quota** — the counting filters above exclude them by construction, so recording the visibility row can never amplify a limit (the anti-amplification rule for retry attacks). One nuance: the per-minute filter is `status <> 'LIMITED'`, so `NOT_CONFIGURED` rows do appear in that trailing-60 s window while a workspace is misconfigured — they consume no monthly quota.
- Retries never double-count: quota is per request row; retries only raise `provider_attempts` on that row (§5 for what `provider_attempts` actually counts).
- **Fail-open for the app, fail-closed for AI.** If the finalize UPDATE fails, the error is logged (console + Sentry) and the user still receives their summary — metering must never break CRM work. If the initial `STARTED` insert fails, the AI request is refused (no unmetered AI) and nothing else is affected. The `LIMITED`/`NOT_CONFIGURED` visibility inserts never throw either; a failed one is logged and the 429/503 answer stands.

### 3.3 Managing limits — the usage APIs

All three routes are org-scoped to the caller and return `Cache-Control: no-store`.

- **`GET /api/ai/usage`** (`ai.usage.view`) — monthly aggregates for the caller's org: `{ period: 'YYYY-MM', requests, succeeded, failed, limited, totalTokens, byCapability: [{ key, requests, totalTokens }], byProvider: [...] }`. Current UTC month by default; `?month=YYYY-MM` selects another. Note `requests` counts **all** rows in the month, so it can exceed `succeeded + failed + limited` when `NOT_CONFIGURED` rows exist (they have no dedicated counter in the response).
- **`GET /api/ai/usage/limits`** (`ai.usage.view`) — `{ effective, limits }`: the effective limits (defaults merged) plus the raw stored row, or `null` when the org has never saved one.
- **`PUT /api/ai/usage/limits`** (`ai.usage.manage`) — full-row upsert: `enabled` (boolean) and the four caps, each a non-negative integer (≤ 1,000,000,000) or `null` for "use the default". Every field is supplied on every write — it is an admin settings save, not a patch. Every successful update writes an `ai.limits.update` audit entry (entity `ai_org_limits`) with the new values as flat metadata.

### 3.4 What LIMITED means for users

A limited request returns `429 AI_LIMITED` and the panel shows "AI usage limit reached for this workspace. Please try again later.", disabling the button while `retryAfterSeconds` counts down when one was supplied. Which limit fired (kill switch, concurrency, per-minute, monthly requests, monthly tokens) is **not** exposed to the user — the reason is an internal decision value; admins infer it from the counters via `GET /api/ai/usage` and the limits row. Ordinary CRM features remain fully available at all times; limits only ever refuse AI requests. Requests refused for other reasons read differently: not configured → 503 (§2.4), provider failure → 502.

---

## 4. Operational runbook

### 4.1 Diagnosing a failed AI request

Start from the request id (returned in every envelope and success body) or the time window, and read the org's rows:

```sql
select created_at, request_id, capability, provider, model, status,
       prompt_tokens, completion_tokens, total_tokens,
       provider_attempts, tool_calls_count, duration_ms, error_code,
       target_entity_type, target_entity_id
from public.ai_usage_requests
where org_id = '<org uuid>'
order by created_at desc
limit 50;
```

(Read as `app_owner`, or as a user holding `ai.usage.view` for org-wide reads.)

| Observation | Meaning | Action |
|---|---|---|
| `status = 'NOT_CONFIGURED'` rows | A real provider is selected but `AI_API_KEY` or `AI_MODEL` is missing in this environment | Set both (§2.1) and redeploy/restart; no data fix needed |
| `status = 'LIMITED'` rows appearing | A limit is refusing requests (§3.2) | Check `GET /api/ai/usage` counters against `GET /api/ai/usage/limits`; look for `enabled = false` first (kill switch), then monthly counters, then burst patterns (per-minute / concurrency) |
| `FAILED` + `PROVIDER_AUTH` | The provider rejected the key (401/403) | Rotate/fix `AI_API_KEY`; non-retryable — every request fails until fixed |
| `FAILED` + `PROVIDER_RATE_LIMITED` | Provider 429 persisted past the single bounded retry | Provider-side quota/rate problem; check the provider account; consider lowering per-org limits to smooth load |
| `FAILED` + `PROVIDER_TIMEOUT` | Deadline (`AI_TIMEOUT_MS`) exhausted | Check provider latency/outage; raise `AI_TIMEOUT_MS` only if the provider is genuinely slow |
| `FAILED` + `PROVIDER_UNAVAILABLE` | Provider 5xx or network failure | Provider outage or a wrong `AI_BASE_URL` (verify the endpoint serves `/chat/completions`) |
| `FAILED` + `PROVIDER_REJECTED` | Other provider 4xx — request refused | Usually a bad `AI_MODEL` id or an endpoint that is not truly OpenAI-compatible |
| `FAILED` + `PROVIDER_BAD_RESPONSE` | Response unparseable, failed schema validation, or the model's JSON failed the summary schema | Endpoint compatibility problem, or a model that cannot follow the structured-output instructions — try a stronger model |
| Row stuck at `STARTED` | The request crashed after metering began | Evidence, not corruption: it ages out of the concurrency window after 5 minutes and never counts toward monthly quotas. Investigate the crash via logs/Sentry |
| No row at all | The request never reached metering: authorization refusal (401/403), invalid body (400), invisible target (404, §1.3 step 5), or the `STARTED` insert itself failed | Check the audit log / app logs for the request id; a failed `STARTED` insert is logged as an `[ai] usage metering failure` |
| Summary delivered but the row says `FAILED` finalize | The finalize UPDATE failed after the answer was produced (§3.2 fail-open) | Logged (console + Sentry, tag `source: 'ai-usage'`); the row may remain `STARTED` — see above |

Metering failures are logged with the prefix `[ai] usage metering failure` and captured to Sentry with tag `source: 'ai-usage'`. A failed audit write logs `[ai] audit write failed` and never changes the request's outcome.

### 4.2 Audit trail

Every orchestrated request that reaches a terminal outcome writes exactly one entry via `writeAuditEntry`: `action = 'ai.request'`, `entityType = 'ai_request'`, `entityId` = the usage row's id (NULL when the visibility-row insert failed), `result` SUCCESS/ERROR, severity LOW (success) / MEDIUM (failure or limited), and flat metadata only: `{ capability, provider, model, status, totalTokens, durationMs }` — plus the request id via the standard request metadata. There is no content in the audit trail, by the writer's flat-metadata rule. Authorization refusals before the orchestrator runs are audited by the authz layer itself (`DENIED`). Limits changes write `ai.limits.update` (§3.3).

### 4.3 Error taxonomy (recorded as `error_code` on FAILED rows)

| Code | Meaning | Retryable |
|---|---|---|
| `AI_NOT_CONFIGURED` | Real provider selected but key/model missing | no |
| `PROVIDER_TIMEOUT` | Attempt exceeded its deadline / aborted | yes |
| `PROVIDER_RATE_LIMITED` | Provider 429 (`Retry-After` honoured within the deadline) | yes |
| `PROVIDER_UNAVAILABLE` | Provider 5xx / network failure | yes |
| `PROVIDER_AUTH` | Provider 401/403 — bad key | no |
| `PROVIDER_REJECTED` | Other provider 4xx — request refused | no |
| `PROVIDER_BAD_RESPONSE` | Body unparseable, fails validation, or structured output invalid | no |

Raw provider errors, response bodies and headers are never propagated to callers or logs — only the normalized code, provider id and duration travel.

### 4.4 Environment and change rules

- **Production migrations are a separate, explicit operation.** `0054`/`0055` apply through the repository's migration tooling (`scripts/migrate-ws.mjs` semantics; journal entries idx 53/54 with `when` 1791343891089 / 1791343891090). Applying them is never a side effect of configuring AI, and this feature's rollout does not authorize a production migration.
- **Provider keys are a separate, explicit operation.** Setting `AI_API_KEY` (and `AI_MODEL` / `AI_PROVIDER`) happens in the environment's secret store, never in the repo, never in `.env.example`, never in a migration. Key rotation: replace the env value and redeploy/restart — no data change is involved, and in-flight behaviour is unaffected (each request resolves config fresh).
- **Environment separation is preserved.** AI tests use the deterministic mock or stubbed `fetch`; no test requires or may claim real-provider behaviour. Test databases never use production credentials.
- **Rolling back AI** needs no data migration: unset `AI_PROVIDER` (back to the mock) or set the org's `enabled = false` kill switch via `PUT /api/ai/usage/limits` for a per-org stop. The metering tables are inert when unused.

---

## 5. Known limitations

- **The mock is the default.** Without provider credentials, every AI answer is synthetic mock output (§2.2) — useful for exercising the stack, worthless as business insight. It is labelled (`provider: 'mock'`, model `mock-deterministic`) in responses, usage rows and the panel, but operators must check before trusting any summary.
- **No write tools.** The registry is structurally read-only: no capability can create, modify or delete any record, and no AI action executes from model output. Write tools were deliberately excluded — prompt §8 permits them only with explicit permission checks and clearly defined confirmation rules, no human-confirmation surface exists in the app today, and the model must never approve its own actions. The registry's `classification` field and dispatch path are the seam where a future phase can add confirmed writes.
- **`provider_attempts` counts orchestrator rounds, not adapter attempts.** The provider interface's completion result carries no attempt count, so the row records how many `complete()` invocations the orchestrator made (one per round, ≤ 1 + tool rounds). The adapter's internal retries (max 2 attempts per invocation, §2.3) are not individually observable in the metering data.
- **`general_assistance` has an API but no UI.** The capability is complete and tested at `POST /api/ai/assist` (question + optional target + the six read tools), but no chat surface exists in V1 — no existing screen justified one, and the prompt forbids an unjustified AI dashboard. The panel only ever sends a capability + target.
- **Client disconnect does not cancel the provider call.** There is no AbortSignal plumbing from Next route handlers in V1; the `AI_TIMEOUT_MS` deadline bounds the cost regardless, and the request completes (and is metered) server-side.
- **Long-lived databases that applied `0053` pre-fix need a one-row journal repair before `0054`/`0055` will apply.** Those databases carry `created_at` 1791343891087 for 0053 from before the Phase 8 journal-timestamp fix (the file now reads 1791343891088), so the runner tries to re-apply 0053. Repair: update that one `drizzle.__drizzle_migrations` row's `created_at` to 1791343891088, matched by the migration file's sha256 — bookkeeping only, no schema change (already done on the long-lived verification database). Fresh installs and CI branches are unaffected; production has not applied 0045+ at all.
- **No provider fallback chain.** If the configured provider is down, requests fail with 502 (§4.1); there is no automatic failover to a second provider or to the mock.
- **`general_assistance` orientation is minimal.** Its pre-fetched context is the caller's access scope only (no org/profile names — no authorized service exposes them); everything else arrives via tools, as designed.
