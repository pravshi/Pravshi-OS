# Phase 11 — Security Hardening

Developer and operator documentation for the Phase 11 hardening changes (migration `0061_security_hardening`, the auth choke point in `src/lib/auth/server.ts`, the pre-login flows, and the abuse/browser controls). Phase 11 of Pravshi OS.

> Status: implemented. Phase 11 is a hardening phase, not a surface phase: it adds no tables, no routes, no permission keys, no env vars and no dependencies. It closes the findings register of `phase11-architecture-audit.md` (contract section numbers in parentheses refer to it) — two families of SECURITY DEFINERs that trusted caller-supplied identity, four tables whose identity columns were rewritable, a library sign-in path that bypassed the lockout and all login-event recording, a password-reset timing oracle, a password-policy parity gap, three unthrottled expensive surfaces, and supply-chain residue from before PR #66. The audit found **no Critical or High findings**; the register is 5 Medium, 8 Low, 1 Info, plus one Low carried from Phase 9.
>
> This document tracks the implementation, not aspirations: every mechanism, constant, path and error code below was verified against the landed source. Where the shipped code refined — or corrected — the audit, this document describes the code and says so (§3.10 is the notable case: the audit's current-state claim was wrong).

---

## 1. What changed, in one view

| Layer | Change | Findings |
|---|---|---|
| Database (migration `0061`) | Context assertions inside five SECURITY DEFINERs; identity-freeze triggers on four tables; one narrow pre-auth enqueue definer; verification DO blocks | F-11-01, F-11-02, F-11-03, F-11-13, F-11-06 (mechanism) |
| Auth choke point (`src/lib/auth/server.ts`) | Lockout + login-event recording moved into the Better Auth hooks every sign-in crosses; the library reset endpoints refused; sign-out recorded | F-11-04, F-11-05 |
| Pre-login flows | Forgot-password send decoupled onto the Phase 10 email job plane; the full password policy enforced at invitation accept and bootstrap setup | F-11-06, F-11-07 |
| Abuse & browser controls | Rate limits on inbound webhooks, search, audit-log export; `Permissions-Policy`; CSP `connect-src` for Sentry ingest | F-11-08, F-11-09, F-11-12 |
| Already satisfied | Origin verification in `withPermission` pre-dated the phase; Phase 11's delta is the behavioural pin | F-11-10 |
| Housekeeping | Legacy Neon workflow and two dormant migration files retired | F-11-11, F-11-14 |

**Migration numbering.** The audit contracted this migration as `0060_security_hardening`. It landed as **`0061_security_hardening`** (journal idx 60) because Phase 10's CI fix wave consumed 0060 for the integrations write plane after the audit was written. One migration, as contracted — only the number moved.

---

## 2. Migration `0061_security_hardening` — full inventory

No tables, no columns, no permission rows. Six parts; PART 6 fails the migration rather than leave a half-hardened schema (the 0047/0060 verification pattern: assertions present in definer bodies, triggers present, functions `prosecdef` with the right grants).

### PART 1 — `ai_effective_limits`: org assertion (F-11-01)

The function now raises `42501` unless `p_org_id = (select authz.org_id())`. A context-free call (no org derivable in the transaction) refuses — fail closed. All call sites already pass the session's own org, so no caller changed.

### PART 2 — `ai_usage_counters`: org + person assertions (F-11-01)

Same org assertion. For the person: the per-minute window names a person, so the caller reads either **its own** cadence (`p_person_id = authz.person_id()`) or, holding `ai.usage.view` in the context org, another person's (the admin usage read). The audit's third candidate exception — the system actor — is **deliberately not coded**: a system-actor context has no person-derived org, so it has already refused at the org assertion, and the exception list must not grow by accretion (audit §6 Q8). The counting rules are 0054's, unchanged — including the carried Phase 9 finding (§3.14).

### PART 3 — `notification_channel_enabled`: the plain assertion (F-11-02)

The delivery gate runs under the notification **creator's real-person context** (the workflow `send_notification` action creates the notification in its creator's authorized transaction and reads the gate there), so it gets the plain 0044 idiom: `p_org_id = (select authz.org_id())`, `42501` otherwise.

**Addendum (P1b, migration 0064 — AUD-04):** the function gained a second caller kind and its assertion was harmonised with the rest of the family. The task-reminder sweep (`src/lib/jobs/reminder-sweep.ts`) runs on the person-less worker plane and must ask the same one-bit question per claimed reminder; under the plain assertion that call could never hold. The body now asserts **by context kind** (the PART 3A resolution verbatim): person context → `p_org_id = authz.org_id()`; person-less context → `p_org_id` must equal the transaction's `app.org_id` claim, which the sweep binds from the **claimed reminder row's** org. The request-plane caller (the creator's context, own org) is behaviourally unchanged, and the resolution semantics (specific row, then `'*'`, then default enabled) are untouched. Migration 0064 also adds the sweep's claim path, `public.claim_due_task_reminders(int)`: a SECURITY DEFINER cross-org claim over `task_reminders` (FOR UPDATE SKIP LOCKED + atomic `is_sent` flip) in the `scheduler_tick_claim` pattern — it takes no org/person parameter, so there is no caller-supplied identity to assert; EXECUTE is granted to `app_user` only and its sole caller is the worker loop.

### PART 3A — `notifications_insert` / `notifications_recipient_exists`: the context-kind assertion (F-11-02)

These two are called from **two** context kinds, and the plain assertion breaks one of them — Wave A stopped on this and the resolution below was taken as a Lead decision rather than silently weakening the contract:

- **Person context present** (`authz.person_id()` is not null): `p_org_id` must equal `authz.org_id()` — the 0044 idiom. A mismatched `app.org_id` claim makes `org_id()` NULL under 0003's deny-only rule, so a bad claim refuses here too.
- **Person-less context** (the worker plane's system actor): `p_org_id` must equal the `app.org_id` claim the transaction carries. That is not caller trust: `buildJobAuthorization` (`src/lib/jobs/worker.ts`) binds the claim to the **job row's** org, and the handler passes the same job row's org as `p_org_id` — a foreign-org context cannot satisfy it, and an absent claim refuses.

The insert's `person_org` guard trigger remains the second layer: it enforces the recipient's org at write time whatever the assertion saw. Both functions keep 0052's signatures, defaults and return shapes; the only change is the prepended assertion (and `recipient_exists` moving from `language sql` to `plpgsql` so it can raise).

**Deliberate non-change:** `record_login_event` got **no** assertion. It is pre-auth by design and has no context org to assert against. Its mitigations stand (event-type allowlist, append-only table, server-only call sites); the residual — a compromised app context could forge login-event rows — is accepted at Low because the table is evidence, not authority (§5).

### PART 4 — Identity-freeze triggers (F-11-03, F-11-13)

The 0056 mechanism verbatim: a BEFORE UPDATE trigger raising SQLSTATE **23514** when a frozen column changes (RLS policies cannot reference OLD, so the freeze cannot live in a policy). Exactly the identity set is frozen; the migration comment names the admitted writers per table, from a sweep of every `UPDATE` in `drizzle/` and `src/`:

| Table | Frozen columns | Admitted writers (their set stays mutable) |
|---|---|---|
| `jobs` | `id`, `org_id`, `type`, `enqueued_by`, `dedup_key`, `payload`, `created_at` | Worker definers (`jobs_claim_next`, `jobs_start/complete/fail/heartbeat`, `jobs_sweep_retryable`, `jobs_reap_stale`, `jobs_release_claim`, `jobs_apply_backoff`) and the `src/lib/jobs/` service writers set only `status`, `attempts`, `next_run_at`, `claimed_by`, `claimed_at`, `heartbeat_at`, error fields, `updated_at` |
| `schedules` | `id`, `org_id`, `created_by`, `created_at` | `scheduler_tick_fire` (run stamps) and `scheduler.ts` pause/resume (`is_active`, `next_run_at`). `workflow_id` stays mutable by contract — re-pointing a schedule is a product edit |
| `workflows` | `id`, `org_id`, `created_by`, `created_at` | `workflows/service.ts` (definition, `version`, `status`, `updated_by`) and soft-delete |
| `ai_usage_requests` | `id`, `org_id`, `person_id`, `capability`, `created_at` | The finalize path only (`usage.ts`): `status`, token counts, `provider_attempts`, `tool_calls_count`, `duration_ms`, error fields |

`jobs.payload` was the contract's conditional freeze (§4.2: freeze only if no legitimate writer rewrites it). The sweep found none — payloads are enqueue-time facts — so payload **is** frozen, with the sweep recorded as the evidence in the migration comment. Since 0048 a `workflow_run` job executes **as** its `enqueued_by`; freezing `enqueued_by` + `payload` + `type` closes the execution-authority forgery F-11-03 names.

### PART 5 — `enqueue_password_reset_email`: the pre-auth enqueue (F-11-06)

The narrow exception that lets the forgot-password flow enqueue an email job (§3.6). Shape, on the `scheduler_tick_fire` pattern:

- **The reset id is the capability.** A row that is used or expired (0024's own predicates) enqueues nothing and returns `null`.
- **Org and recipient are derived, never parameters** — the org from the `people` row the reset names (`people.auth_user_id`), the recipient email from `auth.auth_users`. Only `p_subject` / `p_html` are caller-supplied, because only the caller knows the plaintext token the html carries (the database stores its digest).
- **Idempotent**: dedup key `pwreset:<reset id>` plus the `jobs_org_dedup_uidx` partial unique index — one job per issued token; a raced duplicate returns the existing job's id.
- `enqueued_by` stays NULL — a system-enqueued job, like the scheduler's; `email` jobs never resolve an execution principal.

### PART 6 — Verification

DO blocks assert the five redeclared definers carry their assertions, the four freeze triggers exist, and the PART 5 definer exists with `prosecdef` and the `app_user` grant — the migration fails rather than half-apply.

---

## 3. The findings register, as shipped

### 3.1 F-11-01 (Medium) — AI definers trusted caller-supplied ids · **Fixed, 0061 PARTS 1–2**

`ai_effective_limits` / `ai_usage_counters` (0054) accepted any org/person id from any `app_user` context; any authenticated context could read any org's AI limit configuration and usage aggregates, including a named person's per-minute cadence. Both now assert against the transaction context (§2). Regression: `tests/db/definer-context.test.ts` — foreign-org calls raise 42501, same-org calls return the pre-Phase-11 values, the `ai.usage.view` admin read still works.

### 3.2 F-11-02 (Low) — Notification definers trusted caller-supplied org · **Fixed, 0061 PARTS 3–3A**

The `notifications_insert` family accepted a caller-supplied org/person pair, bounded only by the `person_org` guard trigger (which blocks cross-org pairs, not same-org forgeries). The fix asserts by context kind (§2, PART 3A) because the family serves both the creator's person context and the person-less worker plane; `notification_channel_enabled`, whose caller is always a real person context, got the plain assertion (PART 3). The guard trigger remains as the second layer. `record_login_event` is dispositioned, not fixed (§2, PART 3A). Regression: `tests/db/definer-context.test.ts` (foreign-org insert raises; the worker-shaped context still inserts).

### 3.3 F-11-03 (Medium) — Identity columns unfrozen on `jobs` / `schedules` / `workflows` · **Fixed, 0061 PART 4**

RLS UPDATE policies pinned only `org_id`; `type`, `payload`, `enqueued_by`, `dedup_key` on jobs and `created_by` on schedules/workflows were rewritable by any context the policy admitted — and since 0048 a job executes as its `enqueued_by`, a payload/enqueued_by rewrite was execution-authority forgery inside the tenant. All three tables now carry freeze triggers (§2). Regression: `tests/db/identity-freeze.test.ts` — direct UPDATEs of each frozen column raise 23514 (including from the retry-holding context the old policy admitted); the legitimate lifecycle, retry/cancel, schedule-edit and workflow-edit flows still pass.

### 3.4 F-11-04 (Medium) — Direct library sign-in bypassed lockout + recording · **Fixed at the choke point**

The per-account lockout and login-event recording lived only in the mediated route (`src/app/api/auth/login/route.ts`); Better Auth's own `POST /api/auth/sign-in/email`, mounted by the `[...all]` catch-all, skipped both — credential stuffing against one account was bounded only per-IP, and attempts left no trace in `public.login_events`. A comment in the client ("direct calls are a bug") was a convention, not a control.

Both controls now live in the hooks in `src/lib/auth/server.ts` — the one place every sign-in crosses, because the library dispatches `auth.api.*` calls and HTTP requests through the same hook pipeline:

- **Before-hook** (`/sign-in/email`): the lockout check runs before the credential check. A locked account is refused with an error **body-identical** to the library's invalid-credentials error (no oracle), the attempt records a `LOGIN_FAILURE` event, the refusal does **not** feed the failure counter (an active lockout is never extended by knocking), and a fixed 250 ms parity delay keeps the locked branch from answering faster than a wrong password.
- **After-hook**: records the outcome (success / failure / MFA challenge) exactly once. The mediated route **no longer records or lockout-checks anything itself** — it keeps body validation, the origin check, delegation via `auth.api.signInEmail`, response forwarding and the enrolment steer — so no path can double-record.

Lockout semantics are the mediated route's, unchanged (`login-lockout.ts`, migration 0027). The audit's Q2 is closed with evidence: the installed library (Better Auth **1.7.3**) dummy-hashes on the unknown-user branches — verified in its sign-in endpoint source — so ordinary failure timing needs no floor.

Regression: `tests/guards/auth-choke-point.test.ts` (structure and single-recording on both paths) and `tests/integration/auth-choke-point.test.ts` (a locked account refused via the raw library path; exactly one event per attempt on either path).

### 3.5 F-11-05 (Low) — Library reset endpoint unrefused; sign-out unrecorded · **Fixed**

**Path correction.** The audit named the library endpoint `/forget-password`. In the installed Better Auth (1.7.3) the endpoint lives at **`/request-password-reset`**; `/forget-password` is the legacy spelling the library no longer routes (it survives only in its rate-limiter's path list). The before-hook refuses **both** with `FORBIDDEN` ("Password resets go through /api/auth/forgot-password. This endpoint is disabled.") — the live one because it must be, the legacy one so the refusal survives a future re-introduction. The endpoint was non-functional anyway (no `sendResetPassword` is configured), but it sat one config change away from becoming a live second reset flow bypassing app policy.

**Sign-out (Info sub-item).** A session deleted by the `/sign-out` endpoint is now recorded as `SESSION_REVOKED`. It cannot live in an after-hook — the endpoint deletes the row and returns only `{ success: true }` — so it is recorded from the session-delete **database hook**, discriminated by the endpoint context's path: revoke-session(s), two-factor teardown and expiry cleanup delete sessions too and are **not** recorded. It fires only when a session row actually existed.

### 3.6 F-11-06 (Medium) — Forgot-password timing oracle · **Fixed by decoupling**

`requestPasswordReset` awaited the Resend send on the exists-branch; the not-exists branch returned after one DB round-trip. The response shape was uniform; the timing was an account-existence oracle.

The send is now decoupled onto the Phase 10 email job plane. Both branches perform the same work — schema parse, one rate-limit round-trip, token generation, one token write — and the exists-branch additionally makes **one local enqueue round-trip** through `enqueue_password_reset_email` (0061 PART 5). **No branch awaits any external call**; the eliminated term was an awaited HTTPS round-trip (typically 100 ms+, highly variable) against ~1 ms local round-trips. Delivery failure handling is the queue's (retry / dead-letter); the user-facing contract ("request again") is unchanged, and the token row stays the source of truth. The email content comes from one shared builder (`buildResetEmailContent()`), so the job-delivered email is byte-identical to the one the admin credential-reset path still sends directly.

**Why a definer was necessary.** No existing surface can enqueue a job pre-auth: `enqueueJob` gates on `authz.has('jobs.create')`, which resolves only through a live person's roles, and the `jobs_insert` RLS policy requires the same. The reset flow has no person. PART 5 is the narrow, capability-shaped exception (§2). The audit's fixed-floor fallback was not needed: the jobs table lives in the same database this flow already depends on, so a down worker delays delivery rather than making the enqueue branchy.

Regression: `tests/guards/password-reset.test.ts` — with the mailer stubbed, both branches issue with zero awaited sends on the request path, and the email job exists for the exists case.

### 3.7 F-11-07 (Medium) — Password-policy parity gap · **Fixed, with one recorded observation**

Invitation accept — the product's primary account-creation path — and bootstrap setup enforced password **length only** server-side; the common-password and HIBP breach checks ran only on reset/change, so a known-breached password could be installed at account creation. Both paths now call the shared `validateNewPasswordPolicy` (length + common + breach) **before** hashing — accept runs it before the invitation preview, so a weak password is refused without the token being consulted — mapping its reasons onto each flow's existing error vocabulary (`PASSWORD_TOO_SHORT` / `TOO_LONG` / `TOO_COMMON` / `BREACHED`). Nothing was duplicated; reset and change already called the same function.

**Recorded observation (not actioned).** Under the current configuration the common-password half cannot fire on **any** flow: the list's longest entry is `password123` (11 characters) and the minimum length is 12 (`MIN_PASSWORD_LENGTH`, `src/lib/auth/server.ts`), and the policy checks length first. Parity is nevertheless real — one shared function, and the HIBP half does reject breached passwords of 12+ characters everywhere. Extending the common list with ≥12-character entries is a product/policy decision; it is recorded here, not taken by this phase.

Regression: `tests/auth/invitation-accept.test.ts` (DB-free: all four refusals land with zero DB and zero hash calls; a strong password flows through) and `tests/bootstrap/setup-route.test.ts` (common/breached refusals at service and route level; HIBP fetch stubbed — no network in tests).

### 3.8 F-11-08 (Low) — Inbound webhook ingress unthrottled · **Fixed**

`POST /api/integrations/inbound/[endpointKey]` had the 256 KB body cap and the capability key, but no rate limit — a leaked key, or key-spraying, was unthrottled and every attempt cost a database lookup. The route now throttles on the established substrate (`checkIpRateLimit` → `authz.check_rate_limit`, migration 0024), as named constants in the route module: **300/min per IP** first, then **60/min per endpoint** (bucket keyed by the endpoint key's SHA-256 digest — the raw key never appears in a bucket name). Both run before the size cap and before the body is read, so a flood costs two counter increments and nothing else. The over-limit answer is **429 with the generic rejection body verbatim** — the status is the only observable difference, so throttling cannot leak endpoint existence; the tripped bucket is logged server-side only. A limiter failure lands in the route's existing opaque-500 path and writes no receipt (fail-closed).

Regression: `tests/integrations/inbound-ratelimit.test.ts` (bucket keys, allowances, ordering, short-circuit) and case **I10** in `tests/integrations/security.test.ts` (the 61st delivery to one endpoint and the 301st sprayed key from one IP meet the 429).

### 3.9 F-11-09 (Low) — Search and audit-log export unthrottled · **Fixed**

The two most expensive authenticated reads gained per-user limits on the same substrate, checked as each handler's first statement: **search 120/min** (`GET /api/search` — far above any debounced human typeahead cadence) and **audit-log export 5/min** (far above any human report-pulling cadence). Buckets are keyed per person, so one user's scripting cannot starve another. Over-limit answers are 429 `{ error: 'RATE_LIMITED', message }` in each module's existing envelope; limiter exceptions propagate into `withPermission`'s opaque 500, the same fail-closed posture as every existing `check_rate_limit` call site.

### 3.10 F-11-10 (Low) — Origin verification on authenticated routes · **Already satisfied; now pinned**

**The audit's current-state claim was wrong, and this section corrects the record.** The audit (§2.8) reported that the ~70 authenticated API routes do not verify origin and that CSRF defence rested on `SameSite=Lax` alone. At the audited tree, `withPermission` (`src/lib/authz/http.ts`) already implemented the contracted check exactly: `originMatches()` compares the `Origin` header against `APP_URL` as URL origins, and state-changing methods (POST/PUT/PATCH/DELETE) are refused with 403 `FORBIDDEN` / `ORIGIN_MISMATCH` **before** `requirePermission` runs. Absent `Origin` passes (server-to-server, tests, the worker); malformed origins and the opaque `'null'` serialization fail closed; GET/HEAD are exempt. Every authenticated route is built with `withPermission`, so the whole surface had the check. The routes not using it are the seven pre-auth mediated routes — each carrying its **own** T-17 check — the deliberately ungated inbound webhook route (machine callers, Phase 10 contract), and the Better Auth surface (§3.4's territory).

Phase 11 changed **no production code** here. Its delta is the missing behavioural pin: `tests/guards/origin-verification.test.ts` — nine cases proving cross-origin state-changers are refused before authorization or the handler runs, and same-origin, absent-origin and safe-method traffic is admitted. F-11-10 is closed as *already satisfied + now behaviourally pinned*. The lesson is recorded for future audits: a wrapper-level control is invisible to a per-route sweep.

### 3.11 F-11-11 (Low) — Legacy workflow kept a project-creating Neon key · **File retired; secret removal is a human gate**

`.github/workflows/test-project-scope.yml` — a manual-dispatch leftover that POSTed to the Neon API to create a project, wiring `NEON_API_KEY` as an Actions secret — is deleted. A reference sweep found zero references to it anywhere else in the repo (no badges, docs or other workflows). Deleting the file is the phase's contracted half. **HG-4:** removing the `NEON_API_KEY` secret from the repository's Actions secrets is a repo-settings action only Nani can perform; it remains open after this phase, flagged here and in the Phase 13 human-gates list.

### 3.12 F-11-12 (Low) — Security headers · **Fixed, with `'unsafe-inline'` dispositioned**

`next.config.ts` gained:

- **`Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`** — the conservative set; it only denies capabilities the app never requests.
- **CSP `connect-src`** extended with `https://*.ingest.sentry.io`, `https://*.ingest.us.sentry.io`, `https://*.ingest.de.sentry.io`, so browser Sentry ingest actually works when a DSN is configured (with no DSN the SDK never loads and the hosts are inert). All pre-existing directives are unchanged.

**`'unsafe-inline'` is retained deliberately, and the config comment now records why**: removing it needs nonce-based CSP via middleware, which the app does not have and which touches every route's rendering path. It is a Phase 13 candidate (audit §6 Q3), not silently accepted — today's mitigations are React's escaping, no `dangerouslySetInnerHTML` anywhere in the sweep, and the workflow no-eval guard. Regression: the header set is pinned in `tests/guards/security-headers-ratelimit.test.ts`.

### 3.13 F-11-13 (Low) — `ai_usage_requests` metering columns unfrozen · **Fixed, 0061 PART 4**

The table's own-row UPDATE policy pinned identity via WITH CHECK but left `status` and the token counts writable — one generic-update bug away from falsified metering. The freeze trigger (§2) freezes the identity set including `capability` (the metering dimension) while the finalize path's set stays mutable.

### 3.14 F-11-14 (Info) — Dormant migration file · **Retired (plus one more)**

`drizzle/0051_reports_view_permission.sql` had no journal entry — a duplicate of the 0008 seed of `reports.view`, inert because the migrator is journal-driven (`scripts/migrate-ws.mjs` reads `drizzle/meta/_journal.json`), confusing in review. Deleted. The same sweep retired **`drizzle/0040_invitation_role_lookup.sql`**, a second dormant file the Phase 13 audit caught (F-13-08): byte-identical to the journaled `0041` (both 2,487 bytes, SHA-256 `9f4fa7cb…`), never applied for the same reason — had both ever been glob-applied, their duplicate `create function` would have errored.

### 3.15 P9-F1 (Low, carried from Phase 9) — Per-minute window counts `NOT_CONFIGURED` rows · **Disposition unchanged**

Phase 9's accepted finding: `ai_usage_counters`' per-minute window counts `NOT_CONFIGURED` rows while the monthly windows exclude them — fail-closed only (it can only make the per-minute limit stricter, never looser). 0061 PART 2 redeclares the function with the counting rules **unchanged**; the disposition stays as documented in `docs/phase9-ai-foundation.md` §3.2. Carried in this register so it is not silently dropped.

---

## 4. The conventions, stated once

Future phases inherit these; they are the patterns 0061 and the choke point establish.

1. **A definer that accepts an identity id asserts it, or derives it.** A SECURITY DEFINER taking an org/person id either asserts it against the transaction context (the 0044 idiom: compare with `authz.org_id()` / `authz.person_id()`, raise 42501) or derives the identity from a capability row it looks up itself (PART 5). Caller-supplied identity is never trusted as-is. Where two context kinds legitimately call the same function, assert **by context kind** (PART 3A) rather than weakening the assertion — and bind the person-less branch to something the caller cannot choose (the job row, via `buildJobAuthorization`).
2. **Identity freeze is a trigger, not a policy.** RLS policies cannot reference OLD, so column freezes live in BEFORE UPDATE triggers raising 23514 (the 0056 mechanism). Freeze exactly the identity set; name every admitted writer and its mutable set in the migration comment, from an actual sweep — the freeze list is only as honest as the sweep behind it.
3. **Auth controls live at the choke point, never only in a mediated route.** Anything the app enforces about sign-in — lockout, recording, refusals — belongs in the Better Auth hooks, the one pipeline both the mediated route and the library's own endpoints cross. A control that lives in a route is a control with a bypass (§3.4).
4. **No branch of a pre-login flow awaits work another branch skips.** If one branch of a pre-auth flow needs an external call, decouple it (a job, a queue) until both branches perform the same work — or pay a fixed floor on **all** branches, never a branch-specific delay (§3.6, §3.4's parity delay).
5. **Pre-auth writes go through narrow capability definers.** When a pre-auth flow must write into a person-gated plane (jobs, receipts), the door is a definer whose parameter is a capability (a live row id) and which derives every identity value from that row — the 0058/0059/0061 line of precedents.

---

## 5. Residual risks and deferred scope

- **`record_login_event` remains unasserted** (accepted, Low): pre-auth by design; a compromised app context could forge login-event rows. The table is evidence, not authority — nothing in the system grants or denies based on it. (§3.2)
- **CSP `'unsafe-inline'` for scripts** remains: an XSS anywhere in the app is not blunted by CSP script-src today. Mitigations and the Phase 13 candidacy are recorded in §3.12.
- **The common-password list cannot currently fire** (§3.7): its longest entry (11 chars) is below the 12-char minimum. The HIBP half covers breached passwords of valid length on every flow; extending the list is a product decision.
- **`schedules.workflow_id` stays mutable** by design (a product edit), as do `jobs.priority` / `max_attempts` (not identity; the contract does not freeze them).
- **The upgrade-path proof for 0061** (0059→…→0061 against a lived-in database) joins the post-Nov-1 verification slot, per the standing rule: until then, CI's from-empty full-suite run is the migration gate, and it is also the stronger proof for the fresh-install chain. The phase does not claim the upgrade proof.
- **HG-4** (§3.11): removing the legacy `NEON_API_KEY` Actions secret is Nani's settings action.
- **Deferred beyond V1** (audit-recorded, unchanged): nonce-based CSP (Phase 13 candidate), session-lifetime shortening (product decision; compensations in audit §6 Q6).

## 6. What did not change

- **Permissions:** none added, removed or re-granted. The catalogue remains **127 keys**; 0061 touches no permission rows, and `docs/architecture/security.md` §2 — the test-fixture matrix — is untouched, rows and counts alike.
- **Environment:** no new env vars. Origin checks reuse `APP_URL`; the reset decoupling reuses the email job plane and its existing provider configuration. `ENVIRONMENT.md` is unchanged.
- **Dependencies:** zero added; zero upgraded (the deferred majors in PRs #52/#54 are untouched). `pnpm audit --audit-level=high` exits 0 with the two previously documented ignores (`braces`, `sharp` CVE-2026-96889) unchanged.
- **Protected files:** `.github/workflows/ci.yml`, `scripts/ci/neon-local.mjs`, `scripts/migrate-ws.mjs` and `scripts/db/roles.sql` are untouched. The one guard-script change in the phase is comment/message text in `scripts/guards/workflow-secret-flow.mjs` (Wave E refreshed its stale pre-PR #66 rationale comments; the rule it enforces is unchanged).
