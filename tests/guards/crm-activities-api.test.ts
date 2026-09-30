import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyseRoute, analyseServerActions } from './require-permission-first.test';
import {
  ACTIVITY_ENTITY_TYPES,
  ACTIVITY_TYPES,
  ActivityEntityTypeSchema,
  ActivityTypeSchema,
  CreateActivitySchema,
  ListActivitiesQuerySchema,
  UpdateActivitySchema,
} from '@/lib/crm/schema';

/**
 * Phase 2 Track B — activities guards.
 *
 * Source-text heuristics in the style of tests/guards/crm-api.test.ts, plus unit
 * checks on the zod boundary. They lock in the contract the UI builds against:
 *
 *  1. the service takes an Authorization only requirePermission() can issue, as
 *     its first parameter, and reaches Postgres only through withAuthorizedDb()
 *  2. every exported server action and route handler authorizes first
 *     (requirePermission / withPermission), with the right activities.* key
 *  3. no hard delete anywhere; soft delete is deleted_at = now() only, never cleared
 *  4. created_by/updated_by are never written — the trigger owns them
 *  5. owner_person_id/org_id never come from client input
 *  6. the polymorphic (entity_type, entity_id) link is probed for visibility on
 *     create (A1) and is immutable on update — it never appears in an UPDATE set
 *  7. untrusted input is zod-validated before any query; limits are capped at 100
 */

const SERVICE_FILE = 'src/lib/crm/activities.ts';
const ACTION_FILE = 'src/app/(app)/crm/actions.ts';
const ROUTE_FILES = [
  'src/app/api/crm/activities/route.ts',
  'src/app/api/crm/activities/[id]/route.ts',
] as const;

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const read = (file: string) => readFileSync(file, 'utf8');

describe('activities service reaches Postgres only through withAuthorizedDb()', () => {
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
    expect(fns.length).toBe(5); // list/get/create/update/delete
    for (const [, name, params] of fns) {
      expect((params ?? '').trim(), name).toMatch(/^auth:\s*Authorization/);
    }
  });

  it('validates untrusted input with a zod schema before querying', () => {
    const code = stripComments(read(SERVICE_FILE));
    expect(code).toMatch(/ListActivitiesQuerySchema\.parse\(/);
    expect(code).toMatch(/CreateActivitySchema\.parse\(/);
    expect(code).toMatch(/UpdateActivitySchema\.parse\(/);
  });

  it('no hard DELETE, and deleted_at is set but never cleared', () => {
    const code = stripComments(read(SERVICE_FILE));
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/deleted_at\s*=\s*null/i);
    expect(code).toMatch(/deleted_at\s*=\s*now\(\)/i);
  });

  it('never writes created_by/updated_by or client-supplied identity', () => {
    const code = stripComments(read(SERVICE_FILE));
    expect(code).not.toMatch(/created_by/);
    expect(code).not.toMatch(/updated_by/);
    expect(code).not.toMatch(/\bdata\.(orgId|ownerPersonId)\b/);
    expect(code).not.toMatch(/\binput\.(orgId|ownerPersonId)\b/);
    expect(code).toMatch(/auth\.ctx\.personId/);
    expect(code).toMatch(/auth\.ctx\.orgId/);
  });

  it('probes the polymorphic reference for visibility before insert (A1)', () => {
    const code = stripComments(read(SERVICE_FILE));
    expect(code).toMatch(/assertActivityReferences\(tx, auth, data\.entityType, data\.entityId\)/);
  });

  it('the (entityType, entityId) link is immutable on update', () => {
    const code = stripComments(read(SERVICE_FILE));
    // The UPDATE column map has no entity columns: check inside updateActivity
    // only (the SELECTs elsewhere legitimately read entity_type/entity_id).
    const start = code.indexOf('export async function updateActivity');
    const end = code.indexOf('export async function deleteActivity');
    expect(start).toBeGreaterThan(-1);
    const updateBody = code.slice(start, end === -1 ? undefined : end);
    expect(updateBody).not.toMatch(/entity_type|entity_id/);
    // …and the update schema carries no entity fields.
    expect(UpdateActivitySchema.safeParse({ entityType: 'company' }).success).toBe(false);
    expect(
      UpdateActivitySchema.safeParse({ entityId: '123e4567-e89b-12d3-a456-426614174000' }).success,
    ).toBe(false);
  });

  it('orders the timeline newest-first with a stable tiebreak', () => {
    const code = stripComments(read(SERVICE_FILE));
    expect(code).toMatch(/order by a\.occurred_at desc nulls last, a\.id asc/);
  });
});

describe('activities entry points authorize first', () => {
  function activityActionsBody(): string {
    const raw = read(ACTION_FILE);
    const start = raw.indexOf('// ── Activities ──');
    expect(start).toBeGreaterThan(-1);
    return stripComments(raw.slice(start));
  }

  it('every activities server action awaits requirePermission() as its first statement', () => {
    const problems = analyseServerActions(read(ACTION_FILE)).filter((p) =>
      /Activities|listActivities|getActivity|createActivity|updateActivity|deleteActivity/.test(p),
    );
    expect(problems).toEqual([]);
    // and the section holds exactly the five CRUD actions
    const body = activityActionsBody();
    const names = [...body.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((m) => m[1]);
    expect(names).toEqual([
      'listActivitiesAction',
      'getActivityAction',
      'createActivityAction',
      'updateActivityAction',
      'deleteActivityAction',
    ]);
  });

  it('activities actions use the activities.view/create/edit/delete keys, nothing else', () => {
    const body = activityActionsBody();
    const keys = [...body.matchAll(/permission:\s*'([^']+)'/g)].map((m) => m[1] as string);
    expect(keys).toEqual([
      'activities.view',
      'activities.view',
      'activities.create',
      'activities.edit',
      'activities.delete',
    ]);
  });

  it('every activities route handler is built as withPermission(...)', () => {
    for (const file of ROUTE_FILES) {
      expect(analyseRoute(read(file)), file).toEqual([]);
    }
  });

  it('activities routes gate DELETE on the .delete key (A2)', () => {
    const code = stripComments(read('src/app/api/crm/activities/[id]/route.ts'));
    expect(code).toMatch(
      /export const DELETE = withPermission<\{ id: string \}>\(\s*\{\s*permission: 'activities\.delete'/,
    );
  });

  it('activities routes reject invalid input with 400, not the 500 envelope', () => {
    for (const file of ROUTE_FILES) {
      expect(stripComments(read(file)), file).toMatch(/invalidRequestResponse/);
    }
  });

  it('the collection route exposes the entity and type filters', () => {
    const code = stripComments(read('src/app/api/crm/activities/route.ts'));
    for (const param of ['entityType', 'entityId', 'type', 'search', 'limit', 'offset']) {
      expect(code, param).toMatch(new RegExp(`searchParams\\.get\\('${param}'\\)`));
    }
  });
});

describe('activities validation boundary', () => {
  it('activity types are exactly the four CHECK values', () => {
    expect([...ACTIVITY_TYPES]).toEqual(['CALL', 'EMAIL', 'MEETING', 'NOTE']);
    expect(ActivityTypeSchema.safeParse('SMS').success).toBe(false);
    expect(ActivityTypeSchema.safeParse('CALL').success).toBe(true);
  });

  it('entity types are exactly the three CHECK values', () => {
    expect([...ACTIVITY_ENTITY_TYPES]).toEqual(['company', 'contact', 'deal']);
    expect(ActivityEntityTypeSchema.safeParse('lead').success).toBe(false);
    expect(ActivityEntityTypeSchema.safeParse('deal').success).toBe(true);
  });

  it('creates require entityType, entityId, type and a non-blank subject', () => {
    const base = {
      entityType: 'company',
      entityId: '123e4567-e89b-12d3-a456-426614174000',
      type: 'CALL',
      subject: 'Kickoff',
    };
    expect(CreateActivitySchema.safeParse(base).success).toBe(true);
    expect(CreateActivitySchema.safeParse({ ...base, subject: '   ' }).success).toBe(false);
    expect(CreateActivitySchema.safeParse({ ...base, entityId: 'nope' }).success).toBe(false);
    expect(CreateActivitySchema.safeParse({ ...base, type: 'SMS' }).success).toBe(false);
    const { entityType: _e, ...noEntity } = base;
    expect(CreateActivitySchema.safeParse(noEntity).success).toBe(false);
  });

  it('occurredAt/dueAt accept ISO-8601 datetimes, nullable and optional', () => {
    const base = {
      entityType: 'deal',
      entityId: '123e4567-e89b-12d3-a456-426614174000',
      type: 'MEETING',
      subject: 'Review',
    };
    expect(
      CreateActivitySchema.safeParse({ ...base, occurredAt: '2026-09-30T10:00:00+05:30' }).data,
    ).toMatchObject({ occurredAt: '2026-09-30T10:00:00+05:30' });
    expect(CreateActivitySchema.safeParse({ ...base, dueAt: null }).success).toBe(true);
    expect(CreateActivitySchema.safeParse(base).success).toBe(true);
    expect(CreateActivitySchema.safeParse({ ...base, occurredAt: 'tomorrow' }).success).toBe(false);
    expect(CreateActivitySchema.safeParse({ ...base, dueAt: '30-09-2026' }).success).toBe(false);
  });

  it('notes are capped at 4000 chars', () => {
    const base = {
      entityType: 'contact',
      entityId: '123e4567-e89b-12d3-a456-426614174000',
      type: 'NOTE',
      subject: 'N',
    };
    expect(CreateActivitySchema.safeParse({ ...base, notes: 'x'.repeat(4000) }).success).toBe(true);
    expect(CreateActivitySchema.safeParse({ ...base, notes: 'x'.repeat(4001) }).success).toBe(
      false,
    );
  });

  it('updates need at least one field and reject unknown keys (strict)', () => {
    expect(UpdateActivitySchema.safeParse({}).success).toBe(false);
    expect(UpdateActivitySchema.safeParse({ subject: 'New' }).success).toBe(true);
    expect(UpdateActivitySchema.safeParse({ subject: 'New', ownerPersonId: 'x' }).success).toBe(
      false,
    );
  });

  it('list queries accept the entity/type filters, validated', () => {
    expect(ListActivitiesQuerySchema.parse({ entityType: 'contact', type: 'EMAIL' })).toMatchObject(
      { entityType: 'contact', type: 'EMAIL' },
    );
    expect(ListActivitiesQuerySchema.parse({}).entityType).toBeUndefined();
    expect(ListActivitiesQuerySchema.safeParse({ entityType: 'lead' }).success).toBe(false);
    expect(ListActivitiesQuerySchema.safeParse({ type: 'SMS' }).success).toBe(false);
    expect(ListActivitiesQuerySchema.safeParse({ entityId: 'nope' }).success).toBe(false);
    // pagination still defaults to 25 and caps at 100
    expect(ListActivitiesQuerySchema.parse({}).limit).toBe(25);
    expect(ListActivitiesQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});
