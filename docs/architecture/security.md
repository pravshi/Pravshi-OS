# PRAVSHI OS — Security Architecture, Permission Matrices & Threat Model

Companion to the [Master Blueprint](../superpowers/specs/2026-09-06-pravshi-os-master-blueprint.md).
**No code has been written; this is the design.**

---

## 1. Permission catalogue (V1)

`resource.action`, seeded by migration. Modules add rows; they never add authorization logic.

| Module | Permissions |
|---|---|
| Users & access | `users.view` `users.create` `users.edit` `users.suspend` `users.delete` `users.impersonate`* `sessions.revoke` |
| Roles & perms | `roles.view` `roles.manage` `permissions.view` `permissions.manage` |
| Org structure | `departments.view` `departments.manage` `teams.view` `teams.manage` |
| People | `people.view` `people.create` `people.edit` `people.archive` `people.export` |
| Sensitive HR | `hr.sensitive.view` `hr.sensitive.edit` (DOB, emergency contacts, ID documents) |
| Compensation | `compensation.view` `compensation.edit` |
| Engagements | `engagements.view` `engagements.create` `engagements.edit` `engagements.transition` |
| Hiring | `openings.*` `candidates.view` `candidates.create` `candidates.edit` `interviews.view` `interviews.schedule` `scorecards.create` `scorecards.view_all` `offers.create` `offers.approve` |
| Onboarding | `onboarding.view` `onboarding.manage` `onboarding.complete_task` |
| Offboarding | `offboarding.view` `offboarding.initiate` `offboarding.manage` |
| CRM | `companies.view` `companies.create` `companies.edit` `companies.delete` `contacts.view` `contacts.create` `contacts.edit` `contacts.delete` `contacts.export` `deals.view` `deals.create` `deals.edit` `deals.delete` `deals.export` `activities.view` `activities.create` `activities.edit` `activities.delete` `relationships.view` `relationships.create` `relationships.edit` `relationships.delete` `pipelines.view` `pipelines.create` `pipelines.edit` `pipelines.delete` `pipeline_stages.manage` |
| Legacy sales | `leads.view` `leads.create` `leads.edit` `leads.delete` `leads.assign` `leads.export` — retained in the catalogue but granted to no role since the CRM migration (0033); `clients.view` `clients.edit` remain granted only to non-CRM roles (project-management domain). `pipeline.manage` is catalogue-only. |
| Projects | `projects.view` `projects.create` `projects.edit` `projects.delete` `projects.manage_members` |
| Tasks | `tasks.view` `tasks.create` `tasks.edit` `tasks.assign` `tasks.delete` `tasks.comment` |
| Documents | `documents.view` `documents.upload` `documents.download` `documents.verify` `documents.delete` |
| Policies | `policies.view` `policies.manage` `policies.acknowledge` `policies.view_compliance` |
| Reports | `reports.view` `reports.export` |
| Audit | `audit_logs.view` `audit_logs.export` |
| Settings | `settings.view` `settings.manage` `integrations.manage` |

\* `users.impersonate` is **not implemented in V1**. Listed so it is never added casually — support
impersonation is a serious audit and consent question, not a convenience feature.

---

## 2. Permission matrix

**G** = GLOBAL · **D** = DEPARTMENT · **T** = TEAM · **P** = PROJECT · **S** = SELF · **—** = no access

| Permission | SUPER_ADMIN | ADMIN | HR_ADMIN | HR_MANAGER | MANAGER | SALES_MANAGER | SALES | PROJECT_MANAGER | DEVELOPER | VIBECODER | INTERN | FINANCE | EMPLOYEE |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `users.view` | G | G | G | D | — | — | — | — | — | — | — | — | — |
| `users.create` | G | G | G | — | — | — | — | — | — | — | — | — | — |
| `users.suspend` | G | G | D¹ | — | — | — | — | — | — | — | — | — | — |
| `sessions.revoke` | G | G | D¹ | — | — | — | — | — | — | — | — | — | — |
| `roles.manage` | G | — | — | — | — | — | — | — | — | — | — | — | — |
| `permissions.manage` | G | — | — | — | — | — | — | — | — | — | — | — | — |
| `departments.manage` | G | G | G | — | — | — | — | — | — | — | — | — | — |
| `people.view` | G | G | G | D | — | D² | S | D² | S | S | S | S | S |
| `people.edit` | G | G | G | D | — | — | S³ | — | S³ | S³ | S³ | S³ | S³ |
| `people.export` | G | G | G | — | — | — | — | — | — | — | — | — | — |
| `hr.sensitive.view` | G | — | G | D | — | — | — | — | — | — | S | — | S |
| `compensation.view` | G | — | G | — | — | — | — | — | — | — | — | G | S |
| `engagements.transition` | G | G | G | D | — | — | — | — | — | — | — | — | — |
| `candidates.view` | G | G | G | G | — | D | — | D | — | — | — | — | — |
| `scorecards.view_all` | G | — | G | G | — | D | — | D | — | — | — | — | — |
| `offers.approve` | G | G | G | — | — | — | — | — | — | — | — | — | — |
| `onboarding.manage` | G | G | G | D | — | D | — | D | — | — | — | — | — |
| `offboarding.initiate` | G | G | G | D | — | D | — | D | — | — | — | — | — |
| `companies.view` | G | G | — | — | — | D | S | — | — | — | — | — | — |
| `companies.create` | G | G | — | — | — | D | S | — | — | — | — | — | — |
| `companies.edit` | G | G | — | — | — | D | S | — | — | — | — | — | — |
| `companies.delete` | G | G | — | — | — | D | — | — | — | — | — | — | — |
| `contacts.view` | G | G | — | — | — | D | S | — | — | — | — | — | — |
| `contacts.create` | G | G | — | — | — | D | S | — | — | — | — | — | — |
| `contacts.edit` | G | G | — | — | — | D | S | — | — | — | — | — | — |
| `contacts.delete` | G | G | — | — | — | D | — | — | — | — | — | — | — |
| `contacts.export` | G | G | — | — | — | D | — | — | — | — | — | — | — |
| `deals.view` | G | G | — | — | — | D | S | — | — | — | — | — | — |
| `deals.create` | G | G | — | — | — | D | S | — | — | — | — | — | — |
| `deals.edit` | G | G | — | — | — | D | S | — | — | — | — | — | — |
| `deals.delete` | G | G | — | — | — | D | — | — | — | — | — | — | — |
| `deals.export` | G | G | — | — | — | D | — | — | — | — | — | — | — |
| `activities.view` | G | G | — | — | — | D | S | — | — | — | — | — | — |
| `activities.create` | G | G | — | — | — | D | S | — | — | — | — | — | — |
| `activities.edit` | G | G | — | — | — | D | S | — | — | — | — | — | — |
| `activities.delete` | G | G | — | — | — | D | — | — | — | — | — | — | — |
| `relationships.view` | G | G | — | — | — | D | S | — | — | — | — | — | — |
| `relationships.create` | G | G | — | — | — | D | S | — | — | — | — | — | — |
| `relationships.edit` | G | G | — | — | — | D | S | — | — | — | — | — | — |
| `relationships.delete` | G | G | — | — | — | D | — | — | — | — | — | — | — |
| `pipelines.view` | G | G | — | — | — | — | — | — | — | — | — | — | — |
| `pipelines.create` | G | G | — | — | — | — | — | — | — | — | — | — | — |
| `pipelines.edit` | G | G | — | — | — | — | — | — | — | — | — | — | — |
| `pipelines.delete` | G | G | — | — | — | — | — | — | — | — | — | — | — |
| `pipeline_stages.manage` | G | G | — | — | — | — | — | — | — | — | — | — | — |
| `clients.view` | G | — | — | — | — | — | — | D | P | P | P | G⁴ | — |
| `clients.edit` | G | — | — | — | — | — | — | D | — | — | — | — | — |
| `projects.view` | G | G | — | — | D | D | S | D | P | P | P | G⁴ | — |
| `projects.create` | G | G | — | — | D | D | — | D | — | — | — | — | — |
| `projects.edit` | G | G | — | — | D | D | — | D | P⁵ | — | — | — | — |
| `projects.manage_members` | G | G | — | — | — | D | — | D | — | — | — | — | — |
| `projects.delete` | G | G | — | — | — | — | — | — | — | — | — | — | — |
| `tasks.view` | G | G | — | — | D | D | S+P | D | P | P | S | — | S |
| `tasks.create` | G | G | — | — | D | D | S | D | P | P | S | — | S |
| `tasks.edit` | G | G | — | — | D | D | S+P | D | P | P | S⁶ | — | S⁶ |
| `tasks.assign` | G | G | — | — | — | D | — | D | P | — | — | — | — |
| `tasks.delete` | G | G | — | — | — | — | — | — | — | — | — | — | — |
| `documents.view` | G | G | G | D | — | D⁷ | S | D⁷ | S | S | S | G⁴ | S |
| `documents.upload` | G | G | G | D | — | D⁷ | S | D⁷ | S | S | S | G⁴ | S |
| `documents.download` | G | G | G | D | — | D⁷ | S | D⁷ | S | S | S | G⁴ | S |
| `documents.verify` | G | — | G | D | — | — | — | — | — | — | — | — | — |
| `policies.manage` | G | G | G | — | — | — | — | — | — | — | — | — | — |
| `policies.acknowledge` | S | S | S | S | S | S | S | S | S | S | S | S | S |
| `policies.view_compliance` | G | G | G | D | — | D | — | D | — | — | — | — | — |
| `reports.view` | G | G | G | D | — | D | S | D | P | — | — | G⁴ | — |
| `audit_logs.view` | G | G | — | — | — | — | — | — | — | — | — | — | — |
| `settings.manage` | G | G⁸ | — | — | — | — | — | — | — | — | — | — | — |

**Footnotes — these are where the real rules live:**

1. HR may suspend, but the **protected-role rule** (Blueprint §6.2) prevents HR acting on anyone
   holding `roles.manage`. HR cannot touch a SUPER_ADMIN. Enforced in SQL.
2. Directory-level fields only (name, title, department, work email, photo). Not HR data.
3. Own profile, and only the self-editable fields: preferred name, phone, photo, personal email,
   emergency contact. **Not** department, role, manager, title, or dates.
4. Finance sees commercial fields (project value, invoices, compensation) — **not** HR documents,
   not personal data, not CVs.
5. Developer may edit project fields only for projects where they are a member with a lead role.
6. Own tasks: status, notes, attachments. Not assignee, not due date.
7. Sales/PM see *business* documents scoped to their department (proposals, contracts, SOWs).
   Never `hr-documents`, which are gated by `access_level` regardless of this grant.
8. ADMIN manages operational settings. **Only SUPER_ADMIN touches security settings**
   (MFA policy, session lifetime, role definitions).

---

## 3. Data visibility matrix

What each role can *see at all*, independent of the action:

| Data domain | SUPER_ADMIN | ADMIN | HR | SALES_MGR | SALES | PM | DEVELOPER | VIBECODER | INTERN | FINANCE |
|---|---|---|---|---|---|---|---|---|---|---|
| Employee directory (name, dept, title) | Full | Full | Full | Full | Full | Full | Full | Full | Full | Full |
| Employee HR records | Full | **No** | Full | No | No | No | No | No | Own | No |
| Compensation | Full | **No** | Full | No | No | No | No | No | Own | Full |
| ID documents / DOB | Full | **No** | Full | No | No | No | No | No | Own | No |
| Candidates & CVs | Full | Full | Full | Own dept | No | Own dept | No | No | No | No |
| Interview scorecards | Full | No | Full | Own dept | No | Own dept | Own¹ | No | No | No |
| Sales leads | Full | Full | **No** | Dept | Own | No | No | No | No | No |
| Clients | Full | Full | No | Dept | Own | Dept | Assigned | Assigned | Assigned | Full² |
| Deal values / pipeline £ | Full | Full | No | Dept | Own | No | **No** | No | No | Full |
| Projects | Full | Full | No | Dept | Own | Dept | Assigned | Assigned | Assigned | Full² |
| Tasks | Full | Full | No | Dept | Own+Proj | Dept | Assigned | Assigned | Own | No |
| HR documents | Full | No | Full | No | Own | No | Own | Own | Own | No |
| Business documents | Full | Full | Dept | Dept | Own | Dept | Project | Project | Project | Full |
| Corporate/legal records | Full | Full | HR cat. | No | No | No | No | No | No | Fin. cat. |
| Policies | Full | Full | Full | Full | Full | Full | Full | Full | Full | Full |
| Compliance status (who acknowledged) | Full | Full | Full | Dept | No | Dept | No | No | No | No |
| Audit logs | Full | Full | **No** | No | No | No | No | No | No | No |
| System settings | Full | Partial | No | No | No | No | No | No | No | No |
| Other employees' salaries | Full | No | Full | No | No | No | No | No | No | Full |

1. A developer acting as an interviewer sees only their own scorecard until submission (Blueprint §11).
2. Finance sees commercial attributes of clients and projects, not the work content or team detail.

**The four assertions this matrix exists to guarantee**, each a named test in CI:

- **Sales cannot reach HR.** No sales role holds any `hr.*`, `people.edit` beyond self, or
  `compensation.*`.
- **HR cannot reach Finance or Sales pipeline.** HR holds no `leads.*`, no `compensation.edit` for
  non-HR-owned fields, and — deliberately — no `audit_logs.view`.
- **ADMIN is not a superset of HR.** An operational admin should not read identity documents. Only
  SUPER_ADMIN and HR do. This is intentional least privilege, and it will occasionally be
  inconvenient; that inconvenience is the control working.
- **Interns and vibecoders see only what they are assigned.** Everything is `SELF` or `PROJECT`;
  nothing is `DEPARTMENT` or `GLOBAL`.

---

## 4. Threat model

| ID | Threat | Risk | Mitigation | Test that proves it |
|---|---|---|---|---|
| **T-01** | Unauthorised account creation | **Critical** | **There is no signup route.** An account exists only where an admin issued an invitation; invitations are single-use, expiring and hashed at rest. When Google OAuth is added later, the callback links to an existing invitation or `people` row and refuses to create anything — plus an `hd` claim check | E2E: attempt account creation by every reachable path (direct POST to the auth endpoints included) → rejected, no `people` row, audit entry written |
| **T-02** | Broken access control on a new endpoint (developer forgets a check) | **Critical** | `requirePermission` as the first statement, enforced by lint rule; RLS backstop; CI permission matrix over every action | Integration: call every Server Action as every seeded role; assert the matrix |
| **T-03** | Privilege escalation — HR grants itself or a friend SUPER_ADMIN | **Critical** | Protected-role rule in SQL: granting a role with `roles.manage` requires holding it at GLOBAL; audited; alerts | SQL test: HR attempts to insert `person_roles(SUPER_ADMIN)` → policy violation |
| **T-04** | IDOR — an intern opens `/people/{ceo-id}` or fetches it via the API | **High** | RLS on every table; **404 not 403**; no client-side-only guards | E2E per role: direct-URL every forbidden entity, expect 404; API fetch, expect empty |
| **T-05** | Access retained after termination | **High** | Access derived from engagement status, re-read from the database on every query; sessions are rows, so deleting them ends access immediately. Since 2026-09-30 (ADR-004, migration 0032), a suspended person also cannot mint a FRESH session: `databaseHooks.session.create.before` refuses the mint via `authz.login_person_active()` for every session-creation path | Integration: offboard, then replay the still-valid session cookie → denied on the very next request; attempt a fresh login while suspended → 401, no session row minted |
| **T-06** | Stolen session token replayed | **High** | 1-hour access tokens + refresh rotation; MFA on privileged roles; `sessions.revoke`; login-event review | Manual + integration: revoke, then replay → denied |
| **T-07** | Existence disclosure via search or error messages | **Medium** | Search runs through the same RLS-protected queries; 404 for out-of-scope; generic error envelope; no row counts in errors | E2E: search a term matching only forbidden records → zero results |
| **T-08** | Malicious file upload | **Medium** | Private buckets; files never executed or rendered inline; content-type allowlist + size cap; random storage paths; `Content-Disposition: attachment`; strict CSP. **No AV scanning in V1 — accepted, documented gap** | Test: upload `.html`/`.svg` → rejected; download → attachment headers |
| **T-09** | Public storage bucket misconfiguration | **High** | Buckets created private by migration; no public policy anywhere | CI test: query storage config, assert zero public buckets |
| **T-10** | The application connects to Postgres with a role that bypasses RLS, so every policy silently does nothing | **Critical** | Runtime connects as `app_user` — not the owner, no `BYPASSRLS`; `FORCE ROW LEVEL SECURITY` on every table; the connection string never reaches the browser and is never `NEXT_PUBLIC_` | CI: assert `rolbypassrls = false`, that the role owns no tables, and that every table has RLS enabled **and** forced |
| **T-21** | Session context leaks between requests on a pooled connection | **High** | `SET LOCAL` inside an explicit transaction only — never session-scoped `SET`; all access through `withAuthorizedDb()` | Integration: interleave two users' requests on one pool; assert each sees only their own rows |
| **T-11** | Bulk exfiltration by an insider (export the whole CRM before leaving) | **Medium** | `*.export` is a separate permission held by few; rate-limited; high-severity audit entry; admin alert on volume | Test: export writes a `severity=HIGH` audit row; rate limit triggers |
| **T-12** | Audit log tampering | **High** | `revoke update, delete`; trigger raises on attempt; no application code path that updates the table | SQL test: SUPER_ADMIN attempts UPDATE → exception |
| **T-13** | Over-permissioned accounts accumulating over time | **Medium** | Least privilege defaults; `expires_at` on record grants; quarterly access-review report (Phase 8) | Report exists; review is a calendar item |
| **T-14** | Personal data exposure (DPDP Act 2023) | **High** | Data minimisation; `access_level` per document; every view/download audited; retention policy; counsel review | Audit coverage test; retention job test |
| **T-15** | SQL injection | **Medium** | Parameterised queries only; no string-built SQL; Zod validation | Lint rule + review; CodeQL |
| **T-16** | XSS | **Medium** | React escaping; `dangerouslySetInnerHTML` requires review; strict CSP without `unsafe-inline` | CSP header test; grep review |
| **T-17** | CSRF | **Low** | Server Actions carry framework CSRF protection; `SameSite=Lax` cookies; state-changing Route Handlers verify origin | E2E: cross-origin POST → rejected |
| **T-18** | Credential stuffing / brute force | **Medium** | Rate limiting on login and reset; 12-char minimum; breach-list check; lockout with alerting; optional Google OAuth later | Test: repeated failures → limited, audited |
| **T-19** | Supply-chain compromise via a dependency | **Medium** | Dependabot; `npm audit` in CI; lockfile committed; minimal dependency count | CI gate |
| **T-20** | Founder account loss (lost phone, no recovery) | **Medium** | Two SUPER_ADMIN accounts; MFA recovery codes stored offline; documented break-glass procedure | Documented in INCIDENT-RESPONSE.md; drill once |

**Deliberately accepted V1 gaps**, so nobody is surprised later: no malware scanning on uploads
(T-08); no automated deprovisioning in Google or GitHub (manual attestation, Blueprint §13); no
anomaly detection beyond denial-rate review; no field-level encryption above what Postgres provides
at rest; no formal penetration test until §37 recommendation 8 is funded.

---

## 5. Testing strategy

### 5.1 The permission harness is built in Phase 1, before any business module

It is the infrastructure that makes every later phase fast **and** safe. Skipping it means every
subsequent feature carries an unquantified access-control risk.

```
tests/
  authz/
    matrix.spec.ts        generated FROM the tables in §2 — the doc IS the test fixture
    scope-resolution.spec.ts
    protected-roles.spec.ts
  rls/
    *.sql                 pgTAP: raw SQL as app_user, with each seeded role's session context
  e2e/
    role-journeys/        one Playwright project per seeded role
    forbidden-urls.spec.ts
  security/
    no-public-buckets.spec.ts
    service-role-isolation.spec.ts
    headers.spec.ts
```

**Why the matrix in §2 is machine-readable:** the documentation and the test fixture are the same
artefact. A change to the matrix that isn't reflected in behaviour fails CI, and behaviour that
drifts from the matrix fails CI. Documentation that can go stale silently is worse than none.

### 5.2 The named assertions from the specification

| Assertion | Layer |
|---|---|
| Sales cannot access HR records | RLS + API + E2E |
| Intern cannot access Finance | RLS + API |
| Developer cannot access HR | RLS + API |
| HR cannot modify SUPER_ADMIN | SQL policy |
| Suspended users cannot log in | Auth + RLS |
| Offboarded users lose project access immediately | Integration |
| Direct URLs do not bypass scope | E2E |
| The API does not honour permissions the UI hid | Integration (UI bypassed entirely) |
| A user cannot discover a forbidden record through search | E2E |
| Audit logs cannot be modified by anyone | SQL |

### 5.3 CI gates (a PR cannot merge without all of these)

typecheck · lint (including the `requirePermission`-first rule) · unit · RLS suite · permission
matrix · E2E on the seeded roles · security regression · `npm audit` · migration linter
(every new table has RLS enabled).

---

## 6. Incident response outline

Written in full as `INCIDENT-RESPONSE.md` during Phase 8. The shape:

1. **Detect** — Sentry alert, denial-rate spike, or a report from a person.
2. **Contain** — suspend the account (delete its session rows, stamp `sessions_revoked_at`); if a key is
   suspected compromised, rotate it immediately; if data is leaving, disable export permissions.
3. **Assess** — one `audit_logs` query by `request_id`, `actor_person_id` or `entity_id` reconstructs
   exactly what was accessed. **This is the reason the audit design in Blueprint §19 is strict.**
4. **Notify** — founder always; affected individuals and any regulator per counsel's advice. Under
   the DPDP Act 2023 a personal-data breach carries notification obligations; **get legal advice on
   the specifics before you need it, not during**.
5. **Remediate** — fix, add the regression test, deploy.
6. **Review** — blameless write-up within a week; what control was missing, not who erred.

**Break-glass:** two SUPER_ADMIN accounts exist. Recovery codes live offline in a sealed envelope or
a password manager the founder controls. Never one.
