# Platform console — security findings and risk decisions

The platform administrator console (ADR-008, migrations 0083–0086) had an independent code
review and a security audit in October 2026. This page gives the state of each finding the
founder asked to be resolved, with the regression test that holds it. The founder decides every
item marked "accepted".

| ID | Finding | State | Held by |
| -- | ------- | ----- | ------- |
| S-CONSOLE-1 | The database trusted the acting administrator from transaction settings | Fixed: `platform.current_admin()` requires a live aal2 session of that administrator's own login, named by id and the SHA-256 of its bearer token, within 12 h / 30 min | `tests/serial/platform-identity.test.ts` (identity) |
| S-CONSOLE-3 | A revoked administrator could still sign in and obtain a session | Fixed: the session-creation hook asks `platform.login_may_sign_in()`; revocation already ends every session | `tests/serial/platform-console.test.ts` (invites … revocation) |
| S-CONSOLE-6 | Platform session limits applied only on platform paths | Fixed: every Better Auth request carrying a session asks `platform.end_stale_admin_session()` first; tenant sessions are never touched | `platform-console.test.ts` ("Better Auth's own routes …") |
| S-CONSOLE-7 | The console's existence was observable | Partly fixed, rest accepted (below) | `tests/platform/gate-unconfigured.test.ts`, the tenant 404 test |
| S-CONSOLE-9 | Cross-site navigations extended the idle clock | Fixed: only state changes (Origin verified) and reads marked `Sec-Fetch-Site: same-origin` or `none` extend it | `platform-console.test.ts` ("only same-site activity …") |
| S-CONSOLE-10 | A re-issue could hand an unclaimed organization's first-administrator login to someone else | Restricted, residual accepted (below) | `platform-console.test.ts` ("recipient is fixed …") |
| F-CONSOLE-11 | A retried invitation after a lost answer was refused, its link lost | Fixed: invitations are idempotent by key; an unused invitation can be re-issued from the console | `platform-console.test.ts` (invites …; "never used can be re-issued") |
| S2-1 | The console re-issue let any `admins.manage` holder claim a stronger pending invitation | Fixed: only the inviter, while holding every permission it grants; anything else is the operator's | `platform-console.test.ts` ("never hands anyone more …") |
| S2-2 | A failing session check could log the session token (driver error carries parameters) | Fixed: fails closed with a fresh error; name and SQLSTATE only are logged | `tests/auth/platform-login-errors.test.ts` |

## S-CONSOLE-7 — what remains observable, and why it is accepted

Fixed: where `DATABASE_URL_PLATFORM` is not set, every gated console page and route —
`/platform/**` and `/api/platform/*` except the setup link's page and its completion route,
which need no session — answers the same 404 a tenant user gets, an administrator's request
included, never a 503 or an "unavailable" page. The setup page and route run on the
authentication login and refuse every token, as there are none to complete. A tenant user of any role gets 404 from every console route and
learns nothing about administrators, organizations or permissions.

Accepted: an anonymous request to `/api/platform/*` gets 401 and `/platform` redirects to sign
in, and the JSON 404 differs from the framework's HTML 404. Hiding these would break the
administrator's own sign-in redirect for no gain: the repository is public, so the routes are
known. What protects the console is authentication, the second factor and the database's
checks, not obscurity.

## S-CONSOLE-10 — what a re-issue can and cannot do

Restricted: a re-issue applies only to an ACTIVE organization whose first administrator has not
completed setup; it needs `platform.organizations.assign_initial_admin`, an aal2 session signed
in within the last 10 minutes, and is rate limited; it is audited with the acting
administrator and the recipient person. The recipient cannot change: the link creates a login
for the person's work email, and while setup is pending a database trigger refuses any change of
that email, by any runtime role (only the schema owner, through a migration, could disable
the trigger). No platform route can change it. A mistyped address is corrected by
provisioning again, not by editing the person.

Accepted residual: an administrator with that permission sees the new link and could use it
themselves, taking the unclaimed login. This is inherent while links are shown in the console.
The decision that removes it is N-2 (deliver setup links by email only), which is the founder's.
Until then, grant `assign_initial_admin` only to administrators trusted with every unclaimed
organization, and review `platform.organization.admin_setup_reissued` entries in the audit.

## Re-issuing an administrator's invitation (S2-1)

Whoever holds a setup link can claim that administrator's identity — the link proves no
ownership of the email. So the console re-issues an unused invitation only for the
administrator who sent it, and only while they still hold every permission it grants: a
re-issue never gives anyone more than an invitation of their own could. Every other case —
another administrator's invitation, one whose inviter is gone, one who already has a login —
is the operator's (`scripts/bootstrap/platform.mjs reissue-setup` or `recover`). Residual
until N-2: the inviter sees the new link and could use it themselves, which gives them nothing
beyond their own permissions.

## Sessions ended by the platform's limits (S2-4)

A session ended for being past the platform's limits is deleted without a login event or a
platform audit entry; the console simply asks the administrator to sign in again. Accepted: it
is the expected end of an idle session, not an attack signal. Revocations themselves are
audited.

## Still open

- N-2 (founder): setup links shown once in the console versus email-only delivery.
- D1 (hosting): rate limits key on `X-Forwarded-For`; their value depends on the host's trusted
  client-IP header. Per-administrator limits do not depend on it.
