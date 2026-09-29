# ADR-003: Login-failure alerting deferred to hardening phase

Status: Accepted | Date: 2026-09-29 | Deciders: Nani

## Context

The following are CONFIRMED in the repo at this writing (see citations); they are
the facts this decision rests on.

- Failed login attempts are recorded. The `/api/auth/login` route writes a
  `LOGIN_FAILURE` row on every failed attempt via `recordLoginEvent()` —
  CONFIRMED in `src/app/api/auth/login/route.ts` (records at the three failure
  paths) and `src/lib/auth/login-events.ts` (`recordLoginEvent()` calls
  `public.record_login_event()`; module docstring: "Every authentication outcome —
  success, failure, MFA challenge, MFA failure — is recorded"). The backing table
  is `public.login_events`, created by `drizzle/0018_invitations_and_login_events.sql`
  with a `login_events_type_format` CHECK vocabulary that includes `LOGIN_FAILURE`,
  append-only triggers (no UPDATE/DELETE), and RLS.
- Sign-in is throttled. Better Auth's `rateLimit` config in `src/lib/auth/server.ts`
  limits `/sign-in/email` to ten attempts per minute per address — CONFIRMED by the
  comment in `src/app/api/auth/login/route.ts`: "Rate limiting rides along with the
  delegated call: /sign-in/email is limited to ten attempts a minute per address."
- Account lockout is IN DEVELOPMENT, not yet in the codebase. Per Nani's approved
  plan it arrives via PR #26; the proposed `auth.login_lockouts` table does not
  exist in `drizzle/` or `src/` today, so this ADR treats lockout alerting as a
  future concern, not a CONFIRMED one.
- No alerting or notification infrastructure exists in Phase 1. There is no
  notify/alert/notification service under `src/lib/`; the only email paths are
  single-purpose transactional messages (password reset — `src/lib/auth/password-reset-email.ts`;
  invitations — `src/lib/invitations/email.ts`). There is no generic pipeline for
  security events.
- Admin visibility into failures already exists without alerting. Login events are
  exposed to admins through `src/lib/admin/audit.ts` (`queryLoginEvents()`, served
  by the `/admin/audit-logs` page and the `/api/admin/audit-logs` API — both
  CONFIRMED present under `src/app/`).

## Decision

Consciously defer user-facing and admin alerting on login failures (and on the
future PR #26 lockouts) to the hardening phase (Phase 10). Phase 1 ships no
"someone tried to log in to your account" emails, no admin lockout notifications,
and no brute-force alerting of any kind.

## Rationale

- **No alerting/notification pipeline in Phase 1.** Building alerting would mean
  designing, securing, and operating a new notification pipeline inside a phase
  that deliberately contains none.
- **Avoid unaudited, half-built alerting.** A partial implementation — e.g. email
  sent without rate-limiting, templating, or abuse review — would be a security
  feature that is itself an attack surface (email bombing, spoofing). It is safer
  to defer alerting than to ship a version that has not been hardened.
- **The data source is already captured.** Every failure is append-only-recorded
  in `login_events` with email, IP, user agent, and timestamp, so nothing is lost
  by deferring: Phase 10 alerting can query the same rows rather than requiring
  retroactive instrumentation.

## Consequences

- Phase 1 brute-force visibility is limited to admin review: an administrator with
  the `audit_logs.view` GLOBAL scope opens `/admin/audit-logs` (backed by
  `queryLoginEvents()` in `src/lib/admin/audit.ts`) to inspect recent failures.
  There is no proactive signal — nobody is paged, emailed, or pushed.
- Future query surface for Phase 10 alerting: `LOGIN_FAILURE` rows in
  `public.login_events` (CONFIRMED), plus the future lockout rows from PR #26's
  proposed `auth.login_lockouts` table (IN DEVELOPMENT). Any hardening-phase
  alerting design should consume these tables rather than inventing new ones.
- IDEA (not adopted): anomaly-based alerting (e.g. velocity thresholds per IP or
  email). Deferred with the rest; not a design commitment.

## Consistency

- **Least-privilege: no change.** This ADR adds no code, no new scopes, no new
  tables, and no new email pathways. The permission surface is untouched.
- **Tenant isolation: login events stay scoped exactly as designed.**
  `drizzle/0018_invitations_and_login_events.sql` defines the
  `login_events_select_global` RLS policy: `public.login_events` is readable only
  by the audit audience — `app_user` sessions where `authz.scope_for('audit_logs.view')
  = 'GLOBAL'` and the row's `org_id` matches the session's org. The migration
  comment is explicit: "login_events is readable by the audit audience and nobody
  else: the same GLOBAL holders as audit_logs.view. No SELF visibility — a person
  must not be able to check whether their own failed logins were noticed." In code,
  `src/lib/admin/audit.ts` exposes them solely through `queryLoginEvents()`, which
  runs through `withAuthorizedDb` (scope-enforced session) and filters
  `l.org_id = auth.ctx.orgId`. Alerting remains deferred precisely so these
  boundaries are not crossed casually: a Phase 10 design must not widen login-event
  visibility beyond the audit audience without a new, explicit decision.
