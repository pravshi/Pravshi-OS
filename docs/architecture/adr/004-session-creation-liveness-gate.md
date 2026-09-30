# ADR-004: Global session-creation liveness gate (suspended people cannot mint sessions)

Status: Accepted | Date: 2026-09-30 | Deciders: Nani

## Context

The following are CONFIRMED in the repo at this writing (see citations); they are
the facts this decision rests on.

- `suspendUser()` (`src/lib/admin/users.ts`) sets `person_status='INACTIVE'` and
  bumps `sessions_revoked_at`. Existing sessions are rejected because
  `resolve_auth_identity()` (`drizzle/0006_auth_identity.sql`) requires
  `person_status='ACTIVE'` and rejects sessions created before
  `sessions_revoked_at`. That covers sessions that already exist.
- Nothing stopped a suspended person from minting a FRESH session. `/api/auth/login`
  delegated credential verification to Better Auth, which knows nothing about
  people, person_status, or the authorization model. A suspended user whose
  password was still valid could sign in again and receive a brand-new session
  cookie — the suspension was a revolving door. CONFIRMED by code inspection
  2026-09-30 (R49 follow-up, BUG-002).
- A route-level fix would be bypassable. Better Auth's raw routes are exposed
  through `src/app/api/auth/[...all]/route.ts` (`/api/auth/sign-in/email` etc.),
  so checking liveness only in the mediated `/api/auth/login` route would leave
  every other session-minting path open.
- The single choke point every Better Auth session creation passes through is
  `databaseHooks.session.create.before` in the auth instance
  (`src/lib/auth/server.ts`). Returning `false` from that hook aborts the mint
  before a session row or cookie is produced.

## Decision

Enforce person liveness at the session-creation choke point, not at any route:

1. Migration 0032 (`drizzle/0032_login_person_active.sql`) installs
   `authz.login_person_active(uuid)`: SECURITY DEFINER, schema-pinned search
   path, returns false only when the login maps to a deleted or non-ACTIVE
   person. Revoked from public, executable by `app_user`. It fails CLOSED on
   database error or invalid input. A login with no person row (unprovisioned)
   returns true — `resolve_auth_identity()` handles the null case, and blocking
   here would break provisioning flows that mint sessions before the person
   exists (verified by `tests/auth/two-factor.test.ts`: "gives an enrolled login
   with no person nothing at all").
2. `src/lib/auth/login-person-check.ts` wraps the function call for the
   application, validating the UUID and failing closed on error.
3. `databaseHooks.session.create.before` (`src/lib/auth/server.ts`) now calls
   `loginPersonActive(session.userId)` for EVERY session mint — mediated login,
   MFA verification, raw Better Auth sign-in, and any future path. Deleted or
   INACTIVE persons get `false`: no session row, no cookie. Better Auth answers
   unauthorized, and the mediated routes keep their generic "Invalid email or
   password" semantics (no account-enumeration oracle).

## Consequences

- Suspension is now airtight in both directions: old sessions die at
  `resolve_auth_identity()`, and no new session can be minted while the person
  is INACTIVE. Unsuspending restores login without any other change — the gate
  is status-driven, verified by regression test.
- Every session creation pays one indexed `authz.login_person_active()` call
  (people by auth_user_id). This is the price of a bypass-proof gate; the
  alternative (route-level checks) was rejected as bypassable.
- Regression coverage: `tests/integration/auth-lifecycle-bugfixes.test.ts`
  (BUG-002 block) exercises the real `auth.api.signInEmail` path: active signs
  in, suspended gets 401 with no session row minted, reactivated signs in again.

## Alternatives considered

- **Check liveness in `/api/auth/login` only.** Rejected: raw Better Auth routes
  (`[...all]`) would still mint sessions for suspended users.
- **Check liveness in `resolve_auth_identity()` only.** That runs per-request on
  existing sessions; it cannot prevent the mint itself, and the refused login
  would still create a session row before being rejected downstream.
