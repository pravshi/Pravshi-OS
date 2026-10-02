import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Migration 0040 — pipeline stage membership guard
 * (drizzle/0040_pipeline_stage_membership_guard.sql).
 *
 * Strengthens public.deals_pipeline_org_guard(): a deal's pipeline_stage_id
 * must belong to the deal's pipeline_id, not merely to the same org. This is
 * the DB-level backstop for cross-pipeline stage assignment — the API check
 * in moveDealToStage is the primary enforcement (friendlier 400), this
 * trigger catches anything that bypasses the service layer.
 *
 * Proves:
 *  (a) a deal cannot be INSERTed or UPDATEd with a stage from a different
 *      pipeline (42501)
 *  (b) legitimate moves within the same pipeline still succeed
 *  (c) NULL pipeline columns (legacy rows) pass untouched, and the guard
 *      does not break the 0037 backfill shape (both set together)
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

const RUN = Math.random().toString(36).slice(2, 8);

async function sqlstateOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'NO ERROR';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

let orgId = '';
let pipelineA = '';
let pipelineB = '';
let stageA1 = '';
let stageA2 = '';
let stageB1 = '';
let personId = '';

beforeAll(async () => {
  // Org with a seeded default pipeline (six stages from 0039's seed).
  orgId = (
    await owner.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1,$2) returning id`,
      [`Guard ${RUN}`, `guard-${RUN}`],
    )
  ).rows[0]!.id;

  // Person to own the test deals (owner_person_id is NOT NULL).
  const pcode = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [orgId])
  ).rows[0]!.c;
  personId = (
    await owner.query<{ id: string }>(
      `insert into public.people (org_id, code, full_legal_name, person_status)
       values ($1,$2,$3,'ACTIVE') returning id`,
      [orgId, pcode, `Guard Person ${RUN}`],
    )
  ).rows[0]!.id;

  pipelineA = (
    await owner.query<{ id: string }>(
      `select id from public.pipelines where org_id = $1 and is_default and deleted_at is null`,
      [orgId],
    )
  ).rows[0]!.id;

  const stagesA = await owner.query<{ id: string; name: string }>(
    `select id, name from public.pipeline_stages where pipeline_id = $1 order by position`,
    [pipelineA],
  );
  stageA1 = stagesA.rows[0]!.id;
  stageA2 = stagesA.rows[1]!.id;

  // Second pipeline in the same org, with its own stage.
  pipelineB = (
    await owner.query<{ id: string }>(
      `insert into public.pipelines (org_id, name, is_default) values ($1,$2,false) returning id`,
      [orgId, `Second ${RUN}`],
    )
  ).rows[0]!.id;
  stageB1 = (
    await owner.query<{ id: string }>(
      `insert into public.pipeline_stages (org_id, pipeline_id, name, position) values ($1,$2,$3,0) returning id`,
      [orgId, pipelineB, `Foreign ${RUN}`],
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await owner.end();
});

describe('0040 stage↔pipeline membership guard', () => {
  it('rejects INSERT with a stage from a different pipeline (42501)', async () => {
    const code = await sqlstateOf(
      owner.query(
        `insert into public.deals (org_id, title, owner_person_id, pipeline_id, pipeline_stage_id)
         values ($1,$2,$3,$4,$5)`,
        [orgId, `XPIPE ${RUN}`, personId, pipelineA, stageB1],
      ),
    );
    expect(code).toBe('42501');
  });

  it('rejects UPDATE moving a deal to a foreign-pipeline stage (42501)', async () => {
    const dealId = (
      await owner.query<{ id: string }>(
        `insert into public.deals (org_id, title, owner_person_id, pipeline_id, pipeline_stage_id)
         values ($1,$2,$3,$4,$5) returning id`,
        [orgId, `XPIPE2 ${RUN}`, personId, pipelineA, stageA1],
      )
    ).rows[0]!.id;
    const code = await sqlstateOf(
      owner.query(`update public.deals set pipeline_stage_id = $1 where id = $2`, [stageB1, dealId]),
    );
    expect(code).toBe('42501');
  });

  it('rejects a stage with no pipeline (incoherent row)', async () => {
    const code = await sqlstateOf(
      owner.query(
        `insert into public.deals (org_id, title, owner_person_id, pipeline_id, pipeline_stage_id)
         values ($1,$2,$3,$4,$5)`,
        [orgId, `XPIPE3 ${RUN}`, personId, null, stageA1],
      ),
    );
    expect(code).toBe('42501');
  });

  it('allows legitimate moves within the same pipeline', async () => {
    const dealId = (
      await owner.query<{ id: string }>(
        `insert into public.deals (org_id, title, owner_person_id, pipeline_id, pipeline_stage_id)
         values ($1,$2,$3,$4,$5) returning id`,
        [orgId, `OKMOVE ${RUN}`, personId, pipelineA, stageA1],
      )
    ).rows[0]!.id;
    await owner.query(`update public.deals set pipeline_stage_id = $1 where id = $2`, [
      stageA2,
      dealId,
    ]);
    const after = await owner.query<{ pipeline_stage_id: string }>(
      `select pipeline_stage_id from public.deals where id = $1`,
      [dealId],
    );
    expect(after.rows[0]!.pipeline_stage_id).toBe(stageA2);
  });

  it('leaves NULL pipeline columns untouched (legacy rows)', async () => {
    const dealId = (
      await owner.query<{ id: string }>(
        `insert into public.deals (org_id, title, owner_person_id) values ($1,$2,$3) returning id`,
        [orgId, `NULLPIPE ${RUN}`, personId],
      )
    ).rows[0]!.id;
    // A no-op update on a NULL-pipeline deal must not trip the guard.
    await owner.query(`update public.deals set title = $1 where id = $2`, [
      `NULLPIPE ${RUN} v2`,
      dealId,
    ]);
    const after = await owner.query<{ title: string }>(
      `select title from public.deals where id = $1`,
      [dealId],
    );
    expect(after.rows[0]!.title).toBe(`NULLPIPE ${RUN} v2`);
  });

  it('still rejects cross-org pipeline references (0037 behavior preserved)', async () => {
    const org2 = (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name, slug) values ($1,$2) returning id`,
        [`Guard2 ${RUN}`, `guard2-${RUN}`],
      )
    ).rows[0]!.id;
    const pipe2 = (
      await owner.query<{ id: string }>(
        `select id from public.pipelines where org_id = $1 and is_default and deleted_at is null`,
        [org2],
      )
    ).rows[0]!.id;
    const code = await sqlstateOf(
      owner.query(
        `insert into public.deals (org_id, title, owner_person_id, pipeline_id, pipeline_stage_id)
         values ($1,$2,$3,$4,$5)`,
        [orgId, `XORG ${RUN}`, personId, pipe2, stageA1],
      ),
    );
    expect(code).toBe('42501');
  });
});
