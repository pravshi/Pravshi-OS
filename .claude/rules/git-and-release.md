# Git workflow and release gates

Applies to every session. Source of truth for the branch model: [CONTRIBUTING.md](../../CONTRIBUTING.md).
GitHub enforces almost none of this (no branch protection, no required checks): it holds only
because it is followed.

## Branches and commits

- Branch from the verified current `origin/main` (`git fetch` first; record the SHA). Prefixes:
  `feature/*`, `fix/*`, `chore/*`, `docs/*`; `hotfix/*` only for a production incident.
- One reviewable concern per branch. Use a separate worktree when another branch is in use.
- Never commit to `main`, force-push, rebase or amend pushed commits, or rewrite shared history.
  Make a new commit instead.
- Stage files explicitly. Never stage `audit-output/`, scratch files, logs, `.env*`,
  `tsconfig.tsbuildinfo` changes or credentials.
- After committing, run `node scripts/guards/secret-scan.mjs` and
  `node scripts/guards/secret-scan.mjs --diff origin/main` (the scan reads HEAD). Fake
  connection strings in tests must use the allowed placeholder shape.

## Publishing

- Push or open a PR **only when explicitly authorized** for that branch. Push with an explicit
  refspec (`git push -u origin refs/heads/<b>:refs/heads/<b>`) — never a bare `git push`.
- Never merge (the founder merges), never enable auto-merge, never deploy, never change
  repository settings, permissions, secrets, billing or deployment configuration.
- A PR description separates **local evidence** from **GitHub CI results**, states what was not
  tested, and claims nothing about real Neon or production.

## Release gates (all must hold; a missing one is a failure, not a pass)

1. Clean tree; the diff contains only the reviewed change; base SHA recorded.
2. `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm guards`,
   `pnpm audit --audit-level=high` (only the documented ignores), `pnpm test`, `pnpm build`.
3. For migrations: journal, file-byte hashes, runbook Appendix A and pinned counts agree;
   fresh-chain and upgrade rehearsals on disposable databases.
4. Secret scans clean on HEAD and on the branch diff.
5. An independent review with no unresolved blocking finding.
6. GitHub CI on the PR: every check completed and passed. Pending, cancelled, skipped or not
   started is not passed. A flaky failure is reported and its cause named, even after a green
   rerun.
