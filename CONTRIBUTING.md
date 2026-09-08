# Contributing to PRAVSHI OS

## The one thing to understand first

This repository runs on **GitHub Free**, on which private repositories get no branch
protection, no required status checks, and no enforced CODEOWNERS review.

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

1. **Nobody pushes directly to `main`.** A push to `main` that did not arrive through a
   pull request fails the `direct-push-audit` workflow, which exists to make the
   violation visible after the fact — it cannot prevent it.
2. **All normal work branches from `main`** and returns through a pull request.
3. **CI must be green before merge.** GitHub cannot mark the `ci` check required on this
   plan, so a red run blocks a merge only because a human refuses to merge it. Merging
   over red CI requires a written justification in the pull request.
4. **The founder or an authorised maintainer performs the merge to `main`.**
5. **CODEOWNERS requests review; it does not require it.** `.github/CODEOWNERS` causes
   GitHub to auto-request the right reviewers. On GitHub Free that request can be
   dismissed or ignored, and merging without it is not blocked. Treat the request as
   binding anyway.
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

CI never touches production. Each run creates an ephemeral Neon branch from the
non-production `staging` parent, resets that branch's role passwords so the credentials
it uses exist only for that run, and deletes the branch afterwards.

- Tests and the application connect as **`app_user`** (pooled) — the role with no
  `BYPASSRLS` that owns no tables.
- Only migrations connect as **`app_owner`** (direct).
- No production database credential is ever stored in GitHub Actions. The only secrets
  are `NEON_API_KEY` and `NEON_PROJECT_ID`; every connection string is derived at
  runtime and masked.

## Before opening a pull request

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```
