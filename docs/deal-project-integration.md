# Deal ↔ Project integration contract (Phase 4)

The Deal → Project → Tasks seam: a CRM deal is delivered by exactly one work
project. `deal_id` lives on `work_projects` (nullable FK, SET NULL on deal
hard-delete). Everything below is the contract between the DB track, the API
track, the UI track, and the CRM track — this document, not code, is the
handshake point. Files created in this worktree are listed in §7.

## 1. Database contract (owned by the DB track)

Migration `drizzle/0042_work_management.sql`:

- `work_projects.deal_id uuid references public.deals (id) on delete set null`
- `work_projects_deal_org_guard()` BEFORE INSERT/UPDATE trigger: raises
  42501 (`deal_id must belong to the project's organization`) when the deal's
  org differs from NEW.org_id. The application re-checks first; the trigger is
  the backstop (42501 → 400, mapped in `linkProjectToDeal()`).
- `create index work_projects_deal_idx on public.work_projects (org_id, deal_id)`

### One-deal-one-project: application-level check (decision)

The "one deal → one project max" rule is enforced at the **application layer**
in `linkProjectToDeal()`: linking is rejected with 400 when another live
project in the org already holds the deal. Rationale: 0042 deliberately
carries no DB unique constraint on `deal_id`, and changing the migration is
the DB track's ownership; a partial unique index (`where deleted_at is null`)
is the recommended hard backstop and should be added by the DB track:

```sql
create unique index work_projects_deal_unique_per_org
  on public.work_projects (org_id, deal_id)
  where deleted_at is null;
```

Until that lands, the application check is the enforcement; the trigger and
the FK are already in place.

## 2. Service API (`src/lib/work/projects.ts`)

All functions take `(auth: Authorization, …)`; `org_id` always comes from
`auth.ctx.orgId`, never the caller.

| Function | Purpose |
| --- | --- |
| `linkProjectToDeal(auth, projectId, { dealId })` | Validate deal (live, same org; 400 `INVALID_REQUEST` otherwise), reject clash (400), UPDATE `deal_id`. Audits `project.deal_linked`. Returns `DealLinkSummary`. Relink overwrites. |
| `unlinkProjectFromDeal(auth, projectId)` | SET `deal_id = NULL` (idempotent). Audits `project.deal_unlinked`. |
| `getProjectDeal(auth, projectId)` | `DealLinkSummary \| null` — null when unlinked or the deal is gone. |
| `getProjectLinkedToDeal(auth, dealId)` | `ProjectLinkSummary \| null` — join is org-scoped both sides; a foreign/unknown deal yields null, disclosing nothing. |

Validation notes:

- The **project** being invisible follows the repo's concealment rule (404
  via `assertTargetAffected`).
- The **deal** being invisible is a 400 `INVALID_REQUEST: deal not found in
  your organization` (per the build spec) — actionable for a mistyped id,
  never disclosing deal details.
- `LinkDealSchema` validates the POST body (`{ dealId: uuid }`).
- The wire `Project` type now carries `dealId: string | null` (selected in
  `PROJECT_COLUMNS`, so `GET /api/work/projects/[id]` and list endpoints
  expose it without extra calls).
- Audit actions: `project.deal_linked`, `project.deal_unlinked`.

## 3. REST routes

| Route | Permission | Payloads |
| --- | --- | --- |
| `POST /api/work/projects/[id]/link-deal` | `projects.edit` | body `{ dealId }` → `200 { deal: DealLinkSummary }`; 400 malformed body, foreign/unknown deal, or deal-clash |
| `DELETE /api/work/projects/[id]/link-deal` | `projects.edit` | → `200 { ok: true }` (idempotent) |
| `GET /api/crm/deals/[id]/project` | `projects.view` | → `200 { project: ProjectLinkSummary \| null }` |

The CRM route pattern matches the CRM API track's structure
(`src/app/api/crm/deals/[id]/route.ts` in this worktree): `withPermission`,
zod uuid param parse, `invalidRequestResponse` mapping, `noStoreHeaders`.
**Permission choice:** the CRM route is gated on `projects.view`, not
`deals.view`, because the payload is a project. The deal detail page already
requires `deals.view`; the UI section must gate on BOTH.

## 4. UI integration points (no existing CRM file was modified)

### Project detail page → `LinkedDealSection`

Component: `src/components/work/linked-deal-section.tsx` (client).

Render on `/work/projects/[id]` after the header / edit block:

```tsx
import { LinkedDealSection } from '@/components/work/linked-deal-section';

<LinkedDealSection
  projectId={project.id}
  initialDeal={project.dealId ? await getProjectDealAction(project.id) : null}
  canEdit={canEditProject}
/>
```

- `canEdit` = the caller holds `projects.edit` (link/unlink buttons hide otherwise).
- `initialDeal` is optional; when omitted the section starts unlinked.
- The section calls the REST routes directly with `fetch` (same-origin
  credentials) — no server-action plumbing needed from the page.
- The deal search uses `GET /api/crm/deals?search=…&limit=10` (title prefix
  search); a caller without `deals.view` sees the API's error surfaced in the
  section's error line.

### Deal detail page → `RelatedProjectSection`

Component: `src/components/crm/related-project-section.tsx` (client,
display-only). The deal page itself is NOT modified by this track. To wire it,
add to `src/app/(app)/crm/deals/[id]/page.tsx` after the "Details" card:

```tsx
import { RelatedProjectSection } from '@/components/crm/related-project-section';

// in the page (server) component, after loading the deal:
const canViewProjects = held.has('projects.view'); // via getCrmPermissions()/getWorkPermissions()
const projectRes = canViewProjects ? await getProjectForDealAction(deal.id) : null;
// …
{canViewProjects && <RelatedProjectSection initialProject={projectRes} />}
```

where `getProjectForDealAction(id)` is a thin server action proxying
`GET /api/crm/deals/{id}/project` → `{ project }` (same pattern as the CRM
actions), returning `ProjectLinkSummary | null`.

## 5. Permission matrix

| Action | Key | Who holds it (migration 0042 grants) |
| --- | --- | --- |
| View linked deal / related project | `projects.view` | MANAGER (DEPARTMENT), ADMIN (GLOBAL), existing holders unchanged |
| Link / unlink a deal | `projects.edit` | MANAGER (DEPARTMENT), ADMIN (GLOBAL), existing holders unchanged |
| Search deals in the picker | `deals.view` | existing holders unchanged |

No new permission keys are introduced.

## 6. Types

- `DealLinkSummary` — `{ id, title, value, currency, stage: DealStage }`
- `ProjectLinkSummary` — `{ id, name, description, isArchived }`
- `Project` gains `dealId: string | null`
- `LinkDealSchema` / `LinkDealInput` — the POST body

## 7. Files created in this worktree

- `src/lib/work/schema.ts` — LinkDeal schema, `DealLinkSummary`,
  `ProjectLinkSummary`, `Project.dealId` (http.ts/errors.ts mirrored from the
  API track's work module for the self-contained pattern)
- `src/lib/work/projects.ts` — the four deal-link service functions
- `src/lib/work/http.ts`, `src/lib/work/errors.ts` — REST plumbing / pg-error
  introspection (same pattern as `src/lib/crm/http.ts`)
- `src/app/api/work/projects/[id]/link-deal/route.ts` — POST / DELETE
- `src/app/api/crm/deals/[id]/project/route.ts` — GET
- `src/components/work/linked-deal-section.tsx` — "Linked deal" UI block
- `src/components/crm/related-project-section.tsx` — "Related project" UI block
- this document
