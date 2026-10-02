import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { createPipeline, createStage } from '@/lib/crm/pipelines';
import { serviceInvalidRequestResponse } from '@/lib/crm/http';
import { requirePermission, type Authorization } from '@/lib/authz/require-permission';
import { headersFor, mkAccount, mkCustomRole, type Account } from '../authz/fixtures';

/**
 * Phase 3 exit fixes, round 2 — drizzle error unwrapping regression.
 *
 * drizzle-orm wraps the node-postgres driver error in a DrizzleQueryError, so
 * the pg SQLSTATE (`code`) and the violated index name (`constraint`) live on
 * `error.cause`, not on the top-level error. The pipeline conflict mapping in
 * src/lib/crm/pipelines.ts used to read them off the top level, so a 23505
 * from a duplicate pipeline name (or a second default pipeline, or a taken
 * stage position) never matched and fell through to the 500 INTERNAL
 * envelope instead of the 400 INVALID_REQUEST it deserves.
 *
 * These tests drive the real service functions against a real database, so
 * drizzle performs the real wrap: if the unwrapping regresses, the second
 * call throws the raw DrizzleQueryError (→ 500) instead of INVALID_REQUEST.
 *
 * Run with the CI test environment (DATABASE_URL on the pooled host, APP_URL,
 * NODE_ENV=test, BETTER_AUTH_SECRET) — src/env.ts validates at import time.
 *
 * Covers:
 *  - createPipeline twice with the same name → INVALID_REQUEST (400), not 500
 *  - createPipeline with isDefault on an org that already has a live default
 *    (every org is born with one since 0039) → INVALID_REQUEST (400)
 *  - createStage twice with the same explicit position → INVALID_REQUEST (400)
 *  - the caught error maps to a real HTTP 400 through serviceInvalidRequestResponse
 */

if (!process.env.DATABASE_URL && process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

/** Unique per run: these tables are permanent and the suite must be re-runnable. */
const RUN = Math.random().toString(36).slice(2, 8);
const CODE = `C${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

const mkOrg = async (slug: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1,$2) returning id`,
      [`Conflict ${slug}`, slug],
    )
  ).rows[0]!.id;

const mkDept = async (org: string, code: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1,$2,$3) returning id`,
      [org, code, `Dept ${code}`],
    )
  ).rows[0]!.id;

const defaultPipelineOf = async (org: string) =>
  (
    await owner.query<{ id: string }>(
      `select p.id from public.pipelines p
       where p.org_id = $1 and p.is_default and p.deleted_at is null`,
      [org],
    )
  ).rows[0]?.id ?? null;

let org = '';
let manager!: Account;

/** A genuine Authorization, minted by requirePermission() through the account's session. */
const authFor = (permission: string): Promise<Authorization> =>
  requirePermission(headersFor(manager.cookie), { permission });

/** The service threw INVALID_REQUEST and the HTTP layer answers it with a 400. */
async function expectInvalidRequest400(run: Promise<unknown>, message: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await run;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the service call to reject').toBeDefined();
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(message);
  // The same error object must map to a 400 response — never the 500 envelope.
  const response = serviceInvalidRequestResponse(caught);
  expect(response, 'INVALID_REQUEST must map to a 400 response').not.toBeNull();
  expect(response!.status).toBe(400);
  const body = (await response!.json()) as { error: string };
  expect(body.error).toBe('INVALID_REQUEST');
}

beforeAll(async () => {
  org = await mkOrg(`conflict-${RUN}`);
  const dept = await mkDept(org, `${CODE}_1`);
  const role = await mkCustomRole(owner, org, `${CODE}_M`, [
    ['pipelines.view', 'GLOBAL'],
    ['pipelines.create', 'GLOBAL'],
    ['pipeline_stages.manage', 'GLOBAL'],
  ]);
  manager = await mkAccount(owner, {
    org,
    dept,
    run: RUN,
    label: 'CF-Manager',
    customRoles: [role],
  });
});

afterAll(async () => {
  await owner.end();
});

describe('pipeline conflict mapping (drizzle-unwrap regression)', () => {
  it('maps a duplicate pipeline name to INVALID_REQUEST, not a 500', async () => {
    const name = `Dup ${RUN}`;
    const first = await createPipeline(await authFor('pipelines.create'), { name });
    expect(first.id).toBeTruthy();

    await expectInvalidRequest400(
      createPipeline(await authFor('pipelines.create'), { name }),
      /^INVALID_REQUEST: a pipeline with this name already exists/,
    );
  });

  it('maps a second default pipeline to INVALID_REQUEST, not a 500', async () => {
    // Every org is born with a live default pipeline since migration 0039,
    // so creating one with isDefault is already "a second default".
    expect(await defaultPipelineOf(org)).not.toBeNull();

    await expectInvalidRequest400(
      createPipeline(await authFor('pipelines.create'), {
        name: `Second default ${RUN}`,
        isDefault: true,
      }),
      /^INVALID_REQUEST: a default pipeline already exists/,
    );
  });

  it('maps a taken stage position to INVALID_REQUEST, not a 500', async () => {
    const pipeline = await createPipeline(await authFor('pipelines.create'), {
      name: `Stages ${RUN}`,
    });
    const auth = await authFor('pipeline_stages.manage');
    await createStage(auth, pipeline.id, { name: `First ${RUN}`, position: 0 });

    await expectInvalidRequest400(
      createStage(await authFor('pipeline_stages.manage'), pipeline.id, {
        name: `Second ${RUN}`,
        position: 0,
      }),
      /^INVALID_REQUEST: position is already taken in this pipeline/,
    );
  });
});
