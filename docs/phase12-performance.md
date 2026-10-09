# Phase 12 — Performance & Reliability

The budgets record for Phase 12 of Pravshi OS: the static performance baseline, the
budgets this phase contracts and where each is enforced, the worker capacity statement,
and the remaining-bottleneck list. Contract section numbers in parentheses refer to
`phase12-architecture-audit.md`.

> Status: implemented (docs + route-duration alignment in this wave; the analytics
> composition, worker recovery and frontend waves land in the same phase). **No latency
> in this document has been measured.** The baseline in §1 is static analysis — facts
> counted in code and in the production build's output. Measured figures (the Tier-2
> harness, §5) are deferred to the post-Nov-1 slot by Nani's rule suspending local
> database work until 1 Nov 2026, and will be recorded here when they exist. A budget
> that cannot be checked in CI or preflight is labelled a **target**, never reported as
> met.

---

## 1. Static baseline (§2 of the audit)

### 1.1 Request anatomy and the pool

Every database interaction funnels through one shared Neon serverless pool
(`src/lib/db/pool.ts`): **max 5 connections per serverless instance**,
`idleTimeoutMillis` / `connectionTimeoutMillis` 10 s. `withAuthorizedDb()`
(`src/lib/db/authorized.ts`) is the only path to business data, and every call is a full
transaction — checkout → `BEGIN` → `set_config` identity select → callback → commit →
release — so each transaction costs at least 4 round trips and holds its connection for
the whole callback. Better Auth's store shares the same pool.

The standard authenticated API request therefore costs, statically counted:

| Step                                                 | Pool usage                    |
| ---------------------------------------------------- | ----------------------------- |
| Better Auth `getSession` + `resolve_auth_identity()` | 2 queries (no transaction)    |
| `requirePermission()`                                | 1 transaction                 |
| The service itself                                   | 1 transaction (typical)       |
| Audit write (mutations)                              | inside the service tx         |
| **Baseline total**                                   | **2 transactions + 2 queries** |

Two consequences frame the phase:

- **Latency floor.** No request can beat ~6 sequential database round trips; round-trip
  time to Neon is the dominant term in every p50. [Measurement deferred.]
- **Pool pressure is a per-request design property.** Any handler that opens transactions
  in parallel multiplies against `max: 5`. Exactly one surface did this at scale — the
  analytics overview (§2).

_Delta note:_ this anatomy was recorded against the pre-Phase-11 tree. Phase 11 has since
merged (main `f63fb148`); its request-path additions — origin verification inside the
existing `withPermission` wrapper, throttles on three named surfaces — do not change the
anatomy for the routes this document budgets.

### 1.2 The analytics fan-out (F-12-01)

Before Phase 12, `GET /api/analytics/overview` resolved 12 metric functions in
`Promise.all`, each opening its **own** transaction: one dashboard hit wanted ~13
transactions and 12 simultaneous pool connections from a pool of 5, with the 6th–13th
checkouts queueing behind the 10 s connect timeout. The four sibling analytics routes
repeated the pattern at smaller fan-out.

### 1.3 Frontend payload (production build, audit §2.6)

- First Load JS shared by all pages: **185 kB** — the floor every page pays.
- Heaviest pages: `/work/projects/[id]` 283 kB, `/work/tasks/[id]` 269 kB,
  `/workflows/[id]/edit` 259 kB, `/workflows/new` 258 kB, `/notifications` 247 kB,
  `/jobs/schedules` 243 kB. Analytics pages are light (186–197 kB).
- No code-splitting existed (`next/dynamic`: zero usages); the named webfonts were never
  loaded (F-12-07).

### 1.4 Verified-healthy areas (no work contracted)

Pagination is uniformly bounded (lists ≤ 100, search ≤ 50, notifications ≤ 50); the
audit-log export is keyset-paginated streaming with a hard row cap; 162 indexes were
spot-verified against the hot query shapes with no missing index provable statically;
no surface retries unboundedly; API responses for authorized data are `no-store` by
construction and stay that way — **no caching is contracted anywhere in this phase**
(§2.5 of the audit gives the reasoning).

---

## 2. Budgets — contracts and enforcement

| Budget                                                                 | Value                                                    | Enforcement                                                                 |
| ---------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| Transactions per analytics request                                     | **≤ 2** (one shared metrics tx + the authz tx), all five routes | §4.1 composition; parity tests (own-tx vs shared-tx diffed); `tests/perf/overview-concurrency.test.ts` (4 concurrent compositions, exactly 4 transactions counted, zero connect-timeouts) |
| Transactions per standard API request                                  | 2 + 2 auth queries (the §1.1 baseline — do not regress)  | Static anatomy; any new per-request transaction needs a stated reason in its PR |
| Pool size                                                              | `max: 5` — **raising it is explicitly not the fix** for fan-out | §4.1 decision; demand reduction only                                        |
| Plan shape on the seven named hot queries                              | No `Seq Scan` on the inner table (Tier-1 dataset, §5)    | `tests/perf/query-plans.test.ts` in CI, every PR — real service functions, plans captured via `EXPLAIN (FORMAT JSON)` on the services' own transactions over the `tests/perf/seed.ts` dataset (two orgs at the §4.4 sizes, ANALYZE run); the jobs-claim assertion explains the 0045 definer's candidate query verbatim and names the canonical `jobs_claim_idx` |
| Shared First Load JS                                                   | ≤ 190 kB                                                 | Preflight reads the build table (the §1.3 method); no CI-yaml change        |
| Any page's First Load JS                                               | ≤ 300 kB                                                 | Same preflight read                                                         |
| The three code-split pages (workflow editor, project board, task detail) | each drops ≥ 15 kB of First Load, or the wave reports why not | Same preflight read                                                   |
| Worker idle poll                                                       | 1 s → 10 s geometric ceiling while the queue is empty    | `tests/jobs/worker-lifecycle.test.ts` (CI)                                  |
| AI route platform duration                                             | `maxDuration = 60` declared on `/api/ai/assist`          | §4 of this document                                                         |

Wall-clock latency figures are **targets, not gates**: timings inside CI's shared runners
are regression signals, never product SLOs, and no tight threshold is gated on anywhere
in this phase.

---

## 3. Worker capacity statement (F-12-03)

The job plane's execution contract, stated plainly so it is a conscious assumption
rather than a surprise:

- **One job at a time per worker process.** The claim loop `await`s each job before
  claiming the next (`src/lib/jobs/worker.ts`). A single long job — a 30 s webhook
  timeout chain is the worst current case — head-of-line blocks every other job type
  behind it **on that process**.
- **Throughput per process ≈ 3600 ÷ mean job seconds** (jobs/hour). Horizontal scale is
  the only scale: add processes. Claims use `FOR UPDATE SKIP LOCKED`, so added processes
  never double-execute a job.
- Supporting machinery: 15 s claim heartbeat; handler errors classified into
  retry-with-backoff (exponential + jitter) vs dead-letter; poison jobs cannot crash the
  loop; graceful shutdown drains for up to 30 s and releases the claim without burning
  an attempt; stale claims are reaped at startup and in-loop (F-12-02), so crash
  recovery no longer depends on anyone scheduling a cleanup job.
- **A parallel-claim redesign is explicitly NOT contracted.** It requires measured
  queue-depth evidence — from the Tier-2 harness (§5) or from production — that does not
  exist yet. The sequential design is what makes the heartbeat/shutdown reasoning
  simple, and V1 keeps it.

Operationally, the worker is a required deployment component with its own host, env
parity and liveness check — see DEPLOYMENT.md, "The worker plane".

---

## 4. Route duration alignment (F-12-06)

- `src/app/api/ai/assist/route.ts` declares `export const maxDuration = 60`. The AI
  budget is 30 s end-to-end (`AI_DEFAULT_TIMEOUT_MS = 30_000`,
  `src/lib/ai/config.ts:42`); the 60 s declaration gives the platform headroom for the
  usage-metering and context reads around the provider call. No other route declares a
  duration; `vercel.json` is unchanged (the route-level declaration is the narrower
  tool).
- **Residual risk, stated plainly:** whether the deployed plan's function-duration
  ceiling permits 60 s is unknowable from the repo and is verified only at deployment
  (Phase 13). If the plan caps below the AI budget, the fallback is lowering
  `AI_TIMEOUT_MS` via env — already supported (`src/lib/ai/config.ts`), no code change
  needed.

---

## 5. Measured baseline — Tier 2 [MEASUREMENT DEFERRED]

The Tier-2 harness (Wave D) executes named scenarios against a seeded database and
prints p50/p95/p99 per scenario: overview composition (the F-12-01 before/after),
CRM list/detail, search, AI assist (mock provider), fan-out enqueue, executions
read. It is **record-only — recorded, never gated**.

How it runs: `node scripts/perf/baseline.mjs` spawns `scripts/perf/run-baseline.ts`
through the worker's own TypeScript mechanism (`--experimental-transform-types` +
`scripts/worker-loader.mjs` — no new tooling), so every scenario calls the **real
service functions** against the shared perf dataset (`tests/perf/seed.ts` — the same
seed the Tier-1 plan assertions and the overview-concurrency regression run
against, seeded set-based and verified idempotently). The AI scenario forces
`AI_PROVIDER=mock` (it measures our request path, never a real provider's latency)
and the perf org's AI limits are raised through the real `upsertAiOrgLimits`
service first — harness setup on a fixture org, stated in every report. Options:
`--iterations <n>` / `--prime <n>` (defaults 30 / 3), `--scale <n>` (dataset
scale, default 1), `--out <path>` (also write the markdown report to a file), and
`--ci` (scale 0.05, 5 iterations — trend lines only, and only against a throwaway
database such as a CI services container, never the dataset the Tier-1 suites
verify). Required env: `DATABASE_URL` + `DATABASE_URL_MIGRATE` for the target
database, plus the app env `src/env.ts` requires.

| Scenario | Dataset | Environment | n | p50 | p95 | p99 |
| -------- | ------- | ----------- | - | --- | --- | --- |
| _(first full run: post-Nov-1 slot, against the disposable verification project)_ | | | | | | |

When the first run lands, this table is filled with the dataset size and environment
recorded alongside the numbers, and §6 is revised with whatever the measurements
contradict. Until then, **no performance target is claimed met anywhere in this
phase's paperwork**.

---

## 6. Remaining bottlenecks and open questions

- **Search ceiling (F-12-13, Info).** Relevance ordering computes similarity over all of
  an org's matches before `LIMIT`; correct at V1 scale, unquantified beyond it. A
  harness watch item, not a code change.
- **Neon connection ceiling (audit Q8).** `max: 5` per instance × unknown instance
  count vs the Neon plan's connection limit is a product of two unknowns; §2 reduces
  demand, but the ceiling itself can only be characterised after deployment
  (Phase 13). Not a solved problem.
- **Cold start.** Sentry + OpenTelemetry instrumentation loads on cold start; the
  timing is a deployed-platform property nothing in the repo can measure.
  [Measurement deferred to Phase 13.]
- **AI provider latency.** No real provider is configured anywhere; the mock is
  deterministic. The provider distribution is unmeasured by construction.
- **List count scans.** Each list request runs its `count(*)` over the same filter — a
  second scan per page. Standard practice; a plan-harness watch item.
- **Font loading (F-12-07).** Phase 12 loads the named fonts via `next/font/google`,
  which adds a build-time network fetch. If that ever becomes a CI liability, the
  pre-approved fallback is to de-name the fonts and keep the system stack — either way
  the end state must be true: named fonts render, or no fonts are named.
- **Observability (F-12-12, Info).** Sentry's DSN is unissued (issuing it is Phase 13
  human gate HG-6), so error reporting is disabled in every environment that exists
  today; alerting is a Phase 13 deployment act. Queue depth, job age and dead-letter
  counts are computable today from the analytics automation surface and the audit log.
