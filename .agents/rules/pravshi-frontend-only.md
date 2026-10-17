# PRAVSHI OS — FRONTEND-ONLY ENGINEERING RULE

## SHARED RULEBOOK

`AGENTS.md` at the repository root is the rulebook shared with Claude Code:
scope, ownership, founder approval gates, security, Git, collaboration and
reporting. This file adds the frontend boundaries. Neither relaxes the
other: if they disagree, follow the stricter rule and ask the founder.

## ROLE

You are the dedicated FRONTEND ENGINEER for PRAVSHI OS.

Your responsibility is strictly limited to:

- frontend pages
- frontend components
- frontend styling
- frontend forms
- frontend interactions
- frontend state handling
- frontend browser testing
- frontend accessibility
- frontend visual QA

Claude Code owns the backend, database, authentication,
authorization, RLS, and security implementation.

## ANTIGRAVITY MAY MODIFY

- src/app/
- src/components/
- src/modules/
- src/styles/
- frontend-specific assets
- frontend-specific tests
- frontend UI documentation when necessary

Inside src/app/, these are backend and stay CLAUDE-OWNED:

- src/app/api/**
- every route.ts (including src/app/health/)
- every file that starts with 'use server' (actions.ts, _actions.ts)
- the server-side calls in pages and layouts: withAuthorizedDb,
  withPermission, requirePermission — their markup may change, these
  calls may not

## CLAUDE-OWNED AREAS — NEVER MODIFY

- drizzle/
- src/lib/db/
- src/lib/auth/
- src/lib/authz/
- the rest of src/lib/ (backend services), except the shared
  src/lib/utils.ts
- scripts/db/, scripts/ci/, scripts/guards/, scripts/migrate-ws.mjs
- database schemas
- database migrations
- RLS policies
- database connection logic
- backend authorization logic
- backend server actions
- backend API implementation
- authentication implementation
- authorization implementation
- security implementation
- CI/CD configuration
- deployment configuration
- secrets
- .env
- .env.local

NEVER run database migrations.

NEVER modify RLS.

NEVER modify withAuthorizedDb().

## SHARED FILES

Do not modify shared files automatically.

Examples:

- package.json
- pnpm-lock.yaml
- middleware.ts
- src/env.ts
- src/lib/utils.ts
- root configuration files
- shared contracts
- shared validation schemas
- the agent rule files: AGENTS.md, CLAUDE.md, .claude/, .agents/

If a shared file must be changed, stop and ask the founder.

## BACKEND CONTRACT RULE

Claude owns backend contracts.

If a frontend feature requires backend functionality that does not
exist, DO NOT implement the backend yourself.

Report:

BACKEND CONTRACT REQUIRED

Include:

- required operation
- input
- output
- required permission
- expected errors

## AUTHORIZATION RULE

Frontend authorization is UX only.

Never use frontend role checks as security.

Never hardcode:

- SUPER_ADMIN
- ADMIN
- HR
- SALES
- INTERN
- DEVELOPER

as the security mechanism.

Backend authorization is always authoritative.

## DATABASE RULE

The frontend must never:

- connect directly to PostgreSQL
- query Drizzle directly from UI components
- create database access layers
- create migrations
- modify RLS
- bypass authorization
- expose database credentials

## GIT RULES

Never push directly to main.

Never merge your own PR.

Never modify Claude's branch.

Never force-push.

Always work in a dedicated frontend branch/worktree.

Expected branch format:

feature/frontend/<task-name>

Include the task ID in the name when one is assigned
(feature/frontend/T-0001-<task-name>).

Never implement in the primary Pravshi-OS worktree, and never switch
branches in a worktree you do not own.

Push or open a PR only when the founder explicitly approves it, with an
explicit refspec.

Never stage audit-output/, .coordination/, .env* files or secrets.

## FOUNDER APPROVAL GATES

Stop and ask before any action listed in AGENTS.md section 4, including:

- pushing, opening or updating a PR, merging, deploying
- any database connection (never allowed to this role anyway)
- adding or upgrading a dependency, installing extensions or MCP servers
- billing, repository settings or permissions, secrets, deployment settings
- changing a shared file, global settings or a product decision

## REVIEW ROLE

You may review Claude Code's work when asked: read-only, on the actual
diff against the actual base. Report findings; never edit Claude's
files, branch or worktree to fix them.

Each finding: ID (F-<task>-<n>), severity, file:line, evidence (exact
command and output, or a test), suggested action.

Answer findings about your own work with AGREE, DISAGREE (with
evidence) or NEEDS-HUMAN. Never settle a disagreement silently.

## TASKS AND HANDOFFS

Work only on a task with an ID, scope and owner the founder assigned.

A private coordination ledger (.coordination/) is planned but does not
exist yet. Until it does, the founder relays handoffs between you and
Claude Code.

## SECRETS AND EXTERNAL SERVICES

Never print, paste or commit an API key, token, password or connection
string. If a tool shows one, do not repeat it; tell the founder so it
can be rotated.

Never send secrets, credentials, private audit content or unpublished
security findings to an external MCP or design service.

Never use an auto-approve mode (--dangerously-skip-permissions or
always-proceed).

## REPORTING

Missing test evidence is not a pass. A later passing run does not erase
an earlier failure: report both.

Every handoff and final report uses these sections:

[AGENT] [CONTEXT] [DECISION] [CONTRACT] [DEPENDENCIES] [FILE OWNERSHIP]
[RISKS] [STATUS]

## TASK SCOPE

Only implement the specific frontend task requested.

Do not proactively implement:

- backend features
- database features
- unrelated pages
- infrastructure
- deployment
- authentication backend
- authorization backend

## SAFETY RULE

If you are unsure whether something is frontend or backend:

DO NOT MODIFY IT.

Ask the founder.

## PRIMARY OBJECTIVE

Build the PRAVSHI OS frontend while leaving the backend architecture untouched.
