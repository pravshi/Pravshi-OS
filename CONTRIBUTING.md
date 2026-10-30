# Contributing to PRAVSHI OS

## The one thing to understand first

This repository runs on **GitHub Free** and is **public**. A public repository can have
branch protection, required status checks and enforced CODEOWNERS review, but none of
them was configured on `main` when this was last checked (2026-10-15). (On GitHub Free a
private repository cannot have them at all.)

Every rule below is therefore **enforced by people, not by GitHub**. The platform will
not stop you from pushing to `main`, and it will not stop you from merging a pull
request whose CI is red. That is precisely why these rules are written down.

## Branches

```
feature/*  ->  PR  ->  main
```

```
main       the integration branch and the intended production branch.
           Protected by policy only.
feature/*  fix/*  chore/*  docs/*      branch from main
hotfix/*                               branch from main, genuine production incidents only
```

Use no other prefixes without a reason.

There is **no `develop` branch**. An earlier `feature/* -> develop -> main` model was
retired once the project became single-developer: a second integration branch adds a
merge step and no review that a solo founder was not already performing. If the team
grows, reintroducing `develop` is a deliberate decision, not a default.

## Rules

1. **Two ways onto `main`.** (a) A merged pull request. (b) A direct _milestone push_: a
   verified, plain fast-forward of finished work, pushed with an explicit refspec, never
   forced. The `direct-push-audit` workflow checks every push after the fact — it cannot
   prevent one. A direct push passes only if it is a fast-forward of the previous tip, changes
   no protected path (`PROTECTED_PATHS` in `scripts/ci/verify-pr-merge.mjs`: CI, scripts, guards,
   dependencies and tool configuration, migrations, shared files, agent rules), asks for no CI skip, and its own `ci` run succeeded. There is no
   bypass for any person or bot. Anything else fails the audit.
2. **Work branches from `main`** and returns as a milestone push, or through a pull request
   for high-risk or security-sensitive changes, any migration, changes to the protected
   paths above, and whenever independent review adds value.
3. **CI must be green before merge** (for a direct milestone push, green on the pushed commit
   after the push; a failure is fixed forward with a new commit, never a force-push). The `ci` check is not marked required on `main`, so
   a red run blocks a merge only because a human refuses to merge it. Merging over red CI
   requires a written justification in the pull request.
4. **The founder or an authorised maintainer performs the merge of a pull request.**
5. **CODEOWNERS requests review; it does not require it.** `.github/CODEOWNERS` causes
   GitHub to auto-request the right reviewers. With no branch protection requiring code
   owner review, that request can be dismissed or ignored, and merging without it is not
   blocked. Treat the request as binding anyway.
6. **`hotfix/*` may branch from `main`** only for a genuine production incident, and
   returns through a pull request like anything else.

Merging a pull request deletes its head branch automatically. That is correct for
`feature/*`; be aware of it before pointing a long-lived branch at a PR.

## A guard failure is a security failure

`tests/guards/` proves the things the authorization model assumes: RLS enabled _and_
forced on every table, a runtime role that cannot bypass it, exactly one path to
Postgres, and nothing that defeats Neon autosuspend.

If a guard fails, **fix the cause**. Do not adjust the guard to make CI green. A guard
that was weakened to unblock a merge is worse than no guard, because it still reads
like protection.

## Databases in CI

CI never touches Neon. Each run starts its own empty Postgres 18 as a GitHub Actions
service container, provisions it with `scripts/db/roles.sql`, applies every migration
from zero, runs the tests, and is discarded with the job. CI used to branch from Neon
for every run; with many pull requests a day that exhausted the project's monthly Neon
storage allowance and copied production data into CI, so it no longer does.

- The code under test uses the real `@neondatabase/serverless` driver. Neon's
  `wsproxy` tunnels its WebSocket to Postgres byte-for-byte and authenticates nobody
  itself, so every connection logs in as its own role with its own password and RLS
  applies exactly as on Neon. `scripts/ci/neon-local.mjs` points the driver at the
  proxy and is inert unless `NEON_LOCAL_WSPROXY` is set.
- Tests and the application connect as **`app_user`** — the role with no `BYPASSRLS`
  that owns no tables. A CI step proves it before the tests run.
- Only migrations connect as **`app_owner`**.
- CI holds no database credential and no Neon credential. Role passwords are generated
  per run, masked, and die with the job.

## Before opening a pull request

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```
