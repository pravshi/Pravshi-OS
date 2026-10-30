# Git workflow and release gates

Applies to every session. Source of truth for the branch model: [CONTRIBUTING.md](../../CONTRIBUTING.md).
GitHub enforces almost none of this (no branch protection, no required checks): it holds only
because it is followed.

## Branches and commits

- Branch from the verified current `origin/main` (`git fetch` first; record the SHA). Prefixes:
  `feature/*`, `fix/*`, `chore/*`, `docs/*`; `hotfix/*` only for a production incident.
- One reviewable concern per branch. Use a separate worktree when another branch is in use.
- Commit locally and meaningfully at stable checkpoints. Never commit on a local `main`,
  force-push, rebase or amend pushed commits, or rewrite shared history; make a new commit
  instead. Never delete or discard local commits, branches, worktrees, stashes, backup refs or
  uncommitted work without approval.
- Stage files explicitly. Never stage `audit-output/`, scratch files, logs, `.env*`,
  `tsconfig.tsbuildinfo` changes or credentials.
- After committing, run `node scripts/guards/secret-scan.mjs` and
  `node scripts/guards/secret-scan.mjs --diff origin/main` (the scan reads HEAD). Fake
  connection strings in tests must use the allowed placeholder shape.

## Publishing

- **Milestone push to `main` (default):** finish the task, module or phase, pass every gate
  below on the exact commit, then `git fetch` and confirm `origin/main` is still the recorded
  base and an ancestor of the commit. Push with
  `git push origin <sha>:refs/heads/main` — an explicit refspec, never a bare `git push`,
  never `--force`. If `main` has moved unexpectedly, stop and investigate. Afterwards verify
  the remote SHA, every check on it (`ci`, `direct-push-audit`) and a clean working tree.
- **Pull request instead** for high-risk or security-sensitive changes, any migration, and any
  change to a protected path — `PROTECTED_PATHS` in `scripts/ci/verify-pr-merge.mjs`: `.github/`,
  `scripts/`, `tests/guards/`, `tests/ci/`, `package.json`, the lockfile and tool configuration,
  `drizzle/`, `src/middleware.ts`, `src/env.ts`, the agent rules. The direct-push audit flags a
  direct push touching them only after the fact; it cannot prevent it. Dependency and shared-file
  changes also need the founder's approval (AGENTS.md §3–§4) and never ride in a milestone push
  without it. Independent review is a further reason for a PR. Push the branch and open the PR **only when explicitly
  authorized**: `git push -u origin refs/heads/<b>:refs/heads/<b>`.
- Never merge a PR (the founder merges), never enable auto-merge, never deploy, never change
  repository settings, permissions, secrets, billing or deployment configuration. Production,
  DNS, hosted databases, real email and administrator bootstrap keep their separate approvals.
- A PR description or milestone report separates **local evidence** from **GitHub CI results**,
  states what was not tested, and claims nothing about real Neon or production.

## Release gates (all must hold; a missing one is a failure, not a pass)

1. Clean tree; the diff contains only the reviewed change; base SHA recorded.
2. `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm guards`,
   `pnpm audit --audit-level=high` (only the documented ignores), `pnpm test`, `pnpm build`.
3. For migrations: journal, file-byte hashes, runbook Appendix A and pinned counts agree;
   fresh-chain and upgrade rehearsals on disposable databases.
4. Secret scans clean on HEAD and on the branch diff.
5. An independent review with no unresolved blocking finding.
6. GitHub CI on the PR — or, for a direct milestone push, on the pushed commit: every check
   (`ci` and `direct-push-audit`) completed and passed. Pending, cancelled, skipped or not
   started is not passed. A flaky failure is reported and its cause named, even after a green
   rerun. For a direct push this gate is checked after the push; a failure is reported at once
   and fixed forward with a new commit, never by force-push.
