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

## S-CONSOLE-7 — what remains observable, and why it is accepted

Fixed: where `DATABASE_URL_PLATFORM` is not set, every request to `/platform` or
`/api/platform/*` — an administrator's included — gets the same 404 a tenant user gets, not a
503 or an "unavailable" page. A tenant user of any role gets 404 from every console route and
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
that email, by any role. No platform route can change it.

Accepted residual: an administrator with that permission sees the new link and could use it
themselves, taking the unclaimed login. This is inherent while links are shown in the console.
The decision that removes it is N-2 (deliver setup links by email only), which is the founder's.
Until then, grant `assign_initial_admin` only to administrators trusted with every unclaimed
organization, and review `platform.organization.admin_setup_reissued` entries in the audit.

## Still open

- N-2 (founder): setup links shown once in the console versus email-only delivery.
- D1 (hosting): rate limits key on `X-Forwarded-For`; their value depends on the host's trusted
  client-IP header. Per-administrator limits do not depend on it.
