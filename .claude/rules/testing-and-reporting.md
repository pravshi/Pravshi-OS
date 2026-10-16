---
paths:
  - 'tests/**'
  - 'vitest.config.mts'
  - 'playwright.config.ts'
  - '.github/workflows/**'
  - 'scripts/guards/**'
---

# Testing and failure reporting

## Running tests

- `pnpm test` runs Vitest projects in order: `serial` (alone, first), `default`, `perf`
  (`vitest.config.mts`). Database suites need the `DATABASE_URL*` variables and a migrated
  database; without them they skip (`DB_READY`). Use a disposable local PostgreSQL — never a
  shared or hosted database — and create only resources you will clean up yourself.
- Tests that mutate shared state (the migration history, global worker functions, audit
  partitions) must use isolated resources or the `serial` project, and must never leave shared
  state changed if interrupted.
- Fixtures must not race the live worker plane in the shared test database: a job due now can be
  swept or claimed by another suite. Seed it not-due, or read results from the operation itself.

## Writing tests

- Every fix gets a regression test that fails without it (mutation check). Security changes
  get forbidden-case tests (another organization, missing permission, forged principal,
  inactive identity, failure path).
- Never weaken, skip, mock away or delete an assertion to make a run green. Never mock the
  database layer in tests that claim database behaviour.

## Reporting results

- Report every failed, skipped, timed-out and not-run test with its name and cause (or
  "unexplained"). A suite with a failed required test has failed.
- Separate **reproduction** (what was run, exact command), **evidence** (output, SHAs) and
  **hypotheses** (labelled as such). Do not infer a cause from timing alone.
- A rerun that passes does not erase the earlier failure; report both and why.
- Known unexplained anomaly: the opt-in worker E2E start-up sometimes exceeds its 20 s window
  (slow from Node's first output). Keep reporting occurrences; do not raise the threshold to hide it.
- Final reports use `[AGENT]` `[CONTEXT]` `[DECISION]` `[CONTRACT]` `[DEPENDENCIES]`
  `[FILE OWNERSHIP]` `[RISKS]` `[STATUS]`, with actual SHAs, commands and remaining blockers.
