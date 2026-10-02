import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyseRoute, analyseServerActions } from './require-permission-first.test';
import {
  CreatePipelineSchema,
  CreatePipelineStageSchema,
  ListPipelinesQuerySchema,
  MoveDealToStageSchema,
  UpdatePipelineSchema,
  UpdatePipelineStageSchema,
} from '@/lib/crm/schema';

/**
 * Phase 3 — sales pipeline guards.
 *
 * DRAFT CONTRACT — the API surface below is drafted against
 * phase3-execution-plan.md §API Endpoints (draft) plus the Phase 2 conventions
 * (withPermission routes, requirePermission-first server actions,
 * src/lib/crm/schema.ts zod boundary, softDeleteRow(), assertTargetAffected
 * NOT_FOUND concealment). Reconcile file paths, action names and zod export
 * names against the API Engineer's published contract before running. Every
 * provisional name is marked PROVISIONAL.
 *
 * The DATABASE-facing assertions are reconciled against the published
 * drizzle/0037_sales_pipeline.sql: permission keys, the 42501 pipeline_id
 * immutability trigger, the org-guard triggers, the #RRGGBB color CHECK, the
 * 0–100 probability CHECK, blank-name CHECKs, no runtime delete path for
 * stages, and — critically — the fact that the DB does NOT constrain a
 * deal's stage to its pipeline, so moveDealToStage's cross-pipeline 400 is
 * the service's sole enforcement point.
 *
 * Source-text heuristics in the style of tests/guards/crm-api.test.ts, plus
 * unit checks on the zod boundary. They lock in the contract the UI builds
 * against:
 *
 *  1. the service takes an Authorization only requirePermission() can issue, as
 *     its first parameter, and reaches Postgres only through withAuthorizedDb()
 *  2. every route handler is built as withPermission(...) — which is what
 *     answers 401 unauthenticated, 403 on wrong permission / origin mismatch,
 *     and hands NOT_FOUND concealment to the service layer
 *  3. every server action awaits requirePermission() first, with the right
 *     pipelines.* / pipeline_stages.* / deals.* key
 *  4. no hard delete anywhere; pipeline soft delete is deleted_at = now() only
 *     (via softDeleteRow()), never cleared
 *  5. created_by/updated_by are never written — the trigger owns them
 *  6. org_id never comes from client input; pipeline_id on deals is immutable
 *     in the service (the DB trigger is the backstop)
 *  7. moveDealToStage validates the stage belongs to the deal's pipeline —
 *     a cross-pipeline stage is INVALID_REQUEST (400), not a silent move
 *  8. untrusted input is zod-validated before any query; limits are capped at 100
 */

const SERVICE_FILE = 'src/lib/crm/pipelines.ts';
const ACTION_FILE = 'src/app/(app)/crm/pipelines/_actions.ts';
// Route paths as implemented (reconciled 2026-10-01: the stage route is
// `pipeline-stages/[stageId]`, not the draft `stages/[stageId]`).
const ROUTE_FILES = [
  'src/app/api/crm/pipelines/route.ts', // GET list · POST create
  'src/app/api/crm/pipelines/[id]/route.ts', // GET · PATCH · DELETE
  'src/app/api/crm/pipelines/[id]/stages/route.ts', // GET · POST
  'src/app/api/crm/pipeline-stages/[stageId]/route.ts', // PATCH only (no DELETE: append-only)
  'src/app/api/crm/deals/[id]/move/route.ts', // POST moveDealToStage
  'src/app/api/crm/pipelines/[id]/forecast/route.ts', // GET forecast
  'src/app/api/crm/pipelines/[id]/velocity/route.ts', // GET velocity
] as const;

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const read = (file: string) => readFileSync(file, 'utf8');

/** The source of one exported function, cut out of a module. */
function fnBody(code: string, name: string): string {
  const start = code.indexOf(`function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = code.slice(code.indexOf('{', start));
  const nextExport = rest.search(/\nexport\s+async\s+function/);
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
}

/** The source of one exported server action, cut out of the actions file. */
function actionBody(code: string, name: string): string {
  const start = code.indexOf(`function ${name}`);
  expect(start, `${name} not found in actions.ts`).toBeGreaterThan(-1);
  const rest = code.slice(code.indexOf('{', start));
  const nextExport = rest.search(/\nexport\s+async\s+function/);
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
}

describe('pipelines service reaches Postgres only through withAuthorizedDb()', () => {
  it('imports withAuthorizedDb and nothing that bypasses it', () => {
    const code = stripComments(read(SERVICE_FILE));
    expect(code).toMatch(/from '@\/lib\/db\/authorized'/);
    expect(code).not.toMatch(/from '@\/lib\/db\/pool'/);
    expect(code).not.toMatch(/from '@\/lib\/db\/auth-client'/);
    expect(code).not.toMatch(/pool\.connect\(/);
  });

  it('every exported function takes Authorization first', () => {
    const code = stripComments(read(SERVICE_FILE));
    const fns = [...code.matchAll(/export\s+async\s+function\s+(\w+)\s*\(([^)]*)\)/g)];
    expect(fns.length).toBeGreaterThan(0);
    for (const [, name, params] of fns) {
      expect((params ?? '').trim(), name).toMatch(/^auth:\s*Authorization/);
    }
  });

  it('validates untrusted input with a zod schema before querying', () => {
    const code = stripComments(read(SERVICE_FILE));
    for (const schema of [
      'CreatePipelineSchema',
      'UpdatePipelineSchema',
      'CreatePipelineStageSchema',
      'UpdatePipelineStageSchema',
      'MoveDealToStageSchema',
      'ListPipelinesQuerySchema',
    ]) {
      expect(code, schema).toMatch(new RegExp(`${schema}\\.parse\\(`));
    }
  });

  it('no hard DELETE, and deleted_at is set but never cleared', () => {
    const code = stripComments(read(SERVICE_FILE));
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/deleted_at\s*=\s*null/i);
    // Soft deletes go through softDeleteRow() (src/lib/crm/soft-delete.ts),
    // which enforces the UPDATE policy as app_user and then calls the
    // SECURITY DEFINER public.crm_soft_delete(). A plain
    // UPDATE ... SET deleted_at = now() fails 42501, so the service must not
    // set deleted_at directly; the clock is stamped inside crm_soft_delete().
    expect(code).toMatch(/\bsoftDeleteRow\s*\(/);
    expect(code).not.toMatch(/deleted_at\s*=\s*now\(\)/i);
    // 0037 (confirmed): stages have no deleted_at and `revoke delete` covers
    // all three tables — there is NO runtime delete path for stages at all.
    // If the API surface keeps DELETE /api/crm/stages/:stageId, it needs a
    // SECURITY DEFINER function or the route must go; a raw
    // `delete from pipeline_stages` as app_user fails 42501 at runtime, and
    // this test fails the build first.
  });

  it('never writes created_by/updated_by or client-supplied identity', () => {
    const code = stripComments(read(SERVICE_FILE));
    expect(code).not.toMatch(/created_by/);
    expect(code).not.toMatch(/updated_by/);
    expect(code).not.toMatch(/\bdata\.(orgId|org_id)\b/);
    expect(code).not.toMatch(/\binput\.(orgId|org_id)\b/);
    expect(code).toMatch(/auth\.ctx\.personId/);
    expect(code).toMatch(/auth\.ctx\.orgId/);
  });

  it('deals.pipeline_id is immutable in the service: the update path never sets it', () => {
    // The DB trigger raises on pipeline_id change; the service must not offer
    // a second path. The only writer of pipeline_id is deal creation.
    const code = stripComments(read(SERVICE_FILE));
    const moveNames = [...code.matchAll(/export\s+async\s+function\s+(\w*[Mm]ove\w*)\s*\(/g)].map(
      (m) => m[1] as string,
    );
    expect(moveNames.length, 'exactly one move function').toBe(1);
    const moveBody = fnBody(code, moveNames[0]!);
    expect(moveBody).not.toMatch(/pipeline_id\s*=/);
    expect(moveBody).not.toMatch(/pipelineId/);
  });

  it('moveDealToStage validates the stage belongs to the deal’s pipeline', () => {
    // A stage from a DIFFERENT pipeline must fail closed with INVALID_REQUEST
    // (400) — never a silent cross-pipeline move. 0037 deliberately leaves
    // this OUT of the database: deals.pipeline_stage_id is a single-column
    // FK and deals_pipeline_org_guard() only checks the stage's ORG, so a
    // same-org/different-pipeline stage succeeds at the DB level (pinned by
    // tests/db/crm-pipelines.test.ts). The service check is the SOLE
    // enforcement point.
    const code = stripComments(read(SERVICE_FILE));
    const moveNames = [...code.matchAll(/export\s+async\s+function\s+(\w*[Mm]ove\w*)\s*\(/g)].map(
      (m) => m[1] as string,
    );
    expect(moveNames.length).toBe(1);
    const moveBody = fnBody(code, moveNames[0]!);
    expect(moveBody, 'compares the stage’s pipeline with the deal’s').toMatch(/pipeline_id/);
    expect(moveBody, 'rejects the mismatch as a 400').toMatch(
      /INVALID_REQUEST|invalidRequestResponse|400/,
    );
  });

  it('cross-org pipeline/stage reads fail closed with NOT_FOUND concealment', () => {
    // The service never answers "exists but is another tenant's": invisible
    // records — missing, deleted, or cross-org — collapse to NOT_FOUND via
    // assertTargetAffected (the same primitive the CRM core services use).
    const code = stripComments(read(SERVICE_FILE));
    expect(code).toMatch(/assertTargetAffected/);
  });
});

describe('pipelines entry points authorize first', () => {
  it('every pipeline server action awaits requirePermission() as its first statement', () => {
    const problems = analyseServerActions(read(ACTION_FILE)).filter((p) =>
      /[Pp]ipeline|[Ss]tage|moveDeal/.test(p),
    );
    expect(problems).toEqual([]);
  });

  // Action names as implemented (reconciled 2026-10-01). There is deliberately
  // no deletePipelineStageAction (the API 400s stage deletes by design) and no
  // moveDealToStageAction (the Kanban calls POST /api/crm/deals/:id/move via
  // fetch to distinguish 400/403/404 for toasts; the route is gated on
  // deals.edit and tested below).
  it.each([
    ['listPipelinesAction', 'pipelines.view'],
    ['getPipelineAction', 'pipelines.view'],
    ['createPipelineAction', 'pipelines.create'],
    ['updatePipelineAction', 'pipelines.edit'],
    ['deletePipelineAction', 'pipelines.delete'],
    ['listStagesAction', 'pipelines.view'],
    ['createStageAction', 'pipeline_stages.manage'],
    ['updateStageAction', 'pipeline_stages.manage'],
    ['getForecastAction', 'pipelines.view'],
    ['getVelocityAction', 'pipelines.view'],
    ['listBoardDealsAction', 'deals.view'],
  ] as const)('%s gates on %s', (name, permission) => {
    const body = actionBody(stripComments(read(ACTION_FILE)), name);
    // The permission may appear as a string literal or as the
    // PIPELINE_STAGES_MANAGE constant (which equals 'pipeline_stages.manage').
    const pattern =
      permission === 'pipeline_stages.manage'
        ? /permission:\s*(?:'pipeline_stages\.manage'|PIPELINE_STAGES_MANAGE)/
        : new RegExp(`permission:\\s*'${permission}'`);
    expect(body).toMatch(pattern);
  });

  it('pipeline actions validate ids as UUIDs at the boundary', () => {
    const code = stripComments(read(ACTION_FILE));
    for (const name of [
      'getPipelineAction',
      'updatePipelineAction',
      'deletePipelineAction',
      'listStagesAction',
      'createStageAction',
      'updateStageAction',
      'getForecastAction',
      'getVelocityAction',
    ]) {
      const body = actionBody(code, name);
      expect(body, `${name} parses its id as a UUID`).toMatch(/uuid\.parse\(/);
    }
  });

  it('every pipelines route handler is built as withPermission(...)', () => {
    for (const file of ROUTE_FILES) {
      expect(analyseRoute(read(file)), file).toEqual([]);
    }
  });

  it.each([
    ['src/app/api/crm/pipelines/route.ts', ['pipelines.create', 'pipelines.view']],
    [
      'src/app/api/crm/pipelines/[id]/route.ts',
      ['pipelines.delete', 'pipelines.edit', 'pipelines.view'],
    ],
    [
      'src/app/api/crm/pipelines/[id]/stages/route.ts',
      ['pipeline_stages.manage', 'pipelines.view'],
    ],
    ['src/app/api/crm/pipeline-stages/[stageId]/route.ts', ['pipeline_stages.manage']],
    ['src/app/api/crm/deals/[id]/move/route.ts', ['deals.edit']],
    ['src/app/api/crm/pipelines/[id]/forecast/route.ts', ['pipelines.view']],
    ['src/app/api/crm/pipelines/[id]/velocity/route.ts', ['pipelines.view']],
  ] as const)('%s gates on exactly %s', (file, permissions) => {
    const keys = [...stripComments(read(file)).matchAll(/permission:\s*'([^']+)'/g)].map(
      (m) => m[1] as string,
    );
    expect(keys.sort()).toEqual([...permissions].sort());
  });

  it('pipelines routes reject invalid input with 400, not the 500 envelope', () => {
    for (const file of ROUTE_FILES) {
      expect(stripComments(read(file)), file).toMatch(/invalidRequestResponse/);
    }
  });
});

describe('route auth semantics (401 / 403 / 404 / CSRF)', () => {
  it('unauthenticated requests are refused with 401 before any handler runs', () => {
    // withPermission() awaits requirePermission() before the handler; an
    // absent session throws UNAUTHENTICATED, which the STATUS map answers as
    // 401. Static lock: no route reaches the service without withPermission.
    for (const file of ROUTE_FILES) {
      expect(analyseRoute(read(file)), file).toEqual([]);
    }
    expect(read('src/lib/authz/http.ts')).toMatch(/requirePermission\(request\.headers/);
    const errors = read('src/lib/authz/errors.ts');
    expect(errors).toMatch(/UNAUTHENTICATED:\s*401/);
  });

  it('the wrong permission is a 403, and a cross-org id is a 404 (concealment)', () => {
    // The permission-key table above pins the 403 side (requirePermission
    // answers PERMISSION_DENIED/SCOPE_DENIED as 403). The 404 side is the
    // service's assertTargetAffected: a write/read that touches nothing — a
    // missing, deleted, or another tenant's id — is concealed as NOT_FOUND.
    const errors = read('src/lib/authz/errors.ts');
    expect(errors).toMatch(/FORBIDDEN:\s*403/);
    expect(errors).toMatch(/NOT_FOUND:\s*404/);
    expect(stripComments(read(SERVICE_FILE))).toMatch(/assertTargetAffected/);
  });

  it('state-changing routes inherit the CSRF origin check from withPermission', () => {
    // Threat T-17: withPermission() refuses a state-changing request whose
    // Origin mismatches APP_URL with FORBIDDEN (403) before anything else
    // runs. Every pipeline route is withPermission-built, so the check needs
    // no per-route code — this test pins the shared enforcement instead.
    const http = read('src/lib/authz/http.ts');
    expect(http).toMatch(/STATE_CHANGING/);
    expect(http).toMatch(/originMatches\(request\)/);
    expect(http).toMatch(/ORIGIN_MISMATCH/);
    expect(http).toMatch(/new AuthorizationError\('FORBIDDEN'/);
    for (const file of ROUTE_FILES) {
      expect(analyseRoute(read(file)), file).toEqual([]);
    }
  });
});

describe('pipelines validation boundary', () => {
  it('pipeline creates need a non-blank name; description and isDefault are optional', () => {
    expect(CreatePipelineSchema.safeParse({ name: 'Enterprise' }).success).toBe(true);
    expect(CreatePipelineSchema.parse({ name: 'Enterprise' }).isDefault).toBe(false);
    expect(
      CreatePipelineSchema.safeParse({ name: 'SMB', description: 'Mid-market', isDefault: true })
        .success,
    ).toBe(true);
    expect(CreatePipelineSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(CreatePipelineSchema.safeParse({}).success).toBe(false);
    expect(CreatePipelineSchema.safeParse({ name: 'x'.repeat(1001) }).success).toBe(false);
  });

  it('pipeline updates need at least one field and reject unknown keys (strict)', () => {
    expect(UpdatePipelineSchema.safeParse({}).success).toBe(false);
    expect(UpdatePipelineSchema.safeParse({ name: 'New name' }).success).toBe(true);
    expect(UpdatePipelineSchema.safeParse({ isDefault: true }).success).toBe(true);
    expect(UpdatePipelineSchema.safeParse({ name: 'New', orgId: 'x' }).success).toBe(false);
  });

  it('stage probability is confined to 0–100 and defaults to 0', () => {
    const base = { name: 'Discovery', pipelineId: '123e4567-e89b-12d3-a456-426614174000' };
    expect(CreatePipelineStageSchema.parse(base).probability).toBe(0);
    expect(CreatePipelineStageSchema.safeParse({ ...base, probability: 100 }).success).toBe(true);
    expect(CreatePipelineStageSchema.safeParse({ ...base, probability: 50.25 }).success).toBe(true);
    expect(CreatePipelineStageSchema.safeParse({ ...base, probability: 101 }).success).toBe(false);
    expect(CreatePipelineStageSchema.safeParse({ ...base, probability: -1 }).success).toBe(false);
  });

  it('stage color accepts #RRGGBB hex or null, nothing else', () => {
    const base = { name: 'Discovery', pipelineId: '123e4567-e89b-12d3-a456-426614174000' };
    expect(CreatePipelineStageSchema.safeParse({ ...base, color: '#1a2b3c' }).success).toBe(true);
    expect(CreatePipelineStageSchema.safeParse({ ...base, color: null }).success).toBe(true);
    expect(CreatePipelineStageSchema.safeParse({ ...base }).success).toBe(true);
    expect(CreatePipelineStageSchema.safeParse({ ...base, color: 'red' }).success).toBe(false);
    expect(CreatePipelineStageSchema.safeParse({ ...base, color: '#fff' }).success).toBe(false);
  });

  it('stage won/lost flags default to false', () => {
    const base = { name: 'Closed', pipelineId: '123e4567-e89b-12d3-a456-426614174000' };
    expect(CreatePipelineStageSchema.parse(base)).toMatchObject({ isWon: false, isLost: false });
  });

  it('stage creates need a pipeline id and a non-blank name', () => {
    const good = '123e4567-e89b-12d3-a456-426614174000';
    expect(
      CreatePipelineStageSchema.safeParse({ name: 'Discovery', pipelineId: good }).success,
    ).toBe(true);
    expect(CreatePipelineStageSchema.safeParse({ name: '   ', pipelineId: good }).success).toBe(
      false,
    );
    expect(CreatePipelineStageSchema.safeParse({ name: 'Discovery' }).success).toBe(false);
    expect(
      CreatePipelineStageSchema.safeParse({ name: 'Discovery', pipelineId: 'nope' }).success,
    ).toBe(false);
  });

  it('stage updates need at least one field and reject unknown keys (strict)', () => {
    expect(UpdatePipelineStageSchema.safeParse({}).success).toBe(false);
    expect(UpdatePipelineStageSchema.safeParse({ position: 2 }).success).toBe(true);
    expect(UpdatePipelineStageSchema.safeParse({ probability: 75 }).success).toBe(true);
    expect(UpdatePipelineStageSchema.safeParse({ probability: 101 }).success).toBe(false);
    expect(UpdatePipelineStageSchema.safeParse({ position: 2, pipelineId: 'x' }).success).toBe(
      false,
    );
  });

  it('moveDealToStage needs a valid stage UUID', () => {
    expect(
      MoveDealToStageSchema.safeParse({ stageId: '123e4567-e89b-12d3-a456-426614174000' }).success,
    ).toBe(true);
    expect(MoveDealToStageSchema.safeParse({ stageId: 'nope' }).success).toBe(false);
    expect(MoveDealToStageSchema.safeParse({}).success).toBe(false);
  });

  it('list queries default to 25 and cap at 100', () => {
    expect(ListPipelinesQuerySchema.parse({}).limit).toBe(25);
    expect(ListPipelinesQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ListPipelinesQuerySchema.parse({ search: 'ent' }).search).toBe('ent');
  });
});
