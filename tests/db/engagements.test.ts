import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Task 1.5 — engagements and authz.is_active().
 *
 * The assertion that matters most: a person existing does NOT mean that person has
 * access. Access comes from an ACTIVE engagement, and the check reads the table on every
 * query, so a status change takes effect on the next request with nothing to expire.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random().toString(36).slice(2, 8);
const CODE = `E${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

let orgA = '';
let orgB = '';
let orgSuspended = '';
let alice = ''; // orgA, ACTIVE engagement
let bob = ''; // orgA, no engagement at all
let mgr = ''; // orgA, manager
let carol = ''; // orgB
let dave = ''; // orgSuspended, ACTIVE engagement in a SUSPENDED org
let deptA = '';
let deptB = '';
let deptS = '';
let teamA = '';

async function inContext<T>(
  ctx: { personId?: string | null; orgId?: string | null },
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
    const r = await c.query(sql, params);
    await c.query('commit');
    return r.rows as T[];
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

const mkPerson = async (org: string, name: string) => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  return (
    await owner.query<{ id: string }>(
      `insert into public.people (org_id,code,full_legal_name,person_status)
       values ($1,$2,$3,'ACTIVE') returning id`,
      [org, code, name],
    )
  ).rows[0]!.id;
};

const mkEngagement = async (
  org: string,
  person: string,
  dept: string,
  status = 'ACTIVE',
  isPrimary = true,
) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.engagements
         (org_id, person_id, department_id, engagement_type, status, start_date, is_primary)
       values ($1,$2,$3,'EMPLOYEE',$4::public.engagement_status, current_date, $5) returning id`,
      [org, person, dept, status, isPrimary],
    )
  ).rows[0]!.id;

beforeAll(async () => {
  const mkOrg = async (s: string, status = 'ACTIVE') =>
    (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name,slug,status) values ($1,$2,$3) returning id`,
        [`Eng ${s}`, `eng-${RUN}-${s}`, status],
      )
    ).rows[0]!.id;
  orgA = await mkOrg('a');
  orgB = await mkOrg('b');
  orgSuspended = await mkOrg('s', 'SUSPENDED');

  const mkDept = async (org: string, code: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.departments (org_id,code,name) values ($1,$2,$3) returning id`,
        [org, code, `Dept ${code}`],
      )
    ).rows[0]!.id;
  deptA = await mkDept(orgA, `${CODE}_A`);
  deptB = await mkDept(orgB, `${CODE}_B`);
  deptS = await mkDept(orgSuspended, `${CODE}_S`);

  teamA = (
    await owner.query<{ id: string }>(
      `insert into public.teams (org_id,department_id,name) values ($1,$2,'TeamA') returning id`,
      [orgA, deptA],
    )
  ).rows[0]!.id;

  alice = await mkPerson(orgA, 'Alice');
  bob = await mkPerson(orgA, 'Bob');
  mgr = await mkPerson(orgA, 'Manager');
  carol = await mkPerson(orgB, 'Carol');
  dave = await mkPerson(orgSuspended, 'Dave');

  await mkEngagement(orgA, alice, deptA, 'ACTIVE');
  await mkEngagement(orgB, carol, deptB, 'ACTIVE');
  await mkEngagement(orgSuspended, dave, deptS, 'ACTIVE');
  // bob deliberately has NO engagement.
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
  await asUser.end().catch(() => undefined);
});

describe('structure', () => {
  it('created engagements with a uuid primary key', async () => {
    const { rows } = await owner.query<{ data_type: string }>(
      `select data_type from information_schema.columns
       where table_schema='public' and table_name='engagements' and column_name='id'`,
    );
    expect(rows[0]!.data_type).toBe('uuid');
  });

  it('uses the seven authoritative engagement statuses and no recruitment states', async () => {
    const { rows } = await owner.query<{ l: string }>(
      `select unnest(enum_range(null::public.engagement_status))::text l order by 1`,
    );
    const labels = rows.map((r) => r.l).sort();
    expect(labels).toEqual(
      [
        'ACTIVE',
        'ARCHIVED',
        'NOTICE_PERIOD',
        'OFFBOARDING',
        'ONBOARDING',
        'PRE_ONBOARDING',
        'SUSPENDED',
      ].sort(),
    );
    // Recruitment lives in its own module; a CANDIDATE row must not be able to exist in
    // the table that grants organizational access.
    for (const forbidden of ['CANDIDATE', 'OFFER', 'APPLICATION', 'SCREENING', 'INTERVIEW']) {
      expect(labels).not.toContain(forbidden);
    }
  });

  it('supports the configured engagement classifications', async () => {
    const { rows } = await owner.query<{ l: string }>(
      `select unnest(enum_range(null::public.engagement_type))::text l`,
    );
    expect(rows.map((r) => r.l).sort()).toEqual(
      [
        'CONSULTANT',
        'CONTRACTOR',
        'EMPLOYEE',
        'INTERN',
        'PART_TIME',
        'TEMPORARY',
        'TRAINEE',
      ].sort(),
    );
  });

  it('carries the composite foreign keys and the expected indexes', async () => {
    const fks = await owner.query<{ conname: string }>(
      `select conname from pg_constraint where contype='f' and conname in (
         'engagements_person_same_org','engagements_department_same_org',
         'engagements_team_same_org','engagements_manager_same_org')`,
    );
    expect(fks.rows).toHaveLength(4);

    const idx = await owner.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname='public' and indexname in (
         'one_primary_active_engagement','engagements_person_idx',
         'engagements_manager_idx','engagements_department_idx')`,
    );
    expect(idx.rows).toHaveLength(4);
  });

  it('rejects a person managing themselves and an end before the start', async () => {
    await expect(
      owner.query(
        `insert into public.engagements (org_id,person_id,department_id,engagement_type,start_date,manager_person_id)
         values ($1,$2,$3,'EMPLOYEE',current_date,$2)`,
        [orgA, bob, deptA],
      ),
    ).rejects.toThrow();
    await expect(
      owner.query(
        `insert into public.engagements (org_id,person_id,department_id,engagement_type,start_date,actual_end_date)
         values ($1,$2,$3,'EMPLOYEE',current_date, current_date - 1)`,
        [orgA, bob, deptA],
      ),
    ).rejects.toThrow();
  });
});

describe('one primary active engagement per person', () => {
  it('accepts the first active engagement', async () => {
    const p = await mkPerson(orgA, 'First');
    await expect(mkEngagement(orgA, p, deptA, 'ACTIVE')).resolves.toBeTruthy();
  });

  it('refuses a second live primary engagement', async () => {
    const p = await mkPerson(orgA, 'Second');
    await mkEngagement(orgA, p, deptA, 'ACTIVE');
    for (const status of ['ACTIVE', 'PRE_ONBOARDING', 'ONBOARDING', 'NOTICE_PERIOD']) {
      await expect(mkEngagement(orgA, p, deptA, status), status).rejects.toThrow();
    }
  });

  it('allows a historical engagement to coexist with a live one', async () => {
    const p = await mkPerson(orgA, 'Rehire');
    await mkEngagement(orgA, p, deptA, 'ARCHIVED');
    await expect(mkEngagement(orgA, p, deptA, 'ACTIVE')).resolves.toBeTruthy();
    const { rows } = await owner.query<{ n: string }>(
      `select count(*) n from public.engagements where person_id=$1`,
      [p],
    );
    expect(Number(rows[0]!.n), 'history is retained, not overwritten').toBe(2);
  });

  it('allows a non-primary engagement alongside a primary one', async () => {
    const p = await mkPerson(orgA, 'Secondary');
    await mkEngagement(orgA, p, deptA, 'ACTIVE', true);
    await expect(mkEngagement(orgA, p, deptA, 'ACTIVE', false)).resolves.toBeTruthy();
  });

  it('frees the slot when the live engagement is soft-deleted', async () => {
    const p = await mkPerson(orgA, 'SoftDeleted');
    const e = await mkEngagement(orgA, p, deptA, 'ACTIVE');
    await expect(mkEngagement(orgA, p, deptA, 'ACTIVE')).rejects.toThrow();
    await owner.query(`update public.engagements set deleted_at = now() where id=$1`, [e]);
    await expect(mkEngagement(orgA, p, deptA, 'ACTIVE')).resolves.toBeTruthy();
  });

  it('is enforced by PostgreSQL, not by application code', async () => {
    const { rows } = await owner.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where schemaname='public' and indexname='one_primary_active_engagement'`,
    );
    expect(rows[0]!.indexdef).toMatch(/UNIQUE/i);
    expect(rows[0]!.indexdef).toMatch(/is_primary/);
    expect(rows[0]!.indexdef).toMatch(/deleted_at IS NULL/i);
  });
});

describe('organization consistency', () => {
  it('accepts a fully same-organization engagement', async () => {
    const p = await mkPerson(orgA, 'SameOrg');
    await expect(
      owner.query(
        `insert into public.engagements
           (org_id,person_id,department_id,team_id,manager_person_id,engagement_type,start_date)
         values ($1,$2,$3,$4,$5,'EMPLOYEE',current_date)`,
        [orgA, p, deptA, teamA, mgr],
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses a person from another organization', async () => {
    await expect(mkEngagement(orgA, carol, deptA, 'ACTIVE')).rejects.toThrow();
  });

  it('refuses a department from another organization', async () => {
    const p = await mkPerson(orgA, 'CrossDept');
    await expect(mkEngagement(orgA, p, deptB, 'ACTIVE')).rejects.toThrow();
  });

  it('refuses a manager from another organization', async () => {
    const p = await mkPerson(orgA, 'CrossMgr');
    await expect(
      owner.query(
        `insert into public.engagements
           (org_id,person_id,department_id,manager_person_id,engagement_type,start_date)
         values ($1,$2,$3,$4,'EMPLOYEE',current_date)`,
        [orgA, p, deptA, carol],
      ),
    ).rejects.toThrow();
  });

  it('refuses a team from another organization', async () => {
    const p = await mkPerson(orgA, 'CrossTeam');
    const teamB = (
      await owner.query<{ id: string }>(
        `insert into public.teams (org_id,department_id,name) values ($1,$2,'TeamB') returning id`,
        [orgB, deptB],
      )
    ).rows[0]!.id;
    await expect(
      owner.query(
        `insert into public.engagements (org_id,person_id,department_id,team_id,engagement_type,start_date)
         values ($1,$2,$3,$4,'EMPLOYEE',current_date)`,
        [orgA, p, deptA, teamB],
      ),
    ).rejects.toThrow();
  });
});

describe('authz.is_active()', () => {
  it('is SECURITY DEFINER, STABLE, search_path empty, no PUBLIC execute', async () => {
    const { rows } = await owner.query<{
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
    }>(
      `select prosecdef, provolatile, proconfig from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='authz' and proname='is_active'`,
    );
    expect(rows[0]!.prosecdef).toBe(true);
    expect(rows[0]!.provolatile).toBe('s');
    expect(rows[0]!.proconfig ?? []).toContain('search_path=""');

    const acl = await owner.query<{ grantee: string }>(
      `select coalesce(pg_get_userbyid(nullif(ac.grantee,0)),'PUBLIC') grantee
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) ac
       where n.nspname='authz' and p.proname='is_active' and ac.privilege_type='EXECUTE'`,
    );
    const g = acl.rows.map((r) => r.grantee);
    expect(g).not.toContain('PUBLIC');
    expect(g).toContain('app_user');
    expect(g).toContain('app_admin');
  });

  it('is NOT people.person_status — a person with no engagement is not active', async () => {
    const st = await owner.query<{ s: string }>(
      `select person_status::text s from public.people where id=$1`,
      [bob],
    );
    expect(st.rows[0]!.s, 'Bob is an ACTIVE person').toBe('ACTIVE');

    const r = await inContext<{ a: boolean }>(
      { personId: bob, orgId: orgA },
      `select authz.is_active() a`,
    );
    expect(r[0]!.a, 'but has no engagement, so no access').toBe(false);
  });

  it('is true for an ACTIVE engagement in an ACTIVE organization', async () => {
    const r = await inContext<{ a: boolean }>(
      { personId: alice, orgId: orgA },
      `select authz.is_active() a`,
    );
    expect(r[0]!.a).toBe(true);
  });

  it('is false for every non-ACTIVE engagement status', async () => {
    for (const status of [
      'PRE_ONBOARDING',
      'ONBOARDING',
      'NOTICE_PERIOD',
      'SUSPENDED',
      'OFFBOARDING',
      'ARCHIVED',
    ]) {
      const p = await mkPerson(orgA, `Status ${status}`);
      await mkEngagement(orgA, p, deptA, status);
      const r = await inContext<{ a: boolean }>(
        { personId: p, orgId: orgA },
        `select authz.is_active() a`,
      );
      expect(r[0]!.a, status).toBe(false);
    }
  });

  it('is false when the organization itself is suspended', async () => {
    const r = await inContext<{ a: boolean }>(
      { personId: dave, orgId: orgSuspended },
      `select authz.is_active() a`,
    );
    expect(r[0]!.a, 'ACTIVE engagement but SUSPENDED organization').toBe(false);
  });

  it('reflects a database change immediately — no token to expire', async () => {
    const p = await mkPerson(orgA, 'Revoked');
    const e = await mkEngagement(orgA, p, deptA, 'ACTIVE');

    const before = await inContext<{ a: boolean }>(
      { personId: p, orgId: orgA },
      `select authz.is_active() a`,
    );
    expect(before[0]!.a).toBe(true);

    // Task 1.6 added the transition machine: a status change needs an authenticated
    // actor and a legal pair, so this goes through an identity context now.
    const c = await owner.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`,
        [alice, orgA],
      );
      await c.query(
        `update public.engagements set status='SUSPENDED'::public.engagement_status where id=$1`,
        [e],
      );
      await c.query('commit');
    } finally {
      c.release();
    }

    const after = await inContext<{ a: boolean }>(
      { personId: p, orgId: orgA },
      `select authz.is_active() a`,
    );
    expect(after[0]!.a, 'the very next query must see it').toBe(false);
  });

  it('fails closed for a soft-deleted engagement, deleted person and no identity', async () => {
    const p = await mkPerson(orgA, 'Deleted');
    const e = await mkEngagement(orgA, p, deptA, 'ACTIVE');
    await owner.query(`update public.engagements set deleted_at=now() where id=$1`, [e]);
    const r1 = await inContext<{ a: boolean }>(
      { personId: p, orgId: orgA },
      `select authz.is_active() a`,
    );
    expect(r1[0]!.a).toBe(false);

    const p2 = await mkPerson(orgA, 'GoneEntirely');
    await mkEngagement(orgA, p2, deptA, 'ACTIVE');
    await owner.query(`update public.people set deleted_at=now() where id=$1`, [p2]);
    const r2 = await inContext<{ a: boolean }>(
      { personId: p2, orgId: orgA },
      `select authz.is_active() a`,
    );
    expect(r2[0]!.a, 'no identity means no active engagement').toBe(false);

    const r3 = await asUser.query<{ a: boolean }>(`select authz.is_active() a`);
    expect(r3.rows[0]!.a).toBe(false);
  });

  it('fails closed on a mismatched tenant claim', async () => {
    const r = await inContext<{ a: boolean }>(
      { personId: alice, orgId: orgB },
      `select authz.is_active() a`,
    );
    expect(r[0]!.a).toBe(false);
  });

  it('remains distinct from is_active_person()', async () => {
    // Bob is a live identity with no engagement: usable identity, no access.
    const r = await inContext<{ person: boolean; access: boolean }>(
      { personId: bob, orgId: orgA },
      `select authz.is_active_person() person, authz.is_active() access`,
    );
    expect(r[0]!.person).toBe(true);
    expect(r[0]!.access).toBe(false);
  });
});

describe('RLS and privileges', () => {
  it('has RLS enabled and forced, and leaves no table in public unprotected', async () => {
    const { rows } = await owner.query<{ e: boolean; f: boolean }>(
      `select relrowsecurity e, relforcerowsecurity f from pg_class c
       join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and relname='engagements'`,
    );
    expect(rows[0]!.e).toBe(true);
    expect(rows[0]!.f).toBe(true);

    const unprotected = await owner.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind='r' and c.relname <> '__drizzle_migrations'
         and (not c.relrowsecurity or not c.relforcerowsecurity)`,
    );
    expect(unprotected.rows.map((r) => r.relname)).toEqual([]);
  });

  it('grants app_user no write privilege and no RLS bypass', async () => {
    const priv = await owner.query<{ p: string }>(
      `select privilege_type p from information_schema.table_privileges
       where grantee='app_user' and table_name='engagements'
         and privilege_type in ('INSERT','UPDATE','DELETE')`,
    );
    expect(priv.rows).toEqual([]);

    const role = await asUser.query<{ b: boolean; s: boolean }>(
      `select rolbypassrls b, rolsuper s from pg_roles where rolname=current_user`,
    );
    expect(role.rows[0]!.b).toBe(false);
    expect(role.rows[0]!.s).toBe(false);

    const owned = await asUser.query<{ n: number }>(
      `select count(*)::int n from pg_class c join pg_roles g on g.oid=c.relowner
       where g.rolname=current_user and c.relkind='r'`,
    );
    expect(owned.rows[0]!.n).toBe(0);
  });

  it('returns nothing without identity — no broad temporary policy', async () => {
    const { rows } = await asUser.query<{ n: string }>(`select count(*) n from public.engagements`);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('shows a person only their own engagement', async () => {
    const rows = await inContext<{ person_id: string }>(
      { personId: alice, orgId: orgA },
      `select person_id from public.engagements`,
    );
    expect(new Set(rows.map((r) => r.person_id))).toEqual(new Set([alice]));
  });

  it('lets a person still see their own ended engagement', async () => {
    const p = await mkPerson(orgA, 'Ended');
    await mkEngagement(orgA, p, deptA, 'OFFBOARDING');
    const rows = await inContext<{ status: string }>(
      { personId: p, orgId: orgA },
      `select status::text from public.engagements`,
    );
    expect(rows).toHaveLength(1);
  });

  it('denies a cross-tenant claim', async () => {
    const rows = await inContext<{ id: string }>(
      { personId: alice, orgId: orgB },
      `select id from public.engagements`,
    );
    expect(rows).toEqual([]);
  });
});

describe('pooled-connection isolation', () => {
  it('A and B never inherit each other engagement state', async () => {
    const a = await inContext<{ a: boolean }>(
      { personId: alice, orgId: orgA },
      `select authz.is_active() a`,
    );
    const b = await inContext<{ a: boolean }>(
      { personId: bob, orgId: orgA },
      `select authz.is_active() a`,
    );
    expect(a[0]!.a).toBe(true);
    expect(b[0]!.a).toBe(false);
  });

  it('alternating A/B/A/B stays isolated', async () => {
    for (const [pid, expected] of [
      [alice, true],
      [bob, false],
      [alice, true],
      [bob, false],
    ] as const) {
      const r = await inContext<{ a: boolean }>(
        { personId: pid, orgId: orgA },
        `select authz.is_active() a`,
      );
      expect(r[0]!.a).toBe(expected);
    }
  });

  it('a reused connection retains no engagement identity', async () => {
    await inContext({ personId: alice, orgId: orgA }, `select authz.is_active()`);
    const leaked = await asUser.query<{ a: boolean; n: string }>(
      `select authz.is_active() a, (select count(*) from public.engagements) n`,
    );
    expect(leaked.rows[0]!.a).toBe(false);
    expect(Number(leaked.rows[0]!.n)).toBe(0);
  });

  it('18 concurrent interleaved contexts stay isolated', async () => {
    const cases = [
      [alice, orgA, true],
      [bob, orgA, false],
      [carol, orgB, true],
    ] as const;
    const results = await Promise.all(
      Array.from({ length: 18 }, (_, i) => {
        const [pid, oid, expected] = cases[i % cases.length]!;
        return inContext<{ a: boolean }>(
          { personId: pid, orgId: oid },
          `select authz.is_active() a`,
        ).then((r) => ({ expected, got: r[0]!.a }));
      }),
    );
    for (const r of results) expect(r.got).toBe(r.expected);
  }, 60_000);
});
