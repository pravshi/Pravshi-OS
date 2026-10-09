# Phase 10 — Integrations Platform

Developer and operator documentation for the Integrations module (`src/lib/integrations/*`, `/api/integrations/*`, Settings → Integrations). Phase 10 of Pravshi OS.

> Status: implemented. A code-level provider registry (email via Resend, generic webhooks), org-scoped connection records, a two-tier credential model (env-referenced + AES-256-GCM vault), outbound webhook subscriptions with fan-out from domain events, an inbound webhook receiver, a real email adapter behind the Phase 6 job queue, an executions read model, and the settings UI. Migrations `0056_integrations_schema`, `0057_integrations_permissions`, `0058_inbound_endpoint_key`, `0059_webhook_delivery_resolution`.
>
> This document tracks the implementation, not aspirations: every env var name, route path, permission key, header name, event key and error code below was verified against the landed source. Design authority: the Phase 10 master prompt and `phase10-architecture-audit.md` (contract section numbers in parentheses refer to it). Where the shipped code refined the contract, this document describes the code and §12 lists the refinement.

---

## 1. Architecture

### 1.1 The engines already existed; Phase 10 built the surface

Phase 10 is a surface-and-state phase, not an engine phase. The Phase 6 jobs platform (`src/lib/jobs/*`) already provided the durable Postgres queue, dedup idempotency, exponential backoff with jitter, dead-letter + manual replay, the scheduler, and a production-grade outbound webhook delivery handler with an SSRF guard and HMAC signing. What was missing — and what Phase 10 built — is org-scoped integration state (connections, subscriptions, deliveries, inbound events), a credential vault, the first real email adapter, and the APIs/UI that drive the engines.

```
Settings → Integrations page (server component)
  └─ gated by integrations.view (display) / integrations.manage (controls)
       ├─ GET  /api/integrations            provider catalogue + this org's connections
       ├─ …/connections, …/webhooks         lifecycle APIs (withPermission)
       └─ GET  /api/integrations/executions executions read model (§1.5)

Domain event raised (workflow run, deal stage change, task completion)
  └─ emitIntegrationEvent()                 src/lib/integrations/fanout.ts
       ├─ one integration_webhook_deliveries link row per active subscription
       └─ one `webhook` job per subscription → Phase 6 worker
            └─ handleWebhook()              secret resolved + decrypted INSIDE
                                            the worker (§5.3); SSRF-guarded,
                                            HMAC-signed delivery

External sender
  └─ POST /api/integrations/inbound/[endpointKey]   pre-auth; the key is the credential
       └─ receiveInbound()                  src/lib/integrations/inbound.ts
            ├─ org resolved ONLY from the endpoint key's SHA-256 digest
            ├─ receipt row first (integration_inbound_events)
            └─ dispatchWorkflowEvent(type: 'webhook') under the connection's
               connected_by principal

Workflow `send_email` action / system mail
  └─ `email` job → sendEmailViaProvider()   src/lib/jobs/handlers.ts
       └─ sendViaResend()                   src/lib/integrations/providers/email/send.ts
```

Delivery, email and any future sync run in the **separate job worker process** (`pnpm worker` → `src/lib/jobs/runner.ts`), not in the web process. If no worker is running, jobs sit queued — queued is a real state, not an error, and neither the APIs nor the UI promise instant delivery.

### 1.2 Module map — `src/lib/integrations/`

| File | Responsibility |
|---|---|
| `errors.ts` | The module's normalized error taxonomy (§11.2). One class (`IntegrationsError`), static messages; maps the vault error into the taxonomy (`fromVaultError`). |
| `http.ts` | Route plumbing: the §24 error envelope, `noStoreHeaders`, `integrationsFailureResponse` (taxonomy error → its status; ZodError → 400 `INVALID_REQUEST`; anything else propagates), `parseIntegrationId`. |
| `config.ts` | Credential-tier gating (§3.1): `resolveIntegrationsConfig()`, `canCreateConnection()`, `assertCanCreateConnection()`, `connectionGate()`. |
| `secrets.ts` | The Tier V vault (§3.2): AES-256-GCM envelope encrypt/decrypt/serialise/parse, `isVaultConfigured()`, redaction helpers (`maskIdentifier`, `scrubText`, `redactForLog`). |
| `providers/types.ts` | `IntegrationProviderDefinition` — the registry entry shape. Definitions carry **no behaviour**: no adapter, no fetch, no provider call. |
| `providers/index.ts` | `INTEGRATION_PROVIDERS` — the whole registry (two entries in V1), plus lookup helpers. |
| `providers/email.ts` | The `email` provider definition (Tier E, singleton). |
| `providers/webhooks.ts` | The `webhooks` provider definition (Tier V, singleton; inbound descriptor: `endpoint-token`, 256 KB cap). |
| `providers/email/send.ts` | The Resend adapter (§8): lazy SDK client, credential resolution, error normalisation. The one behaviour file under `providers/`. |
| `connections.ts` | Connections service: list/get/create/update/disconnect/rotate-secret/health + the internal `resolveConnectionCredential()` (the module's one plaintext exit). Config hygiene (credential-key scan + provider schema). |
| `subscriptions.ts` | Webhook subscriptions service: list/get/create/update/delete/rotate-secret. Generates signing secrets, stores only vault envelopes. |
| `fanout.ts` | Outbound fan-out: the event catalogue (§5.2), the delivery envelope, dedup keys, `emitIntegrationEvent()` (never throws) and `deliverToSubscription()` (shared with the workflow `webhook` action). |
| `inbound.ts` | Inbound receiver: endpoint-key issuance/rotation, the pre-auth receipt pipeline (`receiveInbound()`), verification, dedup decisions, workflow dispatch. |
| `executions.ts` | The executions read model (§1.5): jobs ∪ inbound events merged into one chronological page. |

API + UI: `src/app/api/integrations/**` (§4); `src/app/(app)/settings/integrations/page.tsx`; `src/components/integrations/*` (`IntegrationsManager`, `ConnectionsSection`, `SubscriptionsSection`, `ExecutionsSection`, `OneTimeSecret`, `integrations-client.ts`, `can-use-integrations.ts`).

### 1.3 Data model — migrations `0056`–`0059`

Provider definitions are **code** (the registry, §2) — there is deliberately **no providers table**; the database holds org state only. All five tables are org-scoped with RLS enabled and forced.

**`public.integration_connections`** (0056; `inbound_endpoint_key_hash` added by 0058) — one org's connection to one provider: `provider_key` (text; must exist in the registry — enforced in the service, not a FK), `display_name`, `status` (`CONNECTED | DISCONNECTED | ERROR | NOT_CONFIGURED`), `config` jsonb (**non-secret** configuration only), the credential columns (§3: `credential_ciphertext`, `credential_nonce`, `credential_key_version`, `credential_ref`), `inbound_endpoint_key_hash` (SHA-256 hex digest of the inbound endpoint key; NULL = none issued), `connected_by`, `last_health_at`, `last_error_code`, timestamps.

**`public.integration_webhook_subscriptions`** (0056) — outbound subscriptions: `url`, `events` (text array of catalogue keys, §5.2), `active` boolean (disabling = `active = false`, recoverable; deletion is a separate hard action), `signing_secret_ciphertext` / `signing_secret_nonce` / `signing_secret_key_version` (the serialised vault envelope lives in the ciphertext column; §3.2), `created_by`, timestamps.

**`public.integration_webhook_deliveries`** (0056) — the queryable link between a subscription and the job that delivered it: `subscription_id`, `job_id`, `event_key`, `created_at`. Append-only. Jobs remain the system of record for attempts and retries; this table exists because `jobs.payload` is not indexable per subscription. The FK to subscriptions has no `ON DELETE` action — a subscription with delivery history cannot be deleted (§9.2).

**`public.integration_inbound_events`** (0056) — inbound receipt + processing record: `connection_id`, `provider_key`, `endpoint_key` (the endpoint key's **hash**, never the token), `external_event_id` (nullable), `payload_hash` (SHA-256 of the raw body — **the body itself is never stored**), `status` (`RECEIVED | PROCESSED | REJECTED_SIGNATURE | REJECTED_VALIDATION | DUPLICATE | FAILED`), `received_at`, `processed_at`. Idempotency: a partial UNIQUE index on `(connection_id, external_event_id) WHERE external_event_id IS NOT NULL`, plus the payload-hash dedup window in the service (§7.3).

**`public.integration_sync_checkpoints`** (0056) — schema only in V1: `connection_id`, `resource`, opaque `cursor`, `last_synced_at`, `status`. The sync engine is deferred (§12); landing the table now avoids a second schema migration when the first sync provider is confirmed. No service writes it in V1.

**Migrations 0058/0059 add no tables** — they install the three narrow SECURITY DEFINER read functions the security model needs (§10.2) and the endpoint-key digest column. **Migration 0060 adds no tables either** — it completes the write plane: the DELETE privilege for `app_user` on the five tables (§10.1) and the two narrow SECURITY DEFINER write functions for inbound receipts (§10.2).

### 1.4 Permissions (migration `0057_integrations_permissions`)

Catalogue 126 → **127**, module `integrations`, neither marked sensitive:

| Key | Purpose | Grants |
|---|---|---|
| `integrations.view` | List providers/connections/subscriptions, view execution history and health | SUPER_ADMIN + ADMIN, GLOBAL |
| `integrations.manage` | Connect/disconnect/revoke, edit config, rotate secrets, manage subscriptions, issue inbound endpoint keys | SUPER_ADMIN + ADMIN, GLOBAL |

Only one of the two keys is new. `integrations.manage` pre-existed as an ungranted blueprint row seeded by migration 0008 under module `settings` ("Configure integrations", granted to no role); 0057's catalogue seed is an upsert that re-homes that row to module `integrations` with the description above, so the catalogue grows by exactly one key. Both keys are newly *granted* by 0057.

There is deliberately **no `integrations.use`** broad grant: connections are an operational surface holding org-wide credentials, and no non-admin workflow needs to touch one. SUPER_ADMIN's grants also arrive via the whole-catalogue cross join in `seed_system_roles()`; existing orgs were backfilled with the 0045 defensive pattern. The printed matrix in `docs/architecture/security.md` §2 gained the two rows in the same change set (the Phase 9 lesson).

### 1.5 Executions read model

There is **no executions table**. `GET /api/integrations/executions` (`integrations.view`) merges two existing stores into one chronological page (newest first):

- **Outbound** — the org's Phase 6 `jobs` rows of type `webhook` / `email`, enriched through `integration_webhook_deliveries` (event key, subscription, target URL). Deployment-level webhook jobs from before Phase 10 have no link row and surface with a null event key.
- **Inbound** — `integration_inbound_events` rows with their receipt status.

Each row carries `kind` (`webhook_delivery | email | inbound_event`), the source's own `status` vocabulary untranslated, `errorCode`/`attempts` for jobs, and `jobId` where one exists. **Retry is not re-implemented**: rows carry their job id and retry stays on the existing `POST /api/jobs/[id]/retry` surface. Inbound receipts are not retryable jobs (a sender redelivery is their recovery path, §7.3).

Visibility note: each source keeps its own RLS SELECT policy (jobs rows require `jobs.view`; deliveries/inbound rows require `integrations.view`). In V1 the `integrations.view` holders (SUPER_ADMIN/ADMIN) also hold `jobs.view`, so the merge is complete for every caller the route admits; if a future grant splits the two, job rows fail closed (absent), never leak.

### 1.6 Frontend

Settings → Integrations (`src/app/(app)/settings/integrations/`) is gated by `requirePagePermission('integrations.view')`; `integrations.manage` is computed server-side as a display flag only — hiding a control is never the authorization, the APIs enforce independently. The page renders three sections — connections (provider list with per-org status and health, connect/configure forms), subscriptions (URL, events, active toggle, rotate-secret), and executions (§1.5).

- Secret fields are **write-only**: password inputs, never repopulated. One-time secrets (a new subscription signing secret, an inbound endpoint key) are shown exactly once via the `OneTimeSecret` component and never stored client-side.
- Not-configured states are first-class: the catalogue response carries `vaultConfigured` so the page renders the Tier V not-configured state without a second round-trip; the email provider's unconfigured state is shown the same way.
- Desktop-first; no nav restructure — Integrations appears under Settings.

---

## 2. The provider registry

### 2.1 Registry shape

The registry is the single source of truth for which providers exist: `INTEGRATION_PROVIDERS` in `src/lib/integrations/providers/index.ts`. Each entry (`IntegrationProviderDefinition`, `providers/types.ts`) declares:

| Field | Meaning |
|---|---|
| `key` | Stable registry key; stored as `integration_connections.provider_key`. The record key in the registry MUST equal it (unit-pinned — a drift would orphan rows). |
| `displayName` / `description` | Catalogue display text (serialised by `GET /api/integrations`). |
| `singleton` | True when an org may hold at most one connection to this provider. Enforced in the service (second create → `CONFLICT`) — deliberately not a database constraint. |
| `credentialTier` | `'env'` (Tier E) or `'vault'` (Tier V) — §3.1. |
| `credentialRefEnvVar` | Tier E only: the one deployment env var name a connection's `credential_ref` may hold. Fixed per provider, never free text, so a connection can never point its ref at an unrelated secret. Null for Tier V. |
| `configSchema` | Zod schema for the **non-secret** `config` jsonb. Must be a strict object schema; the service additionally scans config for credential-shaped keys before and after parsing (§10.4). |
| `defaultConfig` | The config a connection starts with when the caller supplies none; must parse under `configSchema` (unit-pinned). |
| `capabilities` | Any of `email`, `webhooks_outbound`, `webhooks_inbound`. |
| `healthCheck` | Descriptor: `kind: 'none' | 'config' | 'live'` plus a description. The service records outcomes on the connection row (`last_health_at`, `last_error_code`). |
| `inbound` | `null` = no inbound for this provider in V1. Otherwise `{ verification: 'hmac-sha256' | 'endpoint-token', maxBodyBytes }` — the body cap is enforced **before** parsing. |

A definition carries **no behaviour**. Adapters live outside the registry and consume the definitions (email: `providers/email/send.ts`; webhooks: `subscriptions.ts`, `fanout.ts`, `inbound.ts` and the jobs handler).

### 2.2 The V1 providers

| Key | Tier | Singleton | Capabilities | Config (non-secret) | Inbound |
|---|---|---|---|---|---|
| `email` | E (`credential_ref` = `EMAIL_PROVIDER_API_KEY`) | yes | `email` | `fromAddress` (email), `fromName`, `replyTo` — all optional | none (`inbound: null`) |
| `webhooks` | V | yes | `webhooks_outbound`, `webhooks_inbound` | `outboundEnabled`, `inboundEnabled` (both default `true`) | `endpoint-token`, 256 KB cap |

Both providers are singletons in V1: an org has one sending identity and one webhooks enablement record (subscriptions and inbound endpoints are their own tables hanging off it).

**Honest wiring note (email config):** the `email` connection's config accepts `fromAddress` / `fromName` / `replyTo` and the settings UI captures them, but the V1 job send path composes the sender from the deployment's `EMAIL_FROM` only. `sendViaResend` accepts a per-send `from` override, but nothing passes one yet — changing the connection's `fromAddress` does **not** change sent mail in V1 (§12).

### 2.3 Adding a provider

1. **Definition** — create `src/lib/integrations/providers/<key>.ts` exporting an `IntegrationProviderDefinition` (use `email.ts` / `webhooks.ts` as the shape). Choose the tier honestly: a credential the deployment owns → Tier E with a fixed `credentialRefEnvVar`; a credential an admin pastes per org → Tier V.
2. **Register** — add the entry to `INTEGRATION_PROVIDERS` in `providers/index.ts`. The record key must equal `definition.key`.
3. **Env (Tier E only)** — declare the new env var name in `src/env.ts` and list it, commented with a placeholder, in `.env.example`. Names only — never a real value in either file.
4. **Config schema** — a strict zod object over non-secret fields only, plus a `defaultConfig` that parses under it.
5. **Adapter** — behaviour goes in its own module (the `providers/email/send.ts` precedent if it is a send path), never inside the definition. Provider failures must be normalised into platform error codes with static messages — provider response text never enters an error, a log line or an audit entry (§3.4).
6. **Inbound (optional)** — declare the descriptor (`verification` mode + `maxBodyBytes`). No signature support ⇒ no inbound: a provider that cannot be verified declares `inbound: null`. The `hmac-sha256` verifier mode is implemented in `inbound.ts` (`verifyInboundRequest`) although no V1 registry entry uses it, so an HMAC provider slots in without a new verification path.
7. **Tests** — the registry integrity unit suite (`tests/integrations/connections-unit.test.ts`) pins key equality, the tier vocabulary and `defaultConfig` parsing for every entry automatically; add adapter unit tests (mocked SDK/fetch) and, for credential or webhook behaviour, cases in `tests/integrations/security.test.ts`.

No migration is needed and no table changes: connections reference the key as text and the service enforces that it exists in the registry.

---

## 3. Credential storage

### 3.1 Two tiers

**Tier E — env-referenced (deployment-level).** The credential lives in the deployment environment; the connection row stores only `credential_ref` — the *name* of the env var (for `email`, always `EMAIL_PROVIDER_API_KEY`; the service rejects any other ref). The adapter reads the value from the parsed env at send time. Zero new storage risk. The API exposes the ref only masked (`maskedCredentialRef`, last 4 of the name).

**Tier V — vault (org-entered).** A credential an admin pastes in the UI is encrypted with AES-256-GCM (`node:crypto` — no new dependency, and no KMS exists in this infrastructure) and stored as an envelope. Per-subscription signing secrets and the webhooks connection secret use this tier.

The tiers are mutually exclusive per connection, enforced in the service: a pasted secret on a Tier E create/rotate is `VALIDATION`, and so is a ref on a Tier V one.

### 3.2 The vault envelope

Implemented in `src/lib/integrations/secrets.ts`. The key is `INTEGRATIONS_ENCRYPTION_KEY` — base64, exactly 32 bytes — read **only** through `src/env.ts` (which validates the shape at boot: base64 alphabet decoding to exactly 32 bytes).

```
VaultEnvelope { keyVersion, nonce, ciphertext, tag }
  keyVersion  integer — V1: always 1 (CURRENT_KEY_VERSION)
  nonce       base64, 12 bytes, fresh per encryption
  ciphertext  base64, AES-256-GCM ciphertext
  tag         base64, 16-byte GCM authentication tag

Serialised form:  intg.v<keyVersion>.<base64 nonce>.<base64 ciphertext>.<base64 tag>
```

Storage mapping: the **serialised envelope is the unit stored** in the `credential_ciphertext` / `signing_secret_ciphertext` column (so the GCM tag can never be separated from its ciphertext — the schema has no tag column); the nonce and key version are additionally duplicated into `credential_nonce` / `credential_key_version` (resp. `signing_secret_nonce` / `signing_secret_key_version`) for auditability. Decryption re-reads all four parts from the envelope itself.

Setup:

```bash
# Generate the deployment key (operator machine / secret store — never commit the value):
openssl rand -base64 32
# Then set INTEGRATIONS_ENCRYPTION_KEY in the deployment environment.
```

**Key-version reality (V1):** exactly one key version exists. The version segment makes envelopes auditable and lets a future keyring extend the format without a migration, but V1 has no dual-key decrypt: an envelope of any version other than 1 fails with `VAULT_UNSUPPORTED_KEY_VERSION`, and decrypting version-1 envelopes under a *different* key fails with `VAULT_DECRYPT_FAILED`. Changing the key therefore orphans existing Tier V ciphertext — see the runbook in §9.4 before rotating it.

### 3.3 NOT_CONFIGURED behaviour

When `INTEGRATIONS_ENCRYPTION_KEY` is unset (or does not decode to 32 bytes), the vault is **not configured** — a typed, first-class state, never a crash and never a fake success:

- The app boots and runs normally; every Tier E feature works.
- Creating a Tier V connection **with** a secret fails `503 NOT_CONFIGURED`. Creating one **without** a secret succeeds (the webhooks connection needs no secret to exist; its status is `NOT_CONFIGURED` until a credential is present).
- Creating or rotating a **subscription** fails `503 NOT_CONFIGURED` — a subscription cannot exist without somewhere safe to keep its generated signing secret, so both fail before any row is written.
- At delivery time, a subscription secret that cannot be decrypted (key unset, wrong key, tampered envelope) makes the webhook job fail as a non-retryable config error — the worker **refuses to send unsigned** (§5.3).
- The settings UI renders the dedicated not-configured state (the catalogue response carries `vaultConfigured`).

The email path has the parallel behaviour for its own configuration (§8.3).

### 3.4 Redaction rules (binding on the whole module)

- Secrets, ciphertext and nonce never appear in API responses, logs, audit metadata or error messages. Every error message in the module is static text; the taxonomy may append a field path or a provider key, never a value.
- API responses expose only `hasCredential: boolean` plus a masked identifier (last 4 of a **non-secret** id such as the env var name — never of the secret itself).
- Plaintext exists only inside the provider call. `resolveConnectionCredential()` (connections service) is the module's one plaintext exit; subscription secrets are decrypted only inside the worker (§5.3). Secrets never ride in `jobs.payload` (§5.3) and never pass through a request body twice: create/rotate request bodies carry a secret once, and responses never echo it.
- `secrets.ts` provides `scrubText` / `redactForLog` for log-bound values; the audit writer additionally strips credential-shaped keys as a backstop (defence in depth, not a substitute for never passing secrets in).

---

## 4. API routes

All routes are org-scoped to the caller, return `Cache-Control: no-store`, and answer with the §24 envelope (`{ error: { code, message, requestId? } }`). Authenticated routes use `withPermission(...)`; permission enforcement is server-side — the UI's display gating is never the authorization. Cross-tenant ids answer `404 NOT_FOUND` (existence never leaks).

| Route | Method(s) | Permission | Notes |
|---|---|---|---|
| `/api/integrations` | GET | `integrations.view` | Provider catalogue (registry, projected field-by-field — the zod config schema never serialises) merged with this org's connections, plus `vaultConfigured` |
| `/api/integrations/connections` | POST | `integrations.manage` | Create/configure. A Tier V body carries the secret once; the response never echoes it. Singleton second create → `409 CONFLICT` |
| `/api/integrations/connections/[id]` | GET | `integrations.view` | Safe DTO only (`hasCredential`, masked ref) |
| `/api/integrations/connections/[id]` | PATCH | `integrations.manage` | Display name / config (shallow-merged, then validated whole) / status. Identity columns are immutable (§10.3). A status change into `DISCONNECTED` destroys the credential, like DELETE |
| `/api/integrations/connections/[id]` | DELETE | `integrations.manage` | Disconnect = destroy the credential first, then delete the row (§9.5) |
| `/api/integrations/connections/[id]/rotate-secret` | POST | `integrations.manage` | Tier V: supply the replacement secret. Tier E: ref swap (must equal the provider's fixed env var). Audited at HIGH severity |
| `/api/integrations/connections/[id]/inbound-endpoint` | POST | `integrations.manage` | Issue **or rotate** the inbound endpoint key (§7.1, §9.3). Returns the plaintext key + full `inboundUrl` exactly once; takes no input body |
| `/api/integrations/webhooks` | GET, POST | view / manage | Subscription list/create. Create generates the signing secret and returns it **once** in the response. URL is static-SSRF-checked at write time (fail-fast only, §10.2) |
| `/api/integrations/webhooks/[id]` | PATCH, DELETE | `integrations.manage` | Update URL/events/`active`; delete. Delete of a subscription with delivery history → `409 CONFLICT` (disable instead, §9.2) |
| `/api/integrations/webhooks/[id]/rotate-secret` | POST | `integrations.manage` | New signing secret generated server-side, returned **once**, stored encrypted (§9.2) |
| `/api/integrations/executions` | GET | `integrations.view` | The §1.5 read model; filters: `kind`, `status`, `limit`, `offset` |
| `/api/integrations/inbound/[endpointKey]` | POST | **pre-auth** | The one new `PRE_AUTH_ROUTES` entry. The endpoint key is the credential (§7) |

Error taxonomy for these routes: §11.2.

---

## 5. Outbound webhooks

### 5.1 Subscriptions

A subscription (`integration_webhook_subscriptions`) names a target `url`, a non-empty list of subscribed event keys (§5.2), and an `active` flag. On create, the server generates a 256-bit signing secret, returns it to the admin **exactly once**, and stores only its vault envelope. Subscriptions require the vault (§3.3).

Two independent kill switches exist above the per-subscription `active` flag: the org's `webhooks` connection config carries `outboundEnabled` — when a visible connection explicitly sets it `false`, fan-out pauses for the whole org — and disconnecting the connection is the hard stop.

### 5.2 Event catalogue (V1)

Fixed in `fanout.ts` (`INTEGRATION_EVENT_KEYS`) against emission points that actually exist; fan-out hooks those points:

| Event key | Emission point | Meaning |
|---|---|---|
| `workflow.completed` | `src/lib/workflows/engine.ts` | A workflow run finishes SUCCEEDED |
| `workflow.failed` | `src/lib/workflows/engine.ts` | A workflow run finishes FAILED |
| `deal.won` | `src/lib/crm/deals.ts` (`updateDeal`), `src/lib/crm/pipelines.ts` (`moveDealToStage`) | A deal moves into a stage whose `is_won` flag is set (decided by the stage flag, never the stage name) |
| `deal.lost` | same points | A deal moves into a stage whose `is_lost` flag is set |
| `task.completed` | `src/lib/work/tasks.ts` (`updateTask`, `moveTask`) | A task's status becomes `done` |

A subscription's event list is validated against this catalogue at write time — empty lists, duplicates and unknown keys are `400 VALIDATION`, because a subscription to an event that can never fire is a configuration error, not a runtime state.

### 5.3 Fan-out and delivery

`emitIntegrationEvent()` runs **under the Authorization that raised the event** — no synthetic actor, no privilege escalation (the Phase 8 platform doctrine). Subscription discovery is governed by the caller's own visibility, and job creation by the queue's `jobs.create` gate: a raising context that cannot see subscriptions fans out to nothing (fail-closed, visible in the returned counts) rather than silently escalating. It **never throws**: a webhook fault must not break the originating mutation; per-subscription failures are counted and logged with ids only — never the event body, a URL query string, or any credential material.

For each matched active subscription, fan-out writes one `integration_webhook_deliveries` link row and enqueues one Phase 6 `webhook` job whose payload carries **ids + URL + the event envelope body only** — `{ subscriptionId, deliveryId, url, body }`. The dedup key is deterministic per (event, subscription, event instance) — `wh:<eventKey>:<subscriptionId>:<eventInstanceId>` (SHA-256-folded if it would exceed the queue's 256-char cap) — so re-emitting the same event instance returns the existing job instead of double-sending.

Delivery itself is the Phase 6 handler, with one Phase 10 change: for a payload carrying `subscriptionId`, the worker resolves the subscription's signing secret **inside the worker** — via the 0059 definer (§10.2) — and decrypts it there. The secret never rides in `jobs.payload` (operators can read payloads) and is never logged. Two consequences:

- A subscription disabled after enqueue drops the delivery: the job succeeds and nothing is sent.
- A secret that cannot be resolved/decrypted fails the job as a **non-retryable** config error. Unsigned delivery is never an option.

The handler's delivery posture (unchanged Phase 6 machinery): full SSRF guard (§10.2), 10 s default timeout (payload-overridable 1–30 s), 1 MiB response cap, at most 2 redirects with every hop re-validated (301/302/303 downgrade to GET and drop the signature; 307/308 preserve method + body). Outcomes feed the queue's retry classifier: 2xx success; 4xx non-retryable; 5xx/transport retryable with backoff, then dead-letter with manual replay from the jobs surface.

### 5.4 Signing (what receivers get)

Every webhook delivery attempt carries:

| Header | Value |
|---|---|
| `x-pravshi-signature` | `sha256=<hex>` — HMAC-SHA256 over the **raw request body**, keyed with the subscription's signing secret. Sent only when a secret is configured (always, for org subscriptions). |
| `x-pravshi-timestamp` | Unix seconds when **this attempt** was sent. Routing metadata for the receiver's replay window — it is **not** covered by the signature (see §6.2 for what that means). |
| `x-pravshi-webhook-id` | The job id — per-attempt correlation (changes across retries of the same delivery). |

The stable per-delivery identifier is the envelope body's `id` (§6.1), not the job id.

### 5.5 The workflow `webhook` action

Phase 10 also enables the workflow engine's previously deferred `webhook` **action** (only `run_ai_action` remains deferred). Its params take exactly one target:

- `subscriptionId` — send to one of the org's subscriptions through `deliverToSubscription()` (event key recorded as `workflow.action`; a disabled subscription fails the step). The subscription's vault secret signs, resolved in the worker as in §5.3.
- `url` (+ optional `signatureSecretRef`) — a deployment-level delivery: enqueues a plain `webhook` job signed with the env-referenced secret `WEBHOOK_SIGNING_SECRET_<REF>` (the Phase 6 pattern; an unconfigured ref refuses to send unsigned). `signatureSecretRef` is accepted in URL mode only.

Execution runs under the trigger actor's authority, like the Phase 8 `send_email` executor.

---

## 6. Webhook receiver guide

For anyone implementing an endpoint that receives Pravshi OS deliveries.

### 6.1 The envelope

The HTTP body of every fan-out delivery is one JSON object:

```json
{
  "id": "<delivery id, uuid>",
  "type": "deal.won",
  "created_at": "2026-10-09T12:00:00.000Z",
  "org_id": "<org uuid>",
  "data": { }
}
```

- `id` — **your dedup key**. It is the delivery row's id: stable across every retry of the same delivery, unique per (event, subscription, event instance).
- `type` — one of the §5.2 event keys (or an arbitrary body for a workflow `webhook` action send — action sends deliver the action's configured body, not this envelope).
- `created_at` — emission time (ISO-8601), not the attempt time; the attempt time is the `x-pravshi-timestamp` header.
- `data` — event-specific payload. Treat unknown fields as ignorable; the shape grows additively.

### 6.2 Verifying a delivery

1. Read the **raw** body bytes. Do not parse-then-reserialize JSON before verifying — any whitespace or key-order change breaks the HMAC.
2. Take the `x-pravshi-signature` header value, strip the `sha256=` prefix, and compute `HMAC-SHA256(raw body, your subscription signing secret)` as hex. Compare in constant time (e.g. `crypto.timingSafeEqual` over the decoded digests). A match authenticates the delivery.
3. Check `x-pravshi-timestamp` (unix seconds) against your clock and reject attempts outside your replay window — **±5 minutes is the recommended tolerance**. Understand what this does and doesn't prove: the timestamp is *not* covered by the signature (a deliberate compatibility choice — the signature covers the body only, exactly as the pre-Phase-10 env-ref deliveries verified). The window therefore bounds the usefulness of a captured delivery, and step 4 is what actually stops replays.
4. **Dedup on the envelope `id`.** Record processed ids and acknowledge repeats without reprocessing. A legitimately retried delivery re-sends the same body, the same `id`, and a fresh timestamp — id-based dedup, not the timestamp, is the replay defence.
5. Answer **2xx** to acknowledge. Any other status is a delivery failure: 4xx is treated as permanent (no retry), 5xx is retried with exponential backoff until the job dead-letters. Answer fast and process asynchronously — the sender's timeout is 10 s by default (max 30 s), and its response cap is 1 MiB.

Keep your signing secret out of source control and logs. When an admin rotates it (§9.2), the old secret stops verifying the moment the rotation commits — receivers must be given the new secret *before* rotation, or deliveries in between will fail verification at your side and be signed with a secret you don't hold at the sender's side.

### 6.3 What the sender will and won't do

- It will never send to a private, loopback, link-local or metadata address, even via redirect (§10.2). Your endpoint must be publicly resolvable.
- It signs every org-subscription delivery. An unsigned Pravshi delivery is either a deployment-level send whose ref was never configured — which the sender refuses to make — or not from Pravshi.
- It never includes credentials, internal record content beyond the event's `data`, or other tenants' data; `org_id` identifies the owning org.

---

## 7. Inbound webhooks

### 7.1 Endpoint keys

Inbound endpoints are per-connection. An admin (`integrations.manage`) issues a key via `POST /api/integrations/connections/[id]/inbound-endpoint`, which returns the plaintext key **exactly once**, together with the full URL:

```
POST {APP_URL origin}/api/integrations/inbound/<endpointKey>
```

The key is a 256-bit random token (base64url, 43 chars). Only its SHA-256 hex digest is stored (`integration_connections.inbound_endpoint_key_hash`, 0058; a partial UNIQUE index makes one digest name at most one connection across all orgs). The plaintext never reaches the database, a log, or an audit entry. **The key is the credential** — treat the URL as a secret. Issuing again rotates: the digest is overwritten and the old URL stops resolving immediately (§9.3). Only providers whose registry entry declares inbound support (in V1: `webhooks`) can hold a key.

### 7.2 The receipt pipeline

`receiveInbound()` (`src/lib/integrations/inbound.ts`) processes every POST to the inbound route:

1. **Key shape** — a malformed key is rejected without touching the database.
2. **Resolution** — the key's digest is looked up through the 0058 SECURITY DEFINER `integration_inbound_resolve_endpoint` (§10.2). **The organisation is resolved only from the endpoint key.** No org id is ever read from the payload; there is no session on this path and the pre-auth reads run under a zero context that can see nothing else.
3. **Verification** — per the provider's registry mode. For the generic provider (`endpoint-token`), the presented key's digest must constant-time-match the stored digest. (The `hmac-sha256` mode — HMAC over the raw body with the connection's vault secret, constant-time compare — is implemented for future providers; no V1 entry uses it.)
4. **Live gates** — the connection must be `CONNECTED` and its config must not set `inboundEnabled: false`; a disconnected or paused endpoint refuses exactly like an unknown one.
5. **Body cap before parsing** — the provider's cap (256 KB for `webhooks`; the route additionally hard-caps at 256 KB before resolution, so a provider may declare less, never more, in V1). Only the body's SHA-256 is ever stored.
6. **JSON + event id** — the generic receiver speaks JSON; a non-JSON body is a validation refusal. The external event id (§7.3) is extracted.
7. **Dedup** — via the 0058 definer `integration_inbound_find_receipt` (§7.3).
8. **Receipt first** — the `integration_inbound_events` row is written (status `RECEIVED`) *before* any processing, so a crash mid-dispatch leaves a receipt a redelivery can reprocess.
9. **Dispatch** — one workflow event of the `webhook` trigger type (enabled by Phase 10) is dispatched under the connection's `connected_by` person: a constructed Authorization for a principal the database record itself names, whose live permissions the workflow engine re-derives on every call. The event payload is `{ providerKey, connectionId, externalEventId, data }`, where `data` is the parsed JSON body (non-object JSON is wrapped as `{ value }`). The engine dedups executions on a receipt-scoped key, so reprocessing a receipt can never double-run a workflow. The receipt is then marked `PROCESSED` (or `FAILED` on a pipeline failure; with no `connected_by` there is no principal whose authority could run a workflow, and the receipt fails closed as `FAILED` rather than inventing one).

All writes run through 0060's two narrow SECURITY DEFINER functions (§10.2), with no person identity: `integration_inbound_write_receipt` derives the org and provider from the connection row (re-verifying the presented digest against it), and `integration_inbound_set_receipt_status` derives the org from the receipt row itself. 0056 designed the writes to run under its tenant-only receipt policies (`org_id = authz.org_id()`), but `authz.org_id()` derives the org from the person and this plane has none, so the policies can never admit a pre-auth write — the definers are the write path those policies could not be. The handler never fetches URLs from payload content.

### 7.3 Idempotency and replay (as shipped)

- **External event id.** Taken, in precedence order, from the `x-event-id`, `x-webhook-id` or `idempotency-key` headers, else from a top-level string `id` in a JSON object body (ids over 256 chars are treated as absent, never truncated). A delivery whose (connection, external event id) already has a receipt is a duplicate: the partial UNIQUE index enforces it, and a concurrent identical delivery that loses the insert race is answered as accepted.
- **Payload-hash window.** For deliveries without an event id, the same payload hash arriving for the same connection within **24 hours** is a duplicate and is recorded as its own row with status `DUPLICATE`.
- **Redelivery is the recovery path.** A duplicate of a `PROCESSED` (or `DUPLICATE`) receipt is answered accepted and never reprocessed. A redelivery of a `FAILED`, interrupted (`RECEIVED`) or `REJECTED_*` receipt **reprocesses** — it must first pass verification and the live gates again — because the sender's retry is how a failed receipt recovers.
- **No timestamp check is performed on inbound deliveries.** Replay protection is the idempotency layer above, not a clock window (this refines the contract's "±5 minutes where the provider sends one" — the generic provider defines no signed timestamp, so there is nothing trustworthy to check a clock against).

Senders should therefore always send a stable event id per delivery and treat redelivery of the same event id as safe.

### 7.4 Uniform responses

Responses reveal nothing about which check failed:

| Outcome | Response |
|---|---|
| Accepted — `PROCESSED`, `DUPLICATE` and `FAILED` receipts alike | `200 { "status": "accepted" }` |
| Rejected — unknown endpoint, malformed key, failed verification, disabled/disconnected connection, oversized body, non-JSON body | `400 { "error": { "code": "INBOUND_REJECTED", "message": "The webhook delivery was rejected." } }` — one shape for every reason |
| Infrastructure failure | `500 { "error": { "code": "INTERNAL", … } }` — opaque |

The true refusal reason lives only in the receipt row's `status` (`REJECTED_SIGNATURE` / `REJECTED_VALIDATION`), visible to the org's admins in the executions view. Unknown endpoints leave **no row at all** — there is no org to record against, and probers must not be able to flood the table. An accepted-but-failed receipt still answers 200: the delivery is durably recorded, and the sender cannot fix an internal failure — signalling it would only invite retries that §7.3 already handles deliberately.

---

## 8. Email delivery

### 8.1 The path

Workflow `send_email` actions (Phase 8) and system mail enqueue Phase 6 `email` jobs; the worker's handler calls `sendEmailViaProvider()` (`src/lib/jobs/handlers.ts`), which selects the adapter from the deployment env `EMAIL_PROVIDER`:

| `EMAIL_PROVIDER` | Behaviour |
|---|---|
| `resend` | The real adapter (`src/lib/integrations/providers/email/send.ts`) sends via the Resend SDK. |
| unset | **Fail-closed**: the job dead-letters immediately, non-retryable, with `EMAIL_PROVIDER_UNCONFIGURED`. |
| any other value | **Fail-closed**: `EMAIL_PROVIDER_NOT_IMPLEMENTED`, non-retryable. No adapter exists for it yet — a synthetic success would be a false-delivery integrity failure, so the job never transitions to `succeeded` without an actual send. |

Fail-closed is the Phase 6 design, preserved: wiring Resend closed the hand-off note on that branch and made workflow `send_email` actually deliver; it did not change the behaviour of any other branch.

### 8.2 Credential and sender

- **Credential**: the adapter resolves `EMAIL_PROVIDER_API_KEY` first, falling back to `RESEND_API_KEY` (the key the auth-adjacent mailers — invitations, password reset — honour), so one Resend account per deployment serves both. Neither set ⇒ `CONFIG_ERROR` (unconfigured), non-retryable. This is the `email` connection's Tier E credential (§3.1).
- **Sender**: `EMAIL_FROM` — an address on a Resend-verified domain; there is no safe default to invent. Unset ⇒ `CONFIG_ERROR` (`EMAIL_FROM_UNCONFIGURED`), non-retryable. (Per-connection sender config is captured but not yet wired into this path — §2.2.)

### 8.3 Idempotency and error normalisation

- The handler derives a deterministic idempotency key per job — `pravshi-email:<jobId>:<dedupKey | 'no-dedup'>` — and the adapter passes it to Resend as the `Idempotency-Key` (the SDK's `idempotencyKey` option). A retried job re-sends under the **same** key, and Resend will not double-send.
- Every failure leaves the adapter as an `EmailSendError` carrying a platform code, which the queue's retry classifier consumes: `CONFIG_ERROR` (deployment credential/config — provider names `missing_api_key`, `invalid_api_key`, `restricted_api_key`, `invalid_access`) → non-retryable; `VALIDATION_ERROR` (the message itself — `validation_error`, `invalid_from_address`, …) → non-retryable; `PROVIDER_ERROR` (everything else — rate limits, quotas, provider 5xx, transport) → **retryable** with the queue's backoff.
- The provider's raw response text is never copied into an error message or a log line; only its normalised error *name* (an SDK enum) is retained for observability.

---

## 9. Rotation and revocation runbooks

General rules for every rotation below: rotations are audited (HIGH severity for secret rotations); the response that carries a new secret is its **only** plaintext appearance — copy it to its destination immediately; there is no way to view a stored secret afterwards, only `hasCredential` and masked identifiers.

### 9.1 Connection credentials

- **Tier E (email)** — there is nothing to rotate in the database: the credential is the deployment env value. Rotate `EMAIL_PROVIDER_API_KEY` (or `RESEND_API_KEY`) in the environment and redeploy/restart. The connection's `rotate-secret` only re-points `credential_ref`, and the service constrains it to the provider's fixed env var name — in practice a no-op confirmation, because the ref may never name anything else.
- **Tier V (webhooks connection secret)** — `POST /api/integrations/connections/[id]/rotate-secret` with `{ "secret": "<new secret>" }`. This **replaces** the credential: V1 holds one vault key version, so re-encrypting the old plaintext under the same key would change nothing — the admin supplies the new secret, it is encrypted and stored, and the old envelope is overwritten in the same update. Anything verifying against the old secret must be updated first.

### 9.2 Subscription signing secrets

`POST /api/integrations/webhooks/[id]/rotate-secret` (`integrations.manage`):

1. Give the receiver the **new** secret first if your receiver supports holding two — Pravshi-side, there is no overlap window: a fresh 256-bit secret is generated server-side, its envelope overwrites the old one in a single update, and **the old secret stops signing/verifying the moment the rotation commits**.
2. The new plaintext is returned exactly once in the rotation response. Store it in the receiver's secret store immediately.
3. Deliveries already queued resolve the secret at delivery time (§5.3), so they will be signed with the **new** secret — expect a brief window where in-flight deliveries verify only under the new secret.

Related: disabling a subscription (`active = false`) drops queued deliveries at attempt time (job succeeds, nothing sent) and stops fan-out matching. Deleting a subscription that has delivery history is refused with `409 CONFLICT` — delivery history is an audit trail; disable instead.

### 9.3 Inbound endpoint keys

`POST /api/integrations/connections/[id]/inbound-endpoint` — issuance and rotation are the same operation. A fresh 256-bit key is generated, only its digest is stored (overwriting the old digest), and the plaintext + full inbound URL return exactly once. **The old URL stops resolving the moment this answers**: update the external sender's target URL before or immediately after rotating, and expect deliveries to the old URL to be rejected (uniformly, §7.4) in between. To revoke without reissuing, disconnect the connection or set its config `inboundEnabled: false` — both make the endpoint refuse exactly like an unknown one.

### 9.4 The vault key (`INTEGRATIONS_ENCRYPTION_KEY`)

Read §3.2 first: V1 has exactly one key version and no keyring. Rotating the deployment key is therefore a **destructive-to-ciphertext** operation, planned like a credential reset, not a routine rotation:

1. Change `INTEGRATIONS_ENCRYPTION_KEY` in the deployment environment and redeploy.
2. Every stored Tier V envelope now fails decryption: connection credential resolution answers `500 CREDENTIAL_UNREADABLE`; subscription deliveries fail as non-retryable config errors (unsigned sends are refused) until step 3.
3. Recover by re-entering each secret under the new key: connection secrets via §9.1 rotate (the admin supplies the secret again), subscription secrets via §9.2 rotate (a fresh secret is generated and encrypted under the new key — then update each receiver, §9.2's caveat applies).

There is no bulk re-encryption job in V1 (deferred, §12). Organisations with many subscriptions should treat a vault-key change as a scheduled maintenance event.

### 9.5 Disconnect and revocation

`DELETE /api/integrations/connections/[id]` destroys the credential **before** deleting the row: ciphertext, nonce, key version and ref are nulled and the status set to `DISCONNECTED`, then the row is deleted — a failure between the two leaves a credential-less row, never a deleted row whose secret outlived it somewhere. A PATCH that moves a connection into `DISCONNECTED` applies the same destruction. A disconnected connection retains no usable secret; its inbound endpoint (if any) refuses deliveries, and fan-out health surfaces it as disconnected. Audit entries record `credentialDestroyed: true`.

---

## 10. Security model summary

### 10.1 Tenant isolation

Every Phase 10 table has RLS **enabled and forced**; every service query runs under `withAuthorizedDb` and additionally predicates on the caller's org id (defence in depth on RLS). Cross-tenant ids answer `NOT_FOUND`. The only pre-auth surface is the inbound route, where the endpoint key — not a session, never a payload field — determines the org (§7.2). Services take `auth: Authorization` first (the CRM pattern) and hold no org id from client input anywhere.

**DELETE is a scoped privilege exception (0060).** The platform model (`scripts/db/roles.sql`) grants `app_user` SELECT/INSERT/UPDATE on public tables and never DELETE; flows that must delete take a scoped exception in a migration (the 0013 auth-tables precedent). 0060 grants DELETE on the five `integration_*` tables only, because disconnect/delete are hard actions in this module (§9.2, §9.5) and a policy cannot gate a privilege the role does not hold. The privilege is the coarse gate only — the 0056 RLS policies remain the real gate: connections and subscriptions carry DELETE policies (`integrations.manage`, own org), while deliveries, inbound events and checkpoints carry **no** DELETE policy at all, so a DELETE there matches zero rows. Their append-only / audit-trail posture is unchanged; it is now enforced by policy rather than by a privilege error.

### 10.2 The five definers, and why each exists

Five narrow SECURITY DEFINER functions exist because legitimate readers and writers on the pre-auth and worker planes cannot satisfy the RLS policies — the same wall Phase 6/8 met, solved with the same bounded-definer pattern:

| Function | Migration | Caller | Why it exists | Why it is safe |
|---|---|---|---|---|
| `integration_inbound_resolve_endpoint(p_endpoint_key_hash)` | 0058 | Inbound route, pre-auth | There is no org context until the endpoint resolves; the resolution read must happen before one exists | Takes only the key's digest; returns one connection's resolution fields for an exact digest match. The app reaches it under a zero context that satisfies no RLS policy — replace it with a raw table read and it returns nothing, not everything |
| `integration_inbound_find_receipt(p_connection_id, p_external_event_id, p_payload_hash)` | 0058 | Inbound pipeline, pre-auth | The dedup decision (§7.3) must be made before the receipt write establishes the org context | Scoped to one connection id obtained from resolution; returns only a receipt id, its status, and which key matched — no payload, no other tenant reachable through any parameter |
| `integration_webhook_resolve_delivery(p_org_id, p_subscription_id)` | 0059 | Job worker (`handleWebhook`) | The worker runs as the nil-UUID system actor: not a row in `people`, so `authz.has()` is false for it and the subscriptions SELECT policy (`integrations.view`) can never be satisfied on the worker plane | The org argument is `ctx.job.orgId`, stamped on the job row at enqueue time from the authorized enqueueing context — a payload-supplied org id is accepted nowhere in the delivery path. Returns, for the exact (org, subscription) pair only, the `active` flag and the signing-secret **ciphertext** — plaintext exists nowhere in the database; decryption happens in the worker with the env-held vault key, so the ciphertext alone is not a usable credential |
| `integration_inbound_write_receipt(p_connection_id, p_endpoint_key_hash, p_external_event_id, p_payload_hash, p_status, p_mark_processed)` | 0060 | Inbound pipeline, pre-auth | Receipt INSERTs are writes, and 0056's tenant-only INSERT policy keys on `authz.org_id()` — which derives the org from the person, and the pre-auth context has none, so the policy can never admit the write | Re-verifies inside that the presented digest equals the connection's stored digest (refuses 42501 otherwise) and derives `org_id` / `provider_key` from the connection row — no org or person id is accepted. Returns the new receipt's id; the 0056 guard triggers and the partial UNIQUE index bound it exactly as they bound a direct insert |
| `integration_inbound_set_receipt_status(p_receipt_id, p_status, p_mark_processed)` | 0060 | Inbound pipeline, pre-auth | The status transitions (RECEIVED → PROCESSED / FAILED, reprocess resets) hit the same wall as the insert: the tenant-only UPDATE policy needs a person-derived org that does not exist on this plane | The receipt id is the only locator; the row's org is read from the row itself and the UPDATE is predicated on it, so no parameter can steer the write across tenants. Only `status` (and `processed_at`, when asked) changes — the 0056 identity-freeze trigger bounds the definer as it bounds any writer |

No definer trusts a caller-supplied org/person id from request data: each input is either a digest, an id obtained from a prior resolution, or a value the platform itself stamped on a row at enqueue time (the PR #66 carry-over rule).

### 10.3 Identity freeze

Identity columns (`id`, `org_id`, `provider_key` / parent FKs, `created_by` / `connected_by`, `created_at`) are frozen on UPDATE by BEFORE UPDATE integrity triggers (the 0010/0018 `enforce_*_integrity` pattern — how this repository freezes identity, since RLS policies cannot reference `OLD`). The RLS UPDATE policies additionally gate *who* may update at all, and the services reject identity fields in update payloads as `VALIDATION` so an attempt fails legibly instead of as an opaque trigger error. One deliberate exception: `inbound_endpoint_key_hash` is **not** in the connections freeze list (0058), so the manage-gated UPDATE policy alone governs endpoint-key rotation.

### 10.4 SSRF posture

- **Outbound**: subscription URLs pass the delivery engine's *static* check at create/update — a fail-fast for the admin, never a substitute for delivery-time checks (DNS can change between the two). At delivery, the Phase 6 guard runs in full: only http/https; blocked host suffixes (`.internal`, `.local`); DNS resolution with **every** resolved address checked against blocked CIDRs (private, loopback, link-local, including 169.254.169.254, in any `inet_aton` spelling); the TCP connection **pinned** to the verified address; redirects re-validated per hop.
- **Inbound**: the posture is about responses, not requests — the handler never fetches URLs from payload content, caps the body before parsing, and answers uniformly (§7.4).
- **Config hygiene**: connection and subscription config can never smuggle a credential — the service deep-scans for credential-shaped keys (`secret`, `password`, `token`, `api_key`, `authorization`, `credential`, `ciphertext`, `nonce`, …) before and after schema parsing, on top of each provider's strict zod schema.

### 10.5 Audit trail

Lifecycle events are written through `writeAuditEntry` with flat, ids-only metadata — never secrets, never payload bodies:

| Action | Severity | When |
|---|---|---|
| `integration.connection.created` | MEDIUM | Connection created (metadata: provider, tier, `hasCredential`, status) |
| `integration.connection.updated` | LOW | Config/display-name/status change |
| `integration.connection.disconnected` | MEDIUM | Disconnect (`credentialDestroyed: true`) |
| `integration.connection.secret_rotated` | HIGH | §9.1 rotation |
| `integration.webhook_subscription.created` / `.updated` / `.deleted` | MEDIUM / LOW / MEDIUM | Subscription lifecycle |
| `integration.webhook_subscription.secret_rotated` | HIGH | §9.2 rotation |
| `integration.inbound_endpoint_key.issued` | HIGH | §9.3 issuance/rotation (metadata includes a `rotated` flag — never the key) |

Health recordings are deliberately **not** audit-logged per call: `recordConnectionHealth` is a high-frequency machine signal and the row (`last_health_at`, `last_error_code`) is its record. Inbound rejection reasons live in the receipt rows, not the audit log.

### 10.6 Permissions posture

The integrations surface is admin-only in V1 (§1.4): org-wide credential management at department/self scope would be a security smell, and no non-admin workflow needs to touch a connection. Fan-out's exception proves the rule — it borrows the *event raiser's* authority and escalates nothing (§5.3).

---

## 11. Operations

### 11.1 Diagnosing deliveries and receipts

Start from the executions view (`GET /api/integrations/executions` or Settings → Integrations → Executions) and the Phase 6 jobs surface:

| Observation | Meaning | Action |
|---|---|---|
| Webhook job `dead_letter` with a config error naming subscription secret resolution | The subscription's secret could not be decrypted in the worker — vault key unset/changed, or envelope tampered | Check `INTEGRATIONS_ENCRYPTION_KEY` in the **worker** environment; if the key changed, follow §9.4. Never "fix" by sending unsigned — the sender refuses by design |
| Webhook job succeeds but the receiver got nothing | The subscription was disabled after enqueue (delivery dropped deliberately), or the org kill switch (`outboundEnabled: false`) paused fan-out for later events | Check the subscription's `active` flag and the webhooks connection config |
| Deliveries failing `HTTP_4xx` | The receiver refused (bad signature after a rotation is the common cause) | Confirm the receiver holds the current signing secret (§9.2); 4xx is non-retryable — replay manually from the jobs surface after fixing |
| `email` jobs dead-lettered `EMAIL_PROVIDER_UNCONFIGURED` / `EMAIL_PROVIDER_NOT_IMPLEMENTED` | `EMAIL_PROVIDER` unset, or set to a provider with no adapter | Set `EMAIL_PROVIDER=resend` (§8) or accept email as disabled; replay after fixing |
| `email` jobs dead-lettered with adapter `CONFIG_ERROR` | Resend rejected the deployment credential/config, or `EMAIL_FROM` unset | Fix `EMAIL_PROVIDER_API_KEY` / `RESEND_API_KEY` / `EMAIL_FROM` in the deployment env |
| Inbound receipts stuck at `REJECTED_SIGNATURE` | Sender is using a stale endpoint URL/key, or (future HMAC providers) a wrong secret | Re-issue the endpoint key (§9.3) and give the sender the new URL |
| Inbound receipts at `FAILED` | Dispatch pipeline failure, incl. a connection with no `connected_by` principal | Inspect the connection's `connected_by`; the sender's redelivery reprocesses (§7.3) |
| Connection answers `500 CREDENTIAL_UNREADABLE` | Stored envelope cannot be decrypted (wrong/changed vault key, tampered row) | §9.4 recovery: re-enter the secret via rotate |
| Jobs accumulate in `pending` | No worker is running (§1.1) | Start/scale the worker process; queued is a state, not data loss |

### 11.2 Error taxonomy (API)

One taxonomy for all authenticated integrations routes (`src/lib/integrations/errors.ts`); messages are static — the code and an optional field-path/provider-key detail are all a caller learns.

| Code | HTTP | Meaning |
|---|---|---|
| `NOT_FOUND` | 404 | The connection/subscription is not visible — missing, or another tenant's (indistinguishable by design) |
| `FORBIDDEN` | 403 | A service-level refusal distinct from the route's permission gate |
| `VALIDATION` | 400 | Malformed or impermissible input: unknown provider key, config failing the provider schema, a credential-shaped key inside config, an identity column in an update, an SSRF-blocked subscription URL |
| `CONFLICT` | 409 | State collision: a second connection for a singleton provider; deleting a subscription that has delivery history |
| `NOT_CONFIGURED` | 503 | A required piece of deployment configuration is absent — the Tier V vault key is unset. The app and every Tier E feature keep working |
| `CREDENTIAL_UNREADABLE` | 500 | A stored vault credential cannot be decrypted (tampered envelope, unsupported key version, wrong key). Never the caller's fault and never retryable as-is; the message deliberately does not say which |

Plus the shared shapes: `INVALID_REQUEST` (400, zod validation), `INBOUND_REJECTED` (400, the inbound uniform shape, §7.4), `INTERNAL` (500, opaque). Vault-internal codes (`VAULT_NOT_CONFIGURED`, `VAULT_MALFORMED_ENVELOPE`, `VAULT_UNSUPPORTED_KEY_VERSION`, `VAULT_DECRYPT_FAILED`) never reach a caller — the service maps them into this taxonomy (`VAULT_NOT_CONFIGURED` → `NOT_CONFIGURED`; the rest → `CREDENTIAL_UNREADABLE`).

---

## 12. Known limitations and deferred scope

Stated plainly, so nobody plans against capabilities that do not exist:

- **OAuth connection flow — deferred.** No OAuth provider, client registration or confirmed product requirement exists in the repo. The connection record + vault are OAuth-ready (a future flow writes the same Tier V columns), so deferral costs nothing.
- **Business-data sync engine — deferred.** `integration_sync_checkpoints` (0056) lands so the first confirmed sync provider needs no second schema migration, but **no service reads or writes it in V1** and no sync of any external system's data takes place.
- **Per-org inbound throttling — deferred.** V1's binding inbound controls are the endpoint key's unguessability, the 256 KB body cap enforced before parsing, and the connection-level kill switches (`inboundEnabled`, disconnect). There is no per-org inbound rate limiter or quota counter.
- **Per-provider rate limits / quotas — not modelled.** No V1 provider exposes a quota worth enforcing: Resend sends ride the job retry classifier, and generic webhooks are receiver-paced. Per-subscription delivery pacing comes free from job scheduling.
- **Vault keyring — not in V1.** One key version (§3.2, §9.4); no dual-key decrypt, no lazy re-encryption on write, no bulk re-encryption job.
- **Email connection config is not yet wired into sending.** `fromAddress` / `fromName` / `replyTo` on the `email` connection are captured and validated but the job path sends from `EMAIL_FROM` (§2.2, §8.2). The adapter's per-send `from` override is the seam.
- **`hmac-sha256` inbound verification has no V1 consumer.** The verifier mode is implemented and unit-tested; the only inbound provider (`webhooks`) authenticates by endpoint token.
- **Fan-out authority caveat.** Fan-out runs under the event raiser's authority (§5.3): a domain event raised by a context that cannot see the org's subscriptions (no `integrations.view`, no `jobs.create`) fans out to nothing, silently except for the returned counts. Admin-raised events (the common case for workflows, deals and tasks managed by admins) are unaffected.
- **Worker hosting is a deployment concern.** All delivery, email and retry behaviour depends on the separate worker process running (§1.1); production worker hosting is a Phase 13 question.
- **Production migrations are a separate, explicit operation.** `0056`–`0059` apply through the repository's migration tooling (journal idx 55–58, `when` 1791343891091–1791343891094); this feature's rollout does not authorize a production migration, and setting `INTEGRATIONS_ENCRYPTION_KEY` or the email variables is likewise an environment operation, never a repo or migration change.
