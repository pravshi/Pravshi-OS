# ADR-001: Credential reset refused on protected-role targets for unprivileged callers

Status: Accepted | Date: 2026-09-29 | Deciders: Nani

## Context

The following are CONFIRMED in the repo at this writing (see citations); they are
the facts this decision rests on.

- `adminResetCredential()` (`src/lib/admin/credential-reset.ts`) authorized the
  CALLER via `requirePermission({ permission: 'users.edit' })` in the server
  action, but never examined the TARGET. If `users.edit` were ever granted to a
  non-SUPER_ADMIN role, that holder could reset any SUPER_ADMIN's credential — a
  latent account takeover. CONFIRMED by reading the service: the only target
  checks were existence (`Person not found.`) and login presence (`This person
  has no login.`).
- "Protected role" has a precise database meaning. `public.role_is_protected()`
  (`drizzle/0008_roles_and_permissions.sql:261`) returns true for the explicit
  `is_protected` flag OR for a role carrying `roles.manage` /
  `permissions.manage` — "protection follows the capability, not the label", so
  an unflagged role cannot become an escape hatch.
- "May manage protected roles" has a precise database meaning.
  `public.may_manage_protected_roles()` (`drizzle/0008_roles_and_permissions.sql:310`)
  is the blueprint 6.2 test: the actor holds `roles.manage` at GLOBAL scope in
  the organization with a live engagement. Its branch 1 is exactly what
  `authz.scope_for('roles.manage') = 'GLOBAL'` answers from the application
  (`authz.scope_for()` is SECURITY DEFINER and returns NULL when the actor's
  engagement is not live).
- The application cannot ask the question with a plain join. `app_user`'s RLS
  view of `roles`, `role_permissions` and `person_roles` is deliberately
  self-only (migration 0008 policies `roles_select_mine`,
  `role_permissions_select_mine`, `person_roles_select_self`). A join written in
  the application would see none of the target's assignments and conclude "not
  protected" — failing OPEN, exactly the failure the SECURITY DEFINER
  `role_is_protected()` exists to prevent (0008: "a caller who could see no
  grants would conclude 'not protected', which fails OPEN. Running as the owner
  removes that possibility entirely").

## Decision

Refuse an admin credential reset when the TARGET holds a protected role unless
the CALLER may manage protected roles (Nani-approved policy):

1. New migration `drizzle/0027_credential_reset_protected_target.sql` adds
   `public.person_holds_protected_role(p_person_id, p_org_id)`: a SECURITY
   DEFINER, schema-pinned (`set search_path = ''`) function, revoked from
   PUBLIC and granted to `app_user` only — the same posture as
   `set_person_roles()` (0021), the other app-callable definer function that
   stands in front of a protected-role decision. It answers through
   `role_is_protected()`, counting only live assignments (unexpired, active
   role, not soft-deleted) in the given organization. It answers one fact and
   makes no decision.
2. `adminResetCredential()` asks that question about the target and
   `authz.scope_for('roles.manage') = 'GLOBAL'` about the actor, in the same
   `withAuthorizedDb(auth.ctx, …)` query that resolves the target — same
   identity, same tenant, no new cross-tenant path.
3. When the target is protected and the actor may not manage protected roles,
   the service writes a HIGH-severity `DENIED` audit entry
   (`admin.credential_reset`, reason `PROTECTED_ROLE_TARGET`) — via
   `writeAuditEntry()`, which commits on its own so the evidence survives the
   refusal — and throws a clear error. SUPER_ADMIN callers (who pass the
   `roles.manage`-at-GLOBAL test) are unaffected, as are the existing
   `Person not found.` / `This person has no login.` errors and the HIGH
   `SUCCESS` audit.

## Rationale

- **Fail-closed on the target side.** The alternative — a join in the
  application — would be security theater: RLS hides other people's role
  assignments from `app_user`, so it would conclude "not protected" for exactly
  the targets the guard exists to protect. The definer function reads the truth
  as the owner, which is why the codebase built `role_is_protected()` that way
  in the first place.
- **No second authorization model.** The actor half reuses the existing
  `authz.scope_for()` primitive (branch 1 of `may_manage_protected_roles`);
  the genesis branch (an org with no holder at all) is unreachable from the
  application by construction. The service still never re-decides the caller's
  `users.edit` permission — `requirePermission()` owns that layer.
- **Denials are evidence.** A refused reset against a SUPER_ADMIN is precisely
  the event an audit trail must capture; the `DENIED` entry carries the actor,
  the target, and the reason.

## Consequences

- A future role granted `users.edit` without `roles.manage` can reset ordinary
  users' credentials but is refused — loudly, and on the record — for
  SUPER_ADMINs and any holder of a capability-carrying role.
- Granting `roles.manage` at GLOBAL to a role remains the single, audited path
  to full credential-reset power; the protected-role triggers (0008, 0021)
  continue to guard that grant itself.
- New migration 0027 must run wherever the app runs (CI provisions it via the
  drizzle journal); the service degrades to a hard database error — not a
  silent pass — if the function is absent, because the guard query names it.

## Consistency

- **Least-privilege: narrowed, not widened.** The new function grants
  `app_user` exactly one boolean question about one person in one org — no
  write, no enumeration, no new permission. The `tests/db/roles-permissions.test.ts`
  invariant ("definer helpers must not be an app API") is untouched: that list
  names the trigger-facing helpers, and like `set_person_roles()` this function
  is deliberately the app-callable exception, granted to `app_user` only.
- **Tenant isolation: unchanged.** The guard runs inside
  `withAuthorizedDb(auth.ctx, …)` with the actor's identity; the target lookup
  keeps its `p.org_id = auth.ctx.orgId` filter, and
  `person_holds_protected_role()` takes the org as an explicit argument and
  matches `pr.org_id = p_org_id` — a person in another tenant never reads as
  protected (or unprotected) here.
