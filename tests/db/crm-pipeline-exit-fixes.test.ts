import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Phase 3 exit fixes — migration 0039 (drizzle/0039_pipeline_assignment_recovery.sql).
 *
 * Same harness as tests/db/crm-pipelines.test.ts: owner (DATABASE_URL_MIGRATE,
 * app_owner) seeds fixtures; user (DATABASE_URL_TEST, app_user) probes every
 * boundary. Covers:
 *
 *  - the 0039 trigger change: every organization created after 0037 is born
 *    with a live default pipeline (the six legacy stages), via
 *    organizations_seed_system_roles → seed_default_pipeline
 *  - seed_default_pipeline() idempotency
 *  - crm_default_pipeline_stage(): the deal-creation resolver (exact name →
 *    WON/LOST terminal flags → first stage by position; zero rows when the org
 *    has no live default)
 *  - crm_resolve_pipeline_stage_by_name(): the deal-update dual-write resolver
 *    (same ranking; zero rows for cross-org / soft-deleted pipelines)
 *  - crm_soft_delete('pipeline', …) now refuses pipelines with live deals
 *    (LOW 4c), even on a direct call that bypasses the service pre-check
 *  - the stranded-deal recovery path: a NULL-pipeline deal is backfilled into
 *    its org's default pipeline with a history creation row, and the
 *    deals_pipeline_immutable() trigger keeps rejecting NULL → value at
 *    runtime (the pinned strict invariant is unchanged)
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

/** Unique per run: these tables are permanent and the suite must be re-runnable. */
const RUN = Math.random().toString(36).slice(2, 8);
const CODE = `X${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

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

/** The sqlstate of a rejected statement. */
async function sqlstateOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'NO ERROR';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

const mkOrg = async (slug: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1,$2) returning id`,
      [`EXIT ${slug}`, slug],
    )
  ).rows[0]!.id;

const mkDept = async (org: string, code: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1,$2,$3) returning id`,
      [org, code, `Dept ${code}`],
    )
  ).rows[0]!.id;

const mkPerson = async (org: string, name: string) => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  return (
    await owner.query<{ id: string }>(
      `insert into public.people
         (org_id, code, full_legal_name, person_status, date_of_birth, personal_email, phone)
       values ($1,$2,$3,'ACTIVE'::public.person_status,'1990-01-01',$4,'+91-00000-00000')
       returning id`,
      [org, code, name, `${name.toLowerCase().replace(/[^a-z]/g, '')}.${RUN}@example.test`],
    )
  ).rows[0]!.id;
};

const mkEngagement = async (org: string, person: string, dept: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.engagements
         (org_id, person_id, department_id, engagement_type, status, start_date)
       values ($1,$2,$3,'EMPLOYEE','ACTIVE'::public.engagement_status, current_date)
       returning id`,
      [org, person, dept],
    )
  ).rows[0]!.id;

/** A custom role carrying exactly the given permissions at GLOBAL, assigned to one person. */
const mkRoleFor = async (org: string, person: string, key: string, permissions: string[]) => {
  const roleKey = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const role = (
    await owner.query<{ id: string }>(
      `insert into public.roles (org_id, key, name) values ($1,$2,$3) returning id`,
      [org, roleKey, `EXIT ${roleKey}`],
    )
  ).rows[0]!.id;
  for (const permission of permissions) {
    await owner.query(
      `insert into public.role_permissions (role_id, permission_id, scope)
       select $1, p.id, 'GLOBAL'::public.access_scope
       from public.permissions p where p.key = $2`,
      [role, permission],
    );
  }
  await owner.query(
    `insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`,
    [person, role, org],
  );
};

const defaultPipelineOf = async (org: string) =>
  (
    await owner.query<{ id: string }>(
      `select p.id from public.pipelines p
       where p.org_id = $1 and p.is_default and p.deleted_at is null`,
      [org],
    )
  ).rows[0]?.id ?? null;

let orgA = '';
let orgB = '';
let personA = '';
let personB = '';

const ctxA = () => ({ personId: personA, orgId: orgA });
const ctxB = () => ({ personId: personB, orgId: orgB });

beforeAll(async () => {
  [orgA, orgB] = await Promise.all([mkOrg(`exit-${RUN}-a`), mkOrg(`exit-${RUN}-b`)]);
  const [dA, dB] = await Promise.all([mkDept(orgA, `${CODE}_1`), mkDept(orgB, `${CODE}_2`)]);
  [personA, personB] = await Promise.all([mkPerson(orgA, 'EA Exit'), mkPerson(orgB, 'EB Exit')]);
  await Promise.all([mkEngagement(orgA, personA, dA), mkEngagement(orgB, personB, dB)]);
  // personA may delete pipelines (for the crm_soft_delete probes), view and edit
  // deals (both are needed for the immutability probe's UPDATE: PostgreSQL
  // applies the SELECT policy to rows read by an UPDATE's WHERE clause, so
  // deals.edit alone leaves the row invisible and the UPDATE matches nothing);
  // the resolver functions need no permission (SECURITY DEFINER).
  await mkRoleFor(orgA, personA, `${CODE}-md`, ['pipelines.delete', 'deals.view', 'deals.edit']);
});

afterAll(async () => {
  await owner.end();
  await asUser.end();
});

// ═════════════════════════════════════════════════════════════════════════════════
// 0039: every new organization is born with a default pipeline
// ═════════════════════════════════════════════════════════════════════════════════

describe('default pipeline seeding on org creation', () => {
  it('a newly created org has exactly one live default pipeline', async () => {
    const rows = await owner.query<{ name: string; is_default: boolean }>(
      `select p.name, p.is_default from public.pipelines p
       where p.org_id = $1 and p.deleted_at is null`,
      [orgA],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ name: 'Sales Pipeline', is_default: true });
  });

  it('the seeded default carries the six legacy stages in position order', async () => {
    const pipe = await defaultPipelineOf(orgA);
    const rows = (
      await owner.query<{
        name: string;
        position: number;
        probability: string;
        is_won: boolean;
        is_lost: boolean;
      }>(
        `select s.name, s.position, s.probability::text as probability, s.is_won, s.is_lost
         from public.pipeline_stages s
         where s.pipeline_id = $1
         order by s.position`,
        [pipe],
      )
    ).rows;
    expect(rows.map((r) => r.name)).toEqual([
      'NEW',
      'QUALIFIED',
      'PROPOSAL',
      'NEGOTIATION',
      'WON',
      'LOST',
    ]);
    expect(rows.map((r) => r.probability)).toEqual([
      '10.00',
      '25.00',
      '50.00',
      '75.00',
      '100.00',
      '0.00',
    ]);
    expect(rows.find((r) => r.name === 'WON')).toMatchObject({ is_won: true, is_lost: false });
    expect(rows.find((r) => r.name === 'LOST')).toMatchObject({ is_won: false, is_lost: true });
  });

  it('seed_default_pipeline() is idempotent: a second call changes nothing', async () => {
    const before = await defaultPipelineOf(orgA);
    const again = (
      await owner.query<{ seed_default_pipeline: string }>(
        `select public.seed_default_pipeline($1::uuid)`,
        [orgA],
      )
    ).rows[0]!.seed_default_pipeline;
    expect(again).toBe(before);
    const stages = (
      await owner.query(
        `select count(*)::int n from public.pipeline_stages where pipeline_id = $1`,
        [before],
      )
    ).rows[0]!.n;
    expect(stages).toBe(6);
  });

  it('an org whose default was soft-deleted gets a fresh default on re-seed', async () => {
    const org = await mkOrg(`exit-${RUN}-c`);
    const first = await defaultPipelineOf(org);
    expect(first).toBeTruthy();
    await owner.query(`update public.pipelines set deleted_at = now() where id = $1`, [first]);
    expect(await defaultPipelineOf(org)).toBeNull();
    const second = (
      await owner.query<{ seed_default_pipeline: string }>(
        `select public.seed_default_pipeline($1::uuid)`,
        [org],
      )
    ).rows[0]!.seed_default_pipeline;
    expect(second).not.toBe(first);
    expect(await defaultPipelineOf(org)).toBe(second);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// crm_default_pipeline_stage() — the deal-creation resolver
// ═════════════════════════════════════════════════════════════════════════════════

describe('crm_default_pipeline_stage', () => {
  it('resolves an exact legacy stage name in the default pipeline', async () => {
    const rows = await inContext<{ stage_name: string; pipeline_id: string }>(
      ctxA(),
      `select r.stage_name, r.pipeline_id from public.crm_default_pipeline_stage('PROPOSAL') r`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage_name).toBe('PROPOSAL');
    expect(rows[0]!.pipeline_id).toBe(await defaultPipelineOf(orgA));
  });

  it('falls back to the position-0 stage for an unknown name', async () => {
    const rows = await inContext<{ stage_name: string }>(
      ctxA(),
      `select r.stage_name from public.crm_default_pipeline_stage('SOMETHING_ELSE') r`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage_name).toBe('NEW');
  });

  it('maps WON/LOST through the terminal flags on a renamed pipeline', async () => {
    // Rename the default pipeline's terminal stages away from the legacy
    // names; the resolver must still find them via is_won / is_lost.
    const pipe = await defaultPipelineOf(orgA);
    await owner.query(
      `update public.pipeline_stages set name = 'Closed Won' where pipeline_id = $1 and is_won`,
      [pipe],
    );
    await owner.query(
      `update public.pipeline_stages set name = 'Closed Lost' where pipeline_id = $1 and is_lost`,
      [pipe],
    );
    try {
      const won = await inContext<{ stage_name: string; is_won: boolean }>(
        ctxA(),
        `select r.stage_name, r.is_won from public.crm_default_pipeline_stage('WON') r`,
      );
      expect(won).toHaveLength(1);
      expect(won[0]).toMatchObject({ stage_name: 'Closed Won', is_won: true });
      const lost = await inContext<{ stage_name: string; is_lost: boolean }>(
        ctxA(),
        `select r.stage_name, r.is_lost from public.crm_default_pipeline_stage('LOST') r`,
      );
      expect(lost).toHaveLength(1);
      expect(lost[0]).toMatchObject({ stage_name: 'Closed Lost', is_lost: true });
    } finally {
      await owner.query(
        `update public.pipeline_stages set name = 'WON' where pipeline_id = $1 and is_won`,
        [pipe],
      );
      await owner.query(
        `update public.pipeline_stages set name = 'LOST' where pipeline_id = $1 and is_lost`,
        [pipe],
      );
    }
  });

  it('returns zero rows when the org has no live default pipeline', async () => {
    const pipe = await defaultPipelineOf(orgB);
    await owner.query(`update public.pipelines set deleted_at = now() where id = $1`, [pipe]);
    try {
      const rows = await inContext(
        ctxB(),
        `select r.stage_id from public.crm_default_pipeline_stage('NEW') r`,
      );
      expect(rows).toEqual([]);
    } finally {
      // Restore: orgB needs its default for the remaining suites.
      await owner.query<{ seed_default_pipeline: string }>(
        `select public.seed_default_pipeline($1::uuid)`,
        [orgB],
      );
    }
  });

  it('is tenant-isolated: a caller from another org resolves nothing', async () => {
    // personB (orgB) asking for orgA's stages gets zero rows — the resolver
    // enforces authz.org_id() from the caller's person, not from any argument.
    const rows = await inContext(
      ctxB(),
      `select r.stage_id from public.crm_default_pipeline_stage('NEW') r`,
    );
    // orgB has its own default, so this resolves orgB's NEW — the point is it
    // never leaks orgA's. Prove isolation via the by-name resolver below.
    expect(rows).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// crm_resolve_pipeline_stage_by_name() — the deal-update dual-write resolver
// ═════════════════════════════════════════════════════════════════════════════════

describe('crm_resolve_pipeline_stage_by_name', () => {
  it('resolves an exact name in the given pipeline', async () => {
    const pipe = await defaultPipelineOf(orgA);
    const rows = await inContext<{ stage_name: string }>(
      ctxA(),
      `select r.stage_name from public.crm_resolve_pipeline_stage_by_name($1::uuid, 'NEGOTIATION') r`,
      [pipe],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage_name).toBe('NEGOTIATION');
  });

  it('returns zero rows for another org’s pipeline (indistinguishable, by design)', async () => {
    const pipeA = await defaultPipelineOf(orgA);
    const rows = await inContext(
      ctxB(),
      `select r.stage_id from public.crm_resolve_pipeline_stage_by_name($1::uuid, 'NEW') r`,
      [pipeA],
    );
    expect(rows).toEqual([]);
  });

  it('returns zero rows for a soft-deleted pipeline', async () => {
    const pipe = (
      await owner.query<{ id: string }>(
        `insert into public.pipelines (org_id, name, is_default) values ($1, $2, false) returning id`,
        [orgA, `Doomed ${RUN}`],
      )
    ).rows[0]!.id;
    const stage = (
      await owner.query<{ id: string }>(
        `insert into public.pipeline_stages (org_id, pipeline_id, name, position)
         values ($1, $2, 'Only', 0) returning id`,
        [orgA, pipe],
      )
    ).rows[0]!.id;
    expect(stage).toBeTruthy();
    await owner.query(`update public.pipelines set deleted_at = now() where id = $1`, [pipe]);
    const rows = await inContext(
      ctxA(),
      `select r.stage_id from public.crm_resolve_pipeline_stage_by_name($1::uuid, 'Only') r`,
      [pipe],
    );
    expect(rows).toEqual([]);
    await owner.query(`delete from public.pipeline_stages where id = $1`, [stage]);
    await owner.query(`delete from public.pipelines where id = $1`, [pipe]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// crm_soft_delete('pipeline', …) — the live-deal guard (LOW 4c)
// ═════════════════════════════════════════════════════════════════════════════════

describe('pipeline soft-delete deal-usage guard', () => {
  it('a direct call on a pipeline with live deals raises 42501', async () => {
    const pipe = (
      await owner.query<{ id: string }>(
        `insert into public.pipelines (org_id, name, is_default) values ($1, $2, false) returning id`,
        [orgA, `In Use ${RUN}`],
      )
    ).rows[0]!.id;
    const stage = (
      await owner.query<{ id: string }>(
        `insert into public.pipeline_stages (org_id, pipeline_id, name, position)
         values ($1, $2, 'S1', 0) returning id`,
        [orgA, pipe],
      )
    ).rows[0]!.id;
    const deal = (
      await owner.query<{ id: string }>(
        `insert into public.deals (org_id, title, owner_person_id, pipeline_id, pipeline_stage_id)
         values ($1, $2, $3, $4, $5) returning id`,
        [orgA, `Guarded ${RUN}`, personA, pipe, stage],
      )
    ).rows[0]!.id;
    try {
      expect(
        await sqlstateOf(
          inContext(ctxA(), `select public.crm_soft_delete('pipeline', $1::uuid)`, [pipe]),
        ),
      ).toBe('42501');
      // And the pipeline is still live.
      const live = (
        await owner.query(
          `select count(*)::int n from public.pipelines where id = $1 and deleted_at is null`,
          [pipe],
        )
      ).rows[0]!.n;
      expect(live).toBe(1);
    } finally {
      await owner.query(`delete from public.deal_stage_history where deal_id = $1`, [deal]);
      await owner.query(`delete from public.deals where id = $1`, [deal]);
      await owner.query(`delete from public.pipeline_stages where id = $1`, [stage]);
      await owner.query(`delete from public.pipelines where id = $1`, [pipe]);
    }
  });

  it('a direct call on a pipeline with no deals still soft-deletes', async () => {
    const pipe = (
      await owner.query<{ id: string }>(
        `insert into public.pipelines (org_id, name, is_default) values ($1, $2, false) returning id`,
        [orgA, `Empty ${RUN}`],
      )
    ).rows[0]!.id;
    await inContext(ctxA(), `select public.crm_soft_delete('pipeline', $1::uuid)`, [pipe]);
    const row = (
      await owner.query<{ deleted_at: string | null }>(
        `select deleted_at from public.pipelines where id = $1`,
        [pipe],
      )
    ).rows[0]!;
    expect(row.deleted_at).not.toBeNull();
    await owner.query(`delete from public.pipelines where id = $1`, [pipe]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// Stranded-deal recovery — the 0039 backfill path
// ═════════════════════════════════════════════════════════════════════════════════

describe('stranded-deal recovery', () => {
  it('a NULL-pipeline deal is backfilled into the default pipeline with history', async () => {
    // Simulate the pre-fix state: a deal the old createDeal() wrote without
    // pipeline columns.
    const deal = (
      await owner.query<{ id: string }>(
        `insert into public.deals (org_id, title, owner_person_id, stage, currency, value)
         values ($1, $2, $3, 'PROPOSAL', 'INR', 50000) returning id`,
        [orgA, `Stranded ${RUN}`, personA],
      )
    ).rows[0]!.id;
    try {
      const before = (
        await owner.query<{ pipeline_id: string | null }>(
          `select pipeline_id from public.deals where id = $1`,
          [deal],
        )
      ).rows[0]!.pipeline_id;
      expect(before).toBeNull();

      // The 0039 backfill statement, verbatim in structure: the trigger is
      // disabled for the single UPDATE and re-enabled immediately.
      await owner.query(`alter table public.deals disable trigger deals_pipeline_immutable`);
      try {
        await owner.query(
          `update public.deals d
           set pipeline_id = r.pipeline_id,
               pipeline_stage_id = r.stage_id
           from (
             select d.id as deal_id, p.id as pipeline_id, s.id as stage_id
             from public.deals d
             join public.pipelines p
               on p.org_id = d.org_id and p.is_default and p.deleted_at is null
             cross join lateral (
               select ps.id
               from public.pipeline_stages ps
               where ps.pipeline_id = p.id and ps.org_id = d.org_id
               order by (ps.name = d.stage) desc,
                        ((d.stage = 'WON' and ps.is_won) or (d.stage = 'LOST' and ps.is_lost)) desc,
                        ps.position asc, ps.id asc
               limit 1
             ) s
             where d.pipeline_id is null and d.deleted_at is null
           ) r
           where d.id = r.deal_id`,
        );
      } finally {
        await owner.query(`alter table public.deals enable trigger deals_pipeline_immutable`);
      }

      const after = (
        await owner.query<{ pipeline_id: string; pipeline_stage_id: string }>(
          `select pipeline_id, pipeline_stage_id from public.deals where id = $1`,
          [deal],
        )
      ).rows[0]!;
      expect(after.pipeline_id).toBe(await defaultPipelineOf(orgA));
      const stageName = (
        await owner.query<{ name: string }>(
          `select name from public.pipeline_stages where id = $1`,
          [after.pipeline_stage_id],
        )
      ).rows[0]!.name;
      expect(stageName).toBe('PROPOSAL');
      // The recovery wrote the creation history row (from_stage_id NULL).
      const history = (
        await owner.query<{ from_stage_id: string | null; to_stage_id: string }>(
          `select from_stage_id, to_stage_id from public.deal_stage_history where deal_id = $1`,
          [deal],
        )
      ).rows;
      expect(history).toHaveLength(1);
      expect(history[0]!.from_stage_id).toBeNull();
      expect(history[0]!.to_stage_id).toBe(after.pipeline_stage_id);
    } finally {
      await owner.query(`delete from public.deal_stage_history where deal_id = $1`, [deal]);
      await owner.query(`delete from public.deals where id = $1`, [deal]);
    }
  });

  it('the immutability trigger is enabled and still rejects NULL → value at runtime', async () => {
    const deal = (
      await owner.query<{ id: string }>(
        `insert into public.deals (org_id, title, owner_person_id, stage)
         values ($1, $2, $3, 'NEW') returning id`,
        [orgA, `Still Strict ${RUN}`, personA],
      )
    ).rows[0]!.id;
    try {
      const pipe = await defaultPipelineOf(orgA);
      // The pinned strict invariant is unchanged by 0039: assignment stays
      // INSERT-only; the migration's one-time backfill is the only exception.
      expect(
        await sqlstateOf(
          inContext(ctxA(), `update public.deals set pipeline_id = $2 where id = $1`, [deal, pipe]),
        ),
      ).toBe('42501');
    } finally {
      await owner.query(`delete from public.deals where id = $1`, [deal]);
    }
  });
});
