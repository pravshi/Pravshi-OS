import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Phase 3 — sales pipeline: pipelines, pipeline_stages, deal_stage_history.
 *
 * Same harness as the CRM Core / Track B suites: owner (DATABASE_URL_MIGRATE,
 * app_owner) seeds fixtures and inspects the catalogue; user (DATABASE_URL_TEST,
 * app_user) is where every boundary is probed.
 *
 * Coverage: tenant isolation across all three tables, the permission gates
 * (pipelines.view/create/edit/delete, pipeline_stages.manage, deals.view/edit
 * on history), the no-identity fail-closed default, the
 * deals_pipeline_immutable() trigger (42501 on any pipeline_id change),
 * the deals_pipeline_org_guard() and pipeline_stage_org_guard() triggers,
 * the deal_stage_history recorder trigger (move rows, creation rows, no-op and
 * to-NULL moves write nothing), the stage composite-org FK, CHECK constraints
 * (probability, color, is_won/is_lost exclusion, blank names), the
 * pipeline_stages_position_unique constraint, the one-live-default-per-org
 * partial unique index (soft-deleted defaults free the slot), soft delete of
 * pipelines via crm_soft_delete('pipeline', …), FORCE RLS catalogue flags, the
 * permission catalogue, and the audit trail.
 *
 * Written against the published contract in
 * drizzle/0037_sales_pipeline.sql (read in full during reconciliation).
 * One deliberate documentation: the database does NOT constrain a deal's
 * stage to its pipeline (single-column FKs) — the API's moveDealToStage must
 * reject cross-pipeline stages with 400, and a test below pins that hole.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

/** Unique per run: these tables are permanent and the suite must be re-runnable. */
const RUN = Math.random().toString(36).slice(2, 8);
const CODE = `P${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

type Ctx = { personId?: string | null; orgId?: string | null };

/** One transaction as app_user, carrying exactly the identity given — nothing more. */
async function inContext<T extends Record<string, unknown> = Record<string, unknown>>(
  ctx: Ctx,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = await asUser.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`, [
      ctx.personId ?? '',
      ctx.orgId ?? '',
    ]);
    const result = await c.query<T>(sql, params);
    await c.query('commit');
    return result.rows;
  } catch (error) {
    await c.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

/** The sqlstate of a rejected statement. 42501 is insufficient_privilege (RLS deny). */
async function sqlstateOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'NO ERROR';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

/**
 * The code AND message of a rejected statement. Used for trigger raises whose
 * sqlstate is not pinned by the draft contract (this codebase uses 42501 for
 * created_by immutability but 23514 for code/key immutability).
 */
async function errorOf(run: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run;
    return { code: 'NO ERROR', message: '' };
  } catch (error) {
    return {
      code: (error as { code?: string }).code ?? 'UNKNOWN',
      message: (error as Error).message ?? String(error),
    };
  }
}

const mkOrg = async (slug: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1,$2) returning id`,
      [`PIPE ${slug}`, slug],
    )
  ).rows[0]!.id;

const mkDept = async (org: string, code: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1,$2,$3) returning id`,
      [org, code, `Dept ${code}`],
    )
  ).rows[0]!.id;

const mkPerson = async (org: string, name: string, status = 'ACTIVE') => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  return (
    await owner.query<{ id: string }>(
      `insert into public.people
         (org_id, code, full_legal_name, person_status, date_of_birth, personal_email, phone)
       values ($1,$2,$3,$4::public.person_status,'1990-01-01',$5,'+91-00000-00000')
       returning id`,
      [org, code, name, status, `${name.toLowerCase().replace(/[^a-z]/g, '')}.${RUN}@example.test`],
    )
  ).rows[0]!.id;
};

const mkEngagement = async (
  org: string,
  person: string,
  dept: string,
  opts: { status?: string; manager?: string | null } = {},
) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.engagements
         (org_id, person_id, department_id, manager_person_id, engagement_type, status, start_date)
       values ($1,$2,$3,$4,'EMPLOYEE',$5::public.engagement_status, current_date)
       returning id`,
      [org, person, dept, opts.manager ?? null, opts.status ?? 'ACTIVE'],
    )
  ).rows[0]!.id;

/** A custom role carrying exactly one permission at one scope, assigned to one person. */
const mkRoleFor = async (
  org: string,
  person: string,
  key: string,
  permission: string,
  scope: string,
) => {
  const roleKey = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const role = (
    await owner.query<{ id: string }>(
      `insert into public.roles (org_id, key, name) values ($1,$2,$3) returning id`,
      [org, roleKey, `PIPE ${roleKey}`],
    )
  ).rows[0]!.id;
  await owner.query(
    `insert into public.role_permissions (role_id, permission_id, scope)
     select $1, p.id, $2::public.access_scope from public.permissions p where p.key = $3`,
    [role, scope, permission],
  );
  await owner.query(
    `insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`,
    [person, role, org],
  );
};

/** The org's live default pipeline id (auto-seeded by the 0039 trigger). */
const defaultPipelineOf = async (org: string) =>
  (
    await owner.query<{ id: string }>(
      `select p.id
       from public.pipelines p
       where p.org_id = $1
         and p.is_default
         and p.deleted_at is null`,
      [org],
    )
  ).rows[0]!.id;

/** pipelines columns per 0037 (id/org_id/name/description/is_default/
 *  created_at/updated_at/deleted_at). */
const mkPipeline = async (org: string, name: string, isDefault = false) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.pipelines (org_id, name, description, is_default)
       values ($1,$2,$3,$4) returning id`,
      [org, name, `${name} ${RUN}`, isDefault],
    )
  ).rows[0]!.id;

/** pipeline_stages columns per 0037 (id/org_id/pipeline_id/name/position/
 *  probability numeric(5,2)/color/is_won/is_lost/created_at — no deleted_at). */
const mkStage = async (
  org: string,
  pipeline: string,
  name: string,
  position: number,
  opts: { probability?: number; color?: string | null; isWon?: boolean; isLost?: boolean } = {},
) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.pipeline_stages
         (org_id, pipeline_id, name, position, probability, color, is_won, is_lost)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [
        org,
        pipeline,
        name,
        position,
        opts.probability ?? 0,
        opts.color ?? null,
        opts.isWon ?? false,
        opts.isLost ?? false,
      ],
    )
  ).rows[0]!.id;

/** A deal on a pipeline. Seeded as owner; the history trigger fires for owner
 *  inserts too, so tests that count history rows reset them explicitly. */
const mkDeal = async (
  org: string,
  ownerPerson: string,
  title: string,
  pipeline: string | null,
  stage: string | null,
) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.deals (org_id, title, owner_person_id, pipeline_id, pipeline_stage_id)
       values ($1,$2,$3,$4,$5) returning id`,
      [org, title, ownerPerson, pipeline, stage],
    )
  ).rows[0]!.id;

let orgA = '';
let orgB = '';
let dA1 = '';

// actors (orgA unless noted)
let pView = ''; // pipelines.view GLOBAL
let pManage = ''; // pipelines.view/create/edit/delete GLOBAL + pipeline_stages.manage GLOBAL
let pMove = ''; // deals.view + deals.edit GLOBAL (moves deals between stages)
let pNone = ''; // no grants at all
let pSusp = ''; // pipelines.view GLOBAL, SUSPENDED engagement
let pForeign = ''; // orgB, pipelines.view GLOBAL

// fixtures (orgA unless noted)
let pipeA = ''; // orgA pipeline (non-default; the seeded default is separate)
let pipeA2 = ''; // second pipeline, orgA
let pipeDoomed = ''; // orgA pipeline reserved for the soft-delete suite
let pipeB = ''; // orgB pipeline
let seedA = ''; // orgA's auto-seeded default pipeline (0039 trigger)
let seedB = ''; // orgB's auto-seeded default pipeline (0039 trigger)
let stA1 = ''; // pipeA, position 0, probability 10
let stA2 = ''; // pipeA, position 1, probability 50, color #1a2b3c
let stA2x = ''; // pipeA2, position 0
let stB1 = ''; // pipeB, position 0
let dealA = ''; // orgA deal on pipeA/stA1 — the move-deal target
let dealNoStage = ''; // orgA deal on pipeA with NO stage (creation-row negative case)
let dealForeign = ''; // orgB deal on pipeB/stB1

const ctxOf = (person: string) => ({ personId: person, orgId: orgA });

beforeAll(async () => {
  [orgA, orgB] = await Promise.all([mkOrg(`pipe-${RUN}-a`), mkOrg(`pipe-${RUN}-b`)]);
  dA1 = await mkDept(orgA, `${CODE}_1`);
  const dB = await mkDept(orgB, `${CODE}_B`);

  [pView, pManage, pMove, pNone, pSusp, pForeign] = await Promise.all([
    mkPerson(orgA, 'PV Viewer'),
    mkPerson(orgA, 'PM Manager'),
    mkPerson(orgA, 'PM Mover'),
    mkPerson(orgA, 'PN None'),
    mkPerson(orgA, 'PS Susp'),
    mkPerson(orgB, 'PF Foreign'),
  ]);

  await Promise.all([
    mkEngagement(orgA, pView, dA1),
    mkEngagement(orgA, pManage, dA1),
    mkEngagement(orgA, pMove, dA1),
    mkEngagement(orgA, pNone, dA1),
    mkEngagement(orgA, pSusp, dA1, { status: 'SUSPENDED' }),
    mkEngagement(orgB, pForeign, dB),
  ]);

  await mkRoleFor(orgA, pView, `${CODE}-v`, 'pipelines.view', 'GLOBAL');
  await mkRoleFor(orgA, pManage, `${CODE}-mv`, 'pipelines.view', 'GLOBAL');
  await mkRoleFor(orgA, pManage, `${CODE}-mc`, 'pipelines.create', 'GLOBAL');
  await mkRoleFor(orgA, pManage, `${CODE}-me`, 'pipelines.edit', 'GLOBAL');
  await mkRoleFor(orgA, pManage, `${CODE}-md`, 'pipelines.delete', 'GLOBAL');
  await mkRoleFor(orgA, pManage, `${CODE}-ms`, 'pipeline_stages.manage', 'GLOBAL');
  await mkRoleFor(orgA, pMove, `${CODE}-dv`, 'deals.view', 'GLOBAL');
  await mkRoleFor(orgA, pMove, `${CODE}-de`, 'deals.edit', 'GLOBAL');
  await mkRoleFor(orgA, pSusp, `${CODE}-sv`, 'pipelines.view', 'GLOBAL');
  await mkRoleFor(orgB, pForeign, `${CODE}-fv`, 'pipelines.view', 'GLOBAL');
  // History SELECT is gated on deals.view (not pipelines.view): the foreign
  // viewer needs it too, so the orgB-history isolation probe is meaningful.
  await mkRoleFor(orgB, pForeign, `${CODE}-fdv`, 'deals.view', 'GLOBAL');

  // 0039: every org is born with a default pipeline (seeded by the
  // organizations_seed_system_roles trigger), so the fixtures below create
  // non-default pipelines; seedA/seedB capture the auto-seeded defaults.
  [seedA, seedB] = await Promise.all([defaultPipelineOf(orgA), defaultPipelineOf(orgB)]);
  [pipeA, pipeA2, pipeDoomed, pipeB] = await Promise.all([
    mkPipeline(orgA, `Pipe A ${RUN}`),
    mkPipeline(orgA, `Pipe A2 ${RUN}`),
    mkPipeline(orgA, `Pipe Doomed ${RUN}`),
    mkPipeline(orgB, `Pipe B ${RUN}`),
  ]);

  [stA1, stA2, stA2x, stB1] = await Promise.all([
    mkStage(orgA, pipeA, `Discovery ${RUN}`, 0, { probability: 10 }),
    mkStage(orgA, pipeA, `Proposal ${RUN}`, 1, { probability: 50, color: '#1a2b3c' }),
    mkStage(orgA, pipeA2, `Inbound ${RUN}`, 0, { probability: 5 }),
    mkStage(orgB, pipeB, `Foreign ${RUN}`, 0, { probability: 20 }),
  ]);

  dealA = await mkDeal(orgA, pMove, `Move Deal ${RUN}`, pipeA, stA1);
  dealNoStage = await mkDeal(orgA, pMove, `No Stage Deal ${RUN}`, pipeA, null);
  dealForeign = await mkDeal(orgB, pForeign, `Foreign Deal ${RUN}`, pipeB, stB1);

  // Reset dealA's history: the owner insert above wrote a creation row (the
  // recorder trigger fires for owner inserts too). The move suite counts
  // history rows per move, so it starts from zero. Owner deletes ride on the
  // deal_stage_history_owner_all FOR ALL policy.
  await owner.query(`delete from public.deal_stage_history where deal_id = $1`, [dealA]);
});

afterAll(async () => {
  await owner.end();
  await asUser.end();
});

// ═════════════════════════════════════════════════════════════════════════════════
// tenant isolation — all three tables
// ═════════════════════════════════════════════════════════════════════════════════

describe('tenant isolation', () => {
  it('a GLOBAL pipelines viewer in orgA sees orgA pipelines but not orgB’s', async () => {
    const ids = (
      await inContext<{ id: string }>(ctxOf(pView), `select id from public.pipelines`)
    ).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([pipeA, pipeA2, pipeDoomed]));
    expect(ids).not.toContain(pipeB);
  });

  it('orgA sees orgA stages but not orgB’s', async () => {
    const ids = (
      await inContext<{ id: string }>(ctxOf(pView), `select id from public.pipeline_stages`)
    ).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([stA1, stA2, stA2x]));
    expect(ids).not.toContain(stB1);
  });

  it('orgA sees only orgA stage-history rows (history SELECT rides on deals.view)', async () => {
    // 0037: deal_stage_history SELECT is gated on authz.has('deals.view') —
    // pipelines.view alone is not enough (see the next test). pMove holds
    // deals.view GLOBAL.
    // Seed one orgA history row first: the move suite that writes history rows
    // runs later in this file, and beforeAll reset dealA's history, so at this
    // point the table holds no orgA rows yet. The owner INSERT fires the
    // recorder trigger, writing the creation row.
    await owner.query(
      `insert into public.deals (org_id, title, owner_person_id, pipeline_id, pipeline_stage_id)
       values ($1,$2,$3,$4,$5)`,
      [orgA, `History Probe ${RUN}`, pMove, pipeA, stA1],
    );
    const orgs = (
      await inContext<{ org_id: string }>(
        ctxOf(pMove),
        `select distinct org_id from public.deal_stage_history`,
      )
    ).map((r) => r.org_id);
    // org-distinct (not count-based): robust to the rows the move suite adds.
    expect(orgs).toEqual([orgA]);
  });

  it('pipelines.view alone does not open history: no deals.view, no rows', async () => {
    const rows = await inContext(ctxOf(pView), `select id from public.deal_stage_history`);
    expect(rows).toEqual([]);
  });

  it('a viewer in orgB sees exactly orgB’s pipelines, stages and history', async () => {
    const ctx = { personId: pForeign, orgId: orgB };
    const pipes = (await inContext<{ id: string }>(ctx, `select id from public.pipelines`)).map(
      (r) => r.id,
    );
    // pipeB plus orgB's auto-seeded default (0039 trigger) — and nothing else.
    expect(pipes).toHaveLength(2);
    expect(pipes).toEqual(expect.arrayContaining([pipeB, seedB]));
    const stages = (
      await inContext<{ id: string }>(ctx, `select id from public.pipeline_stages`)
    ).map((r) => r.id);
    // stB1 plus the six seeded stages on the default pipeline.
    expect(stages).toHaveLength(7);
    expect(stages).toEqual(expect.arrayContaining([stB1]));
    const orgs = (
      await inContext<{ org_id: string }>(
        ctx,
        `select distinct org_id from public.deal_stage_history`,
      )
    ).map((r) => r.org_id);
    expect(orgs).toEqual([orgB]);
  });

  it('a spoofed org claim reaches nothing', async () => {
    const spoofed = (
      await inContext<{ id: string }>(
        { personId: pView, orgId: orgB },
        `select id from public.pipelines`,
      )
    ).map((r) => r.id);
    expect(spoofed).toEqual([]);
  });

  it('cross-tenant pipeline insert is rejected: org must match the identity', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(pManage),
          `insert into public.pipelines (org_id, name) values ($1,'Xeno')`,
          [orgB],
        ),
      ),
    ).toBe('42501');
  });

  it('cross-tenant stage insert is rejected: org must match the identity', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(pManage),
          `insert into public.pipeline_stages (org_id, pipeline_id, name, position)
           values ($1,$2,'Xeno',0)`,
          [orgB, pipeB],
        ),
      ),
    ).toBe('42501');
  });

  it('direct history inserts are gated on deals.edit (the trigger is the primary writer)', async () => {
    // 0037: the INSERT policy exists so the table is not silently unwritable
    // outside the trigger path, gated on authz.has('deals.edit'). pManage
    // holds no deals.* grant; pMove holds deals.edit GLOBAL.
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(pManage),
          `insert into public.deal_stage_history
             (org_id, deal_id, from_stage_id, to_stage_id, changed_by)
           values ($1,$2,$3,$4,$5)`,
          [orgA, dealA, stA1, stA2, pManage],
        ),
      ),
    ).toBe('42501');
    const rows = await inContext<{ id: string }>(
      ctxOf(pMove),
      `insert into public.deal_stage_history
         (org_id, deal_id, from_stage_id, to_stage_id, changed_by)
       values ($1,$2,$3,$4,$5) returning id`,
      [orgA, dealA, stA1, stA2, pMove],
    );
    expect(rows).toHaveLength(1);
    await owner.query(`delete from public.deal_stage_history where id = $1`, [rows[0]!.id]);
  });

  it('cross-tenant pipeline update touches zero rows (fail closed, not an error)', async () => {
    const rows = await inContext(
      ctxOf(pManage),
      `update public.pipelines set name='Hacked' where id=$1 returning id`,
      [pipeB],
    );
    expect(rows).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// permission gates
// ═════════════════════════════════════════════════════════════════════════════════

describe('permission gates', () => {
  it('a person with no grants sees nothing on any of the three tables', async () => {
    for (const table of ['pipelines', 'pipeline_stages', 'deal_stage_history']) {
      const rows = await inContext(ctxOf(pNone), `select id from public.${table}`);
      expect(rows, table).toEqual([]);
    }
  });

  it('a suspended engagement sees nothing (is_active gate)', async () => {
    for (const table of ['pipelines', 'pipeline_stages', 'deal_stage_history']) {
      const rows = await inContext(ctxOf(pSusp), `select id from public.${table}`);
      expect(rows, table).toEqual([]);
    }
  });

  it('insert without pipelines.create is rejected', async () => {
    expect(
      await sqlstateOf(
        inContext(ctxOf(pView), `insert into public.pipelines (org_id, name) values ($1,'Nope')`, [
          orgA,
        ]),
      ),
    ).toBe('42501');
  });

  it('a creator with pipelines.create can insert a pipeline in their own org', async () => {
    const rows = await inContext<{ id: string; org_id: string }>(
      ctxOf(pManage),
      `insert into public.pipelines (org_id, name) values ($1,$2) returning id, org_id`,
      [orgA, `Created ${RUN}`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.org_id).toBe(orgA);
    await owner.query(`delete from public.pipelines where id = $1`, [rows[0]!.id]);
  });

  it('update without pipelines.edit touches zero rows', async () => {
    const rows = await inContext(
      ctxOf(pView),
      `update public.pipelines set name='Hacked' where id=$1 returning id`,
      [pipeA2],
    );
    expect(rows).toHaveLength(0);
  });

  it('an editor with pipelines.edit can rename a pipeline', async () => {
    const rows = await inContext<{ name: string }>(
      ctxOf(pManage),
      `update public.pipelines set name=$2 where id=$1 returning name`,
      [pipeA2, `Renamed ${RUN}`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe(`Renamed ${RUN}`);
  });

  it('stage insert without pipeline_stages.manage is rejected', async () => {
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(pView),
          `insert into public.pipeline_stages (org_id, pipeline_id, name, position)
           values ($1,$2,'Nope',9)`,
          [orgA, pipeA],
        ),
      ),
    ).toBe('42501');
  });

  it('a stage manager can insert a stage into their own org’s pipeline', async () => {
    const rows = await inContext<{ id: string }>(
      ctxOf(pManage),
      `insert into public.pipeline_stages (org_id, pipeline_id, name, position)
       values ($1,$2,$3,7) returning id`,
      [orgA, pipeA, `Appended ${RUN}`],
    );
    expect(rows).toHaveLength(1);
    await owner.query(`delete from public.pipeline_stages where id = $1`, [rows[0]!.id]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// no identity — fail closed
// ═════════════════════════════════════════════════════════════════════════════════

describe('no identity', () => {
  it('an unauthenticated session sees nothing and writes nothing', async () => {
    const ctx = { personId: null, orgId: null };
    for (const table of ['pipelines', 'pipeline_stages', 'deal_stage_history']) {
      const rows = await inContext(ctx, `select id from public.${table}`);
      expect(rows, table).toEqual([]);
    }
    expect(
      await sqlstateOf(
        inContext(ctx, `insert into public.pipelines (org_id, name) values ($1,'X')`, [orgA]),
      ),
    ).toBe('42501');
    expect(
      await sqlstateOf(
        inContext(
          ctx,
          `insert into public.pipeline_stages (org_id, pipeline_id, name, position)
           values ($1,$2,'X',0)`,
          [orgA, pipeA],
        ),
      ),
    ).toBe('42501');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// deals.pipeline_id is immutable — reassignment goes through a governed path,
// never a direct UPDATE
// ═════════════════════════════════════════════════════════════════════════════════

describe('deals.pipeline_id immutability', () => {
  it('updating deals.pipeline_id raises 42501', async () => {
    // 0037 deals_pipeline_immutable(): `new.pipeline_id is distinct from
    // old.pipeline_id` raises 42501 — a deal never changes pipeline.
    expect(
      await sqlstateOf(
        inContext(ctxOf(pMove), `update public.deals set pipeline_id=$2 where id=$1`, [
          dealA,
          pipeA2,
        ]),
      ),
    ).toBe('42501');
  });

  it('setting pipeline_id from NULL on UPDATE also raises: assignment is INSERT-only', async () => {
    // IS DISTINCT FROM NULL is true, so even a first assignment after creation
    // is rejected — the migration backfill ran before this trigger existed for
    // exactly this reason. pMove's UPDATE reaches the trigger (deals.edit
    // GLOBAL satisfies the deals UPDATE policy).
    const id = await mkDeal(orgA, pMove, `Null Pipe ${RUN}`, null, null);
    try {
      expect(
        await sqlstateOf(
          inContext(ctxOf(pMove), `update public.deals set pipeline_id=$2 where id=$1`, [
            id,
            pipeA,
          ]),
        ),
      ).toBe('42501');
    } finally {
      await owner.query(`delete from public.deals where id=$1`, [id]);
    }
  });

  it('re-setting the same pipeline_id does not raise', async () => {
    const err = await errorOf(
      inContext(ctxOf(pMove), `update public.deals set pipeline_id=$2 where id=$1`, [dealA, pipeA]),
    );
    expect(err.code).toBe('NO ERROR');
  });

  it('setting pipeline_id on INSERT is the legitimate assignment path', async () => {
    const id = await mkDeal(orgA, pMove, `Assigned ${RUN}`, pipeA2, null);
    const got = (
      await owner.query<{ pipeline_id: string }>(
        `select pipeline_id from public.deals where id=$1`,
        [id],
      )
    ).rows[0]!.pipeline_id;
    expect(got).toBe(pipeA2);
    await owner.query(`delete from public.deals where id=$1`, [id]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// deal_stage_history trigger — every stage move is recorded exactly once
// ═════════════════════════════════════════════════════════════════════════════════

describe('stage history trigger', () => {
  it('moving pipeline_stage_id inserts exactly one row per move, with from/to/changed_by', async () => {
    const beforeIds = (
      await owner.query<{ id: string }>(
        `select id from public.deal_stage_history where deal_id=$1`,
        [dealA],
      )
    ).rows.map((r) => r.id);

    await inContext(ctxOf(pMove), `update public.deals set pipeline_stage_id=$2 where id=$1`, [
      dealA,
      stA2,
    ]);

    const first = (
      await owner.query<{
        from_stage_id: string | null;
        to_stage_id: string;
        changed_by: string | null;
        org_id: string;
      }>(
        `select from_stage_id, to_stage_id, changed_by, org_id
         from public.deal_stage_history
         where deal_id=$1 and not (id = any($2))`,
        [dealA, beforeIds],
      )
    ).rows;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      from_stage_id: stA1,
      to_stage_id: stA2,
      changed_by: pMove,
      org_id: orgA,
    });

    // A second move appends exactly one more row — history is never rewritten.
    const midIds = (
      await owner.query<{ id: string }>(
        `select id from public.deal_stage_history where deal_id=$1`,
        [dealA],
      )
    ).rows.map((r) => r.id);
    await inContext(ctxOf(pMove), `update public.deals set pipeline_stage_id=$2 where id=$1`, [
      dealA,
      stA1,
    ]);
    const second = (
      await owner.query<{ from_stage_id: string | null; to_stage_id: string }>(
        `select from_stage_id, to_stage_id from public.deal_stage_history
         where deal_id=$1 and not (id = any($2))`,
        [dealA, midIds],
      )
    ).rows;
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ from_stage_id: stA2, to_stage_id: stA1 });
  });

  it('a no-op stage update writes no history row', async () => {
    // The UPDATE trigger's WHEN clause requires OLD/NEW to be distinct.
    const before = (
      await owner.query<{ n: string }>(
        `select count(*) n from public.deal_stage_history where deal_id=$1`,
        [dealA],
      )
    ).rows[0]!.n;
    await inContext(ctxOf(pMove), `update public.deals set pipeline_stage_id=$2 where id=$1`, [
      dealA,
      stA1,
    ]);
    const after = (
      await owner.query<{ n: string }>(
        `select count(*) n from public.deal_stage_history where deal_id=$1`,
        [dealA],
      )
    ).rows[0]!.n;
    expect(after).toBe(before);
  });

  it('moving a deal OUT of a stage (to NULL) writes no history row', async () => {
    // The WHEN clause requires new.pipeline_stage_id IS NOT NULL: only
    // arrivals are recorded, never departures into the void.
    const before = (
      await owner.query<{ n: string }>(
        `select count(*) n from public.deal_stage_history where deal_id=$1`,
        [dealA],
      )
    ).rows[0]!.n;
    await inContext(ctxOf(pMove), `update public.deals set pipeline_stage_id=null where id=$1`, [
      dealA,
    ]);
    const after = (
      await owner.query<{ n: string }>(
        `select count(*) n from public.deal_stage_history where deal_id=$1`,
        [dealA],
      )
    ).rows[0]!.n;
    expect(after).toBe(before);
    // restore the stage for the suites below
    await inContext(ctxOf(pMove), `update public.deals set pipeline_stage_id=$2 where id=$1`, [
      dealA,
      stA1,
    ]);
    await owner.query(
      `delete from public.deal_stage_history
       where deal_id=$1 and to_stage_id=$2 and from_stage_id is null`,
      [dealA, stA1],
    );
  });

  it('INSERT of a deal with a stage writes a creation row with from_stage_id NULL', async () => {
    const id = await mkDeal(orgA, pMove, `Creation ${RUN}`, pipeA, stA1);
    const rows = (
      await owner.query<{ from_stage_id: string | null; to_stage_id: string }>(
        `select from_stage_id, to_stage_id from public.deal_stage_history where deal_id=$1`,
        [id],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.from_stage_id).toBeNull();
    expect(rows[0]!.to_stage_id).toBe(stA1);
    await owner.query(`delete from public.deal_stage_history where deal_id=$1`, [id]);
    await owner.query(`delete from public.deals where id=$1`, [id]);
  });

  it('an actorless creation row stamps changed_by NULL (no synthetic actor)', async () => {
    // 0037: changed_by is stamped from authz.person_id() — NULL when the
    // movement was recorded without an authenticated actor (the 0033 rule).
    const id = await mkDeal(orgA, pMove, `Actorless ${RUN}`, pipeA, stA1);
    const changedBy = (
      await owner.query<{ changed_by: string | null }>(
        `select changed_by from public.deal_stage_history where deal_id=$1`,
        [id],
      )
    ).rows[0]!.changed_by;
    expect(changedBy).toBeNull();
    await owner.query(`delete from public.deal_stage_history where deal_id=$1`, [id]);
    await owner.query(`delete from public.deals where id=$1`, [id]);
  });

  it('INSERT of a deal without a stage writes no history row', async () => {
    const rows = (
      await owner.query<{ id: string }>(
        `select id from public.deal_stage_history where deal_id=$1`,
        [dealNoStage],
      )
    ).rows;
    expect(rows).toHaveLength(0);
  });

  it('documents the API contract: a cross-pipeline stage is legal at the DB level', async () => {
    // deals.pipeline_stage_id is a single-column FK: the database constrains
    // the stage's ORG (deals_pipeline_org_guard) but NOT its pipeline. A
    // stage from a different pipeline in the same org succeeds here and even
    // records history — so the API's moveDealToStage MUST reject it with 400.
    // This test pins the hole the service layer is required to close.
    const beforeIds = (
      await owner.query<{ id: string }>(
        `select id from public.deal_stage_history where deal_id=$1`,
        [dealA],
      )
    ).rows.map((r) => r.id);
    await inContext(ctxOf(pMove), `update public.deals set pipeline_stage_id=$2 where id=$1`, [
      dealA,
      stA2x, // pipeA2's stage — same org, different pipeline
    ]);
    const cur = (
      await owner.query<{ pipeline_stage_id: string }>(
        `select pipeline_stage_id from public.deals where id=$1`,
        [dealA],
      )
    ).rows[0]!.pipeline_stage_id;
    expect(cur).toBe(stA2x);
    // restore the fixture and remove every history row this probe added
    await inContext(ctxOf(pMove), `update public.deals set pipeline_stage_id=$2 where id=$1`, [
      dealA,
      stA1,
    ]);
    const added = (
      await owner.query<{ id: string }>(
        `select id from public.deal_stage_history where deal_id=$1 and not (id = any($2))`,
        [dealA, beforeIds],
      )
    ).rows.map((r) => r.id);
    expect(added.length).toBeGreaterThan(0);
    await owner.query(`delete from public.deal_stage_history where id = any($1)`, [added]);
    const restored = (
      await owner.query<{ pipeline_stage_id: string }>(
        `select pipeline_stage_id from public.deals where id=$1`,
        [dealA],
      )
    ).rows[0]!.pipeline_stage_id;
    expect(restored).toBe(stA1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// the stage composite-org guard: (org_id, pipeline_id) must name a real pair
// ═════════════════════════════════════════════════════════════════════════════════

describe('stage org guard', () => {
  it('a stage whose org_id disagrees with its pipeline’s org raises 42501', async () => {
    // 0037 pipeline_stage_org_guard(): defense in depth beyond the composite
    // FK — rejects with 42501 BEFORE constraint checks run, so the sqlstate
    // is 42501, not 23503.
    const err = await errorOf(
      owner.query(
        `insert into public.pipeline_stages (org_id, pipeline_id, name, position)
         values ($1,$2,'Mismatched',0)`,
        [orgB, pipeA],
      ),
    );
    expect(err.code).toBe('42501');
    expect(err.message).toMatch(/same organization/i);
  });

  it('a stage on a nonexistent pipeline raises 42501 (guard runs before the FK)', async () => {
    // The guard's lookup finds no pipeline (NULL org) which is distinct from
    // orgA, so it raises before the foreign-key check is reached.
    expect(
      await sqlstateOf(
        owner.query(
          `insert into public.pipeline_stages (org_id, pipeline_id, name, position)
           values ($1,$2,'Ghost',0)`,
          [orgA, '123e4567-e89b-12d3-a456-426614174000'],
        ),
      ),
    ).toBe('42501');
  });
});

describe('deals pipeline/stage org guard', () => {
  it('a deal cannot reference another org’s pipeline (42501)', async () => {
    // 0037 deals_pipeline_org_guard(): pipeline_id/pipeline_stage_id are
    // single-column FKs, so without this a deal could reference another
    // tenant's pipeline. The trigger closes the hole with 42501.
    const err = await errorOf(mkDeal(orgA, pMove, `Xeno Pipe ${RUN}`, pipeB, null));
    expect(err.code).toBe('42501');
    expect(err.message).toMatch(/pipeline_id must belong to the deal's organization/i);
  });

  it('a deal cannot reference another org’s stage (42501)', async () => {
    const err = await errorOf(mkDeal(orgA, pMove, `Xeno Stage ${RUN}`, pipeA, stB1));
    expect(err.code).toBe('42501');
    expect(err.message).toMatch(/pipeline_stage_id must belong to the deal's organization/i);
  });

  it('a deal CAN reference its own org’s pipeline and stage', async () => {
    const id = await mkDeal(orgA, pMove, `Own Refs ${RUN}`, pipeA, stA1);
    expect(id).toBeTruthy();
    await owner.query(`delete from public.deal_stage_history where deal_id=$1`, [id]);
    await owner.query(`delete from public.deals where id=$1`, [id]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// CHECK constraints
// ═════════════════════════════════════════════════════════════════════════════════

describe('CHECK constraints', () => {
  it('probability is confined to 0–100 (pipeline_stages_probability)', async () => {
    expect(
      await sqlstateOf(
        owner.query(
          `insert into public.pipeline_stages (org_id, pipeline_id, name, position, probability)
           values ($1,$2,'Too hot',0,101)`,
          [orgA, pipeA],
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlstateOf(
        owner.query(
          `insert into public.pipeline_stages (org_id, pipeline_id, name, position, probability)
           values ($1,$2,'Negative',0,-1)`,
          [orgA, pipeA],
        ),
      ),
    ).toBe('23514');
    for (const [i, ok] of [0, 50.25, 100].entries()) {
      const id = (
        await owner.query<{ id: string }>(
          `insert into public.pipeline_stages (org_id, pipeline_id, name, position, probability)
           values ($1,$2,$3,$4,$5) returning id`,
          [orgA, pipeA, `Prob ${ok} ${RUN}`, 10 + i, ok],
        )
      ).rows[0]!.id;
      await owner.query(`delete from public.pipeline_stages where id=$1`, [id]);
    }
  });

  it('color must be a #RRGGBB hex code when present (pipeline_stages_color)', async () => {
    expect(
      await sqlstateOf(
        owner.query(
          `insert into public.pipeline_stages (org_id, pipeline_id, name, position, color)
           values ($1,$2,'Bad color',13,'red')`,
          [orgA, pipeA],
        ),
      ),
    ).toBe('23514');
    const id = (
      await owner.query<{ id: string }>(
        `insert into public.pipeline_stages (org_id, pipeline_id, name, position, color)
         values ($1,$2,'Good color',13,'#0F9D58') returning id`,
        [orgA, pipeA],
      )
    ).rows[0]!.id;
    await owner.query(`delete from public.pipeline_stages where id=$1`, [id]);
  });

  it('is_won and is_lost are mutually exclusive (pipeline_stages_terminal)', async () => {
    expect(
      await sqlstateOf(
        owner.query(
          `insert into public.pipeline_stages
             (org_id, pipeline_id, name, position, is_won, is_lost)
           values ($1,$2,'Both',14,true,true)`,
          [orgA, pipeA],
        ),
      ),
    ).toBe('23514');
    const won = await mkStage(orgA, pipeA, `Won ${RUN}`, 2, { isWon: true, probability: 100 });
    const lost = await mkStage(orgA, pipeA, `Lost ${RUN}`, 3, { isLost: true });
    expect(won).toBeTruthy();
    expect(lost).toBeTruthy();
    await owner.query(`delete from public.pipeline_stages where id = any($1)`, [[won, lost]]);
  });

  it('a blank pipeline name is rejected (pipelines_name_not_blank)', async () => {
    expect(
      await sqlstateOf(
        owner.query(`insert into public.pipelines (org_id, name) values ($1,'  ')`, [orgA]),
      ),
    ).toBe('23514');
  });

  it('stage positions are unique within a pipeline (pipeline_stages_position_unique)', async () => {
    // stA1 already holds position 0 on pipeA.
    expect(
      await sqlstateOf(
        owner.query(
          `insert into public.pipeline_stages (org_id, pipeline_id, name, position)
           values ($1,$2,'Dup position',0)`,
          [orgA, pipeA],
        ),
      ),
    ).toBe('23505');
  });

  it('the same position on a different pipeline is fine', async () => {
    const tmp = await mkPipeline(orgA, `Pos Scope ${RUN}`);
    const id = (
      await owner.query<{ id: string }>(
        `insert into public.pipeline_stages (org_id, pipeline_id, name, position)
         values ($1,$2,'Pos zero elsewhere',0) returning id`,
        [orgA, tmp],
      )
    ).rows[0]!.id;
    expect(id).toBeTruthy();
    await owner.query(`delete from public.pipeline_stages where id=$1`, [id]);
    await owner.query(`delete from public.pipelines where id=$1`, [tmp]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// one live default pipeline per org
// ═════════════════════════════════════════════════════════════════════════════════

describe('one live default pipeline per org', () => {
  it('a second live default in the same org is rejected', async () => {
    // The 0039 trigger already seeded orgA's live default.
    expect(await sqlstateOf(mkPipeline(orgA, `Second default ${RUN}`, true))).toBe('23505');
  });

  it('setting is_default on a second pipeline while one is default is rejected', async () => {
    expect(
      await sqlstateOf(
        owner.query(`update public.pipelines set is_default=true where id=$1`, [pipeA2]),
      ),
    ).toBe('23505');
  });

  it('the index is per-org: orgA and orgB each hold a live default', async () => {
    const rows = (
      await owner.query<{ org_id: string }>(
        `select org_id from public.pipelines
         where is_default and deleted_at is null and org_id = any($1)`,
        [[orgA, orgB]],
      )
    ).rows.map((r) => r.org_id);
    expect(rows).toEqual(expect.arrayContaining([orgA, orgB]));
  });

  it('a soft-deleted default frees the slot: a replacement default can be promoted', async () => {
    // 0037: the partial index is WHERE is_default AND deleted_at IS NULL.
    // A third org keeps this test isolated from the shared fixtures; its
    // default comes from the 0039 auto-seed.
    const orgC = await mkOrg(`pipe-${RUN}-c`);
    const first = await defaultPipelineOf(orgC);
    await owner.query(`update public.pipelines set deleted_at = now() where id=$1`, [first]);
    const second = await mkPipeline(orgC, `C default 2 ${RUN}`, true);
    expect(second).toBeTruthy();
    // The 0039 auto-seed gives `first` six stages; stages must go before pipelines.
    await owner.query(`delete from public.pipeline_stages where pipeline_id = any($1)`, [
      [first, second],
    ]);
    await owner.query(`delete from public.pipelines where id = any($1)`, [[first, second]]);
  });

  it('non-default pipelines are unlimited', async () => {
    const id = await mkPipeline(orgA, `Another ${RUN}`);
    expect(id).toBeTruthy();
    await owner.query(`delete from public.pipelines where id=$1`, [id]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// soft delete
// ═════════════════════════════════════════════════════════════════════════════════

describe('soft delete', () => {
  it('a soft-deleted pipeline disappears from app_user reads', async () => {
    // 0037 extends public.crm_soft_delete()'s allowlist with
    // 'pipeline' → 'pipelines'. Stages and history stay outside the allowlist
    // deliberately: no runtime delete path exists for them.
    await inContext(ctxOf(pManage), `select public.crm_soft_delete('pipeline', $1::uuid)`, [
      pipeDoomed,
    ]);
    const ids = (
      await inContext<{ id: string }>(ctxOf(pView), `select id from public.pipelines`)
    ).map((r) => r.id);
    expect(ids).not.toContain(pipeDoomed);
    const ownerRow = (
      await owner.query<{ deleted_at: string | null }>(
        `select deleted_at from public.pipelines where id=$1`,
        [pipeDoomed],
      )
    ).rows[0]!;
    expect(ownerRow.deleted_at).not.toBeNull();
  });

  it('app_user cannot hard-delete a pipeline', async () => {
    expect(
      await sqlstateOf(
        inContext(ctxOf(pManage), `delete from public.pipelines where id=$1`, [pipeA2]),
      ),
    ).toBe('42501');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// deal_stage_history is append-only: no delete path
// ═════════════════════════════════════════════════════════════════════════════════

describe('history has no delete path', () => {
  it('app_user cannot hard-delete a history row', async () => {
    const target = (
      await owner.query<{ id: string }>(
        `select id from public.deal_stage_history where org_id=$1 limit 1`,
        [orgA],
      )
    ).rows[0]?.id;
    expect(target).toBeTruthy();
    expect(
      await sqlstateOf(
        inContext(ctxOf(pManage), `delete from public.deal_stage_history where id=$1`, [target]),
      ),
    ).toBe('42501');
  });

  it('the catalogue grants no DELETE policy on deal_stage_history', async () => {
    // pg_policy.polcmd is a char: 'd' would be a FOR DELETE policy row.
    // The append-only contract is enforced by simply having none.
    const { rows } = await owner.query<{ polname: string }>(
      `select p.polname
       from pg_policy p
       join pg_class c on c.oid = p.polrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname='public' and c.relname='deal_stage_history'
         and p.polcmd = 'd'`,
    );
    expect(rows).toEqual([]);
  });
});

describe('history update rules', () => {
  it('history is append-only: even a deals.edit holder updates zero rows', async () => {
    // 0037 deliberately ships NO UPDATE policy on deal_stage_history (F3
    // security review) — history rows are written once by the recorder
    // trigger and never modified. The application never updates history rows,
    // and the database enforces it: UPDATE touches zero rows, fail closed.
    const target = (
      await owner.query<{ id: string }>(
        `select id from public.deal_stage_history where org_id=$1 limit 1`,
        [orgA],
      )
    ).rows[0]?.id;
    expect(target).toBeTruthy();
    const rows = await inContext(
      ctxOf(pMove),
      `update public.deal_stage_history set changed_at = now() where id=$1 returning id`,
      [target],
    );
    expect(rows).toHaveLength(0);
  });

  it('history update without deals.edit touches zero rows', async () => {
    const target = (
      await owner.query<{ id: string }>(
        `select id from public.deal_stage_history where org_id=$1 limit 1`,
        [orgA],
      )
    ).rows[0]?.id;
    expect(target).toBeTruthy();
    const rows = await inContext(
      ctxOf(pView),
      `update public.deal_stage_history set changed_at = now() where id=$1 returning id`,
      [target],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('FORCE RLS is on for all three tables', () => {
  it('pg_class.relforcerowsecurity is true for pipelines, pipeline_stages, deal_stage_history', async () => {
    const rows = await owner.query<{ tablename: string; rls: boolean; force: boolean }>(
      `select c.relname as tablename, c.relrowsecurity as rls, c.relforcerowsecurity as force
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('pipelines', 'pipeline_stages', 'deal_stage_history')`,
    );
    expect(rows.rows.map((r) => r.tablename).sort()).toEqual([
      'deal_stage_history',
      'pipeline_stages',
      'pipelines',
    ]);
    for (const r of rows.rows) {
      expect(r.rls, r.tablename).toBe(true);
      expect(r.force, r.tablename).toBe(true);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// permission catalogue
// ═════════════════════════════════════════════════════════════════════════════════

describe('permission catalogue', () => {
  it('seeds the 5 pipeline keys, not sensitive', async () => {
    const rows = await owner.query<{ key: string; module: string; is_sensitive: boolean }>(
      `select key, module, is_sensitive from public.permissions
       where key like 'pipelines.%' or key like 'pipeline_stages.%' order by key`,
    );
    expect(rows.rows.map((r) => r.key).sort()).toEqual(
      [
        'pipeline_stages.manage',
        'pipelines.create',
        'pipelines.delete',
        'pipelines.edit',
        'pipelines.view',
      ].sort(),
    );
    for (const r of rows.rows) {
      expect(r.module).toBe('crm');
      expect(r.is_sensitive).toBe(false);
    }
  });

  it('ADMIN holds all five keys at GLOBAL from the seed matrix', async () => {
    // 0037: pipeline configuration is an admin surface — ADMIN and
    // SUPER_ADMIN hold the five keys at GLOBAL; no other role is granted
    // pipeline keys.
    const rows = await owner.query<{ role: string; key: string; scope: string }>(
      `select r.key as role, p.key as key, rp.scope::text as scope
       from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
       where r.org_id = $1
         and r.key = 'ADMIN'
         and (p.key like 'pipelines.%' or p.key like 'pipeline_stages.%')`,
      [orgA],
    );
    const have = new Set(rows.rows.map((r) => `${r.role}|${r.key}|${r.scope}`));
    for (const k of [
      'pipelines.view',
      'pipelines.create',
      'pipelines.edit',
      'pipelines.delete',
      'pipeline_stages.manage',
    ]) {
      expect(have.has(`ADMIN|${k}|GLOBAL`), k).toBe(true);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// audit
// ═════════════════════════════════════════════════════════════════════════════════

describe('audit trail', () => {
  it('attaches exactly one enabled audit trigger per pipeline table', async () => {
    const { rows } = await owner.query<{ relname: string; tgname: string; tgenabled: string }>(
      `select c.relname, t.tgname, t.tgenabled
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_proc p on p.oid = t.tgfoid
       where n.nspname='public' and p.proname='audit_row_change'
         and c.relname in ('pipelines', 'pipeline_stages', 'deal_stage_history')
       order by c.relname`,
    );
    // 0037 attaches audit_row_change to all three tables (entity types
    // 'pipeline' / 'pipeline_stage' / 'deal_stage_history', severity HIGH).
    expect(rows.map((r) => r.relname)).toEqual([
      'deal_stage_history',
      'pipeline_stages',
      'pipelines',
    ]);
    for (const r of rows) {
      expect(r.tgname, r.relname).toBe(`${r.relname}_audit`);
      expect(r.tgenabled, r.relname).toBe('O');
    }
  });

  it('pipeline writes land in audit_logs', async () => {
    const id = (
      await inContext<{ id: string }>(
        ctxOf(pManage),
        `insert into public.pipelines (org_id, name) values ($1,$2) returning id`,
        [orgA, `Audit Pipe ${RUN}`],
      )
    )[0]!.id;

    // 0037: audit_row_change('pipeline', 'HIGH', 'id') — pipeline
    // configuration changes are access-affecting, hence HIGH.
    const entry = await owner.query<{ severity: string; after: Record<string, unknown> }>(
      `select severity, after from public.audit_logs
       where entity_type='pipeline' and entity_id=$1 order by occurred_at desc limit 1`,
      [id],
    );
    expect(entry.rows).toHaveLength(1);
    expect(entry.rows[0]!.severity).toBe('HIGH');
    expect(entry.rows[0]!.after).toMatchObject({ name: `Audit Pipe ${RUN}` });
  });
});
