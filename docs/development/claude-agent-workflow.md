# Working with Claude Code on Pravshi OS

How the lead Claude session, the project's specialist subagents and the founder divide the
work. The persistent instructions are in [CLAUDE.md](../../CLAUDE.md); focused rules are in
[`.claude/rules/`](../../.claude/rules/); the agents are in [`.claude/agents/`](../../.claude/agents/).

> **What this is and is not.** Instructions, rules and agent prompts shape behaviour; they are
> not security controls. The controls that are actually enforced are the database (separate
> logins, forced RLS, definer boundaries), the CI guards and human review. An agent's `tools`
> list narrows what it is offered, but every agent here can run `Bash`, which can write files —
> "read-only" agents are read-only by instruction. Hard enforcement (permission rules, hooks)
> is a separate proposal (see the end of this page).

## Coordination model

1. **The lead session** owns the plan, the scope, integration of every change and the final
   decision. It reads the subagents' reports and decides.
2. **Specialist subagents** work independently in their own context and return evidence —
   findings with file:line, commands and output — not opinions to be taken on trust.
3. **One owner per file or subsystem.** Coding changes are made by the lead (or one assigned
   worker) per file set. Subagents here do not edit repository files.
4. **Parallel edits** happen only with disjoint file ownership, or in separate Git worktrees
   (`git worktree add ../Pravshi-OS-<task> -b <branch> origin/main`). Two agents never edit the
   same file, and never another agent's branch or worktree.
5. **Independent review after implementation**, in a separate context: the reviewer did not
   write the change and reviews the actual diff against the actual base.
6. **The lead reconciles disagreements** with evidence (re-reading the code, running the test,
   a targeted experiment) — not by majority. Unresolved disagreements go to the founder.
7. **Only the founder** authorizes pushing, opening or merging PRs, deployments and any hosted
   database operation (each named target and operation separately).

## When to delegate and when to work directly

Work directly when the change is small, local and you already have the context — a single
file, a clear failing test, a doc correction.

Delegate when:

- an investigation is **independent** and would flood the lead's context (a full security
  audit of a subsystem, a migration-history review, a CI failure hunt);
- you want a **second, independent opinion** — always after implementing anything that touches
  security, tenancy, migrations or release;
- several **read-only** investigations can run in parallel on disjoint questions.

Do not delegate the decision itself, product questions (ask the founder), or edits to files
another task is changing.

## The six agents

| Agent | Use it for | Returns |
|---|---|---|
| `principal-architect` | Before substantial work: recover requirements from the repo, map affected modules, dependencies, open decisions | Baseline SHA, cited current state, ownership-sized plan, acceptance criteria, verification commands, risks |
| `security-auditor` | Auth, sessions, permissions, RLS, definer functions, roles/grants, tenant scoping, secrets | Findings with severity, file:line, attack path, evidence, fix direction, regression test; scope reviewed and not reviewed |
| `database-migration-auditor` | `drizzle/`, journal, runner, `roles.sql`, rollback scripts, runbook; history/hash/role questions | Journal/hash/runbook consistency table, findings, local-vs-hosted evidence separation, prepared (not run) hosted queries |
| `qa-reliability-engineer` | Failing, flaky or slow tests; worker and CI reliability | Symptom, reproduction, evidence vs hypotheses, root cause or "unexplained", proposed fix with a stress/regression test, full pass/fail/skip list |
| `independent-code-reviewer` | After implementation, before a PR | Findings by Blocking / Should fix / Nit with file:line; claims verified or not; never "approved" on trust |
| `release-gate-auditor` | Before asking for a merge; after a merge | Gate table (CI per check, local evidence, migrations, secrets, review) and a ready / not-ready verdict |

All six run with `Read, Grep, Glob, Bash` and are instructed not to modify the repository.

## Typical flow for a change

1. Lead: establish state (`git fetch`; `origin/main` SHA; worktrees; clean tree).
2. `principal-architect`: plan and acceptance criteria (for substantial work).
3. Lead: create the branch (or worktree), implement in small commits, add regression tests,
   run the gates (`.claude/rules/git-and-release.md`).
4. In parallel, independently: `independent-code-reviewer` on the full diff, plus
   `security-auditor` and/or `database-migration-auditor` when their areas are touched.
5. Lead: fix findings, re-run affected tests, review the full diff and docs, commit.
6. `release-gate-auditor`: confirm the gates; the lead reports to the founder with the standard
   report and waits for approval to push, open a PR or merge.

## Checking that the setup is loaded

- Start Claude Code from the repository root (or a worktree of it).
- Run `/agents`: the six project agents should be listed (alongside any personal agents). If one
  is missing, check its frontmatter (`name`, `description`, `tools`) and that the file is under
  `.claude/agents/` with a `.md` extension.
- Run `/memory` to see which instruction files are loaded. `CLAUDE.md` and the rule without
  `paths` (`git-and-release.md`) load at start; the path-scoped rules load when Claude works
  with matching files (e.g. reading anything under `drizzle/` brings in
  `database-migrations.md`).
- A quick behavioural check: ask "Which agent should review a change to drizzle/0076?" and
  confirm the answer names `database-migration-auditor`; ask for a release check on an open PR
  and confirm `release-gate-auditor` reports pending checks as not passed.

## Example prompts

**Audit (read-only):**

> Use the security-auditor agent to audit tenant isolation in `src/lib/integrations/` and the
> migrations that define its tables and definer functions, against current origin/main. Report
> findings with severity, file:line, attack path and a regression test for each. Do not edit
> anything or touch any hosted database.

**Feature implementation:**

> Plan first: use principal-architect to map what the Sales Sheet import needs from the approved
> requirements and the current CRM, with acceptance criteria. Then implement on a new
> `feature/` branch from current origin/main, add the forbidden-case and failure tests, run the
> gates, and get independent-code-reviewer and security-auditor reviews of the full diff. Fix
> their findings, commit locally, and stop for my approval before pushing.

**Release review:**

> Use release-gate-auditor on PR #<n>: verify the head SHA, every GitHub check run, the local
> evidence in the description, migration/journal/runbook consistency and the secret scans.
> Report pending or unstarted checks as not passed. Do not merge or rerun anything.

## Optional: agent teams (experimental — not enabled)

Claude Code has an experimental mode in which several agent sessions coordinate as a team
(opt-in through the `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` environment variable). It is **not
enabled** in this repository and no setting turns it on.

It may help for genuinely independent, parallel investigations or cross-layer work (for example
a database review, an API review and a UI review of one feature at the same time). It also costs
considerably more tokens and adds coordination and session-management risk: more agents acting,
more state to reconcile, more chances of overlapping edits.

If you want to try it, opt in **for one session only**, in that shell, after the subagents above
are working:

```bash
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude
```

and keep the same rules: one owner per file set (or separate worktrees), independent review,
the lead decides, the founder approves anything published or any hosted database operation.
Do not add the variable to project or global settings without a separate decision.

## Proposed hard controls (not implemented)

These would turn some prose rules into enforced ones; each needs its own review:

- Permission rules in `.claude/settings.json` denying `git push` without an explicit refspec,
  `git push --force`, `gh pr merge` and `gh pr create` unless approved in the session.
- A `PreToolUse` hook that blocks Bash commands containing hosted database hosts
  (`*.neon.tech`) or `scripts/db/roles.sql`, and asks for confirmation instead.
- Removing `Bash` from the reviewer agents in favour of a narrowly allowed set of read-only git
  commands, once the permission syntax for that is verified.
