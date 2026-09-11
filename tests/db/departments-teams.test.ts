import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Task 1.4 — departments, teams, team_members, person_departments.
 *
 * The centrepiece is organization consistency. Every cross-organization assertion below
 * is written as "the database refuses this", not "the service layer would not do this".
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random().toString(36).slice(2, 8);
// Department codes must start with a letter; base36 randomness frequently does not.
const CODE = `D${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

let orgA = '';
let orgB = '';
let alice = ''; // orgA
let bob = ''; // orgA
let carol = ''; // orgB
let deptEng = ''; // orgA
let deptOps = ''; // orgA, alice is NOT a member
let deptArchived = ''; // orgA, ARCHIVED
let deptDeleted = ''; // orgA, soft-deleted
let deptB = ''; // orgB
let teamCore = ''; // orgA / deptEng, alice is a member
let teamOther = ''; // orgA / deptEng, alice is NOT a member

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

beforeAll(async () => {
  const mkOrg = async (s: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.organizations (name,slug) values ($1,$2) returning id`,
        [`Dept ${s}`, `dept-${RUN}-${s}`],
      )
    ).rows[0]!.id;
  orgA = await mkOrg('a');
  orgB = await mkOrg('b');

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
  alice = await mkPerson(orgA, 'Alice');
  bob = await mkPerson(orgA, 'Bob');
  carol = await mkPerson(orgB, 'Carol');

  const mkDept = async (org: string, code: string, status = 'ACTIVE') =>
    (
      await owner.query<{ id: string }>(
        `insert into public.departments (org_id,code,name,status) values ($1,$2,$3,$4) returning id`,
        [org, code, `Dept ${code}`, status],
      )
    ).rows[0]!.id;
  deptEng = await mkDept(orgA, `${CODE}_ENG`);
  deptOps = await mkDept(orgA, `${CODE}_OPS`);
  deptArchived = await mkDept(orgA, `${CODE}_ARC`, 'ARCHIVED');
  deptDeleted = await mkDept(orgA, `${CODE}_DEL`);
  await owner.query(`update public.departments set deleted_at = now() where id = $1`, [
    deptDeleted,
  ]);
  deptB = await mkDept(orgB, `${CODE}_B`);

  const mkTeam = async (org: string, dept: string, name: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.teams (org_id,department_id,name) values ($1,$2,$3) returning id`,
        [org, dept, name],
      )
    ).rows[0]!.id;
  teamCore = await mkTeam(orgA, deptEng, 'Core');
  teamOther = await mkTeam(orgA, deptEng, 'Other');

  // Alice: member of teamCore, secondary member of deptEng, deptArchived and deptDeleted.
  await owner.query(
    `insert into public.team_members (org_id,team_id,person_id,role_in_team) values ($1,$2,$3,'dev')`,
    [orgA, teamCore, alice],
  );
  for (const d of [deptEng, deptArchived, deptDeleted]) {
    await owner.query(
      `insert into public.person_departments (org_id,person_id,department_id) values ($1,$2,$3)`,
      [orgA, alice, d],
    );
  }
  // Carol belongs to deptB in the other organization.
  await owner.query(
    `insert into public.person_departments (org_id,person_id,department_id) values ($1,$2,$3)`,
    [orgB, carol, deptB],
  );
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
  await asUser.end().catch(() => undefined);
});

describe('structure', () => {
  it('created all four tables with uuid primary keys', async () => {
    const { rows } = await owner.query<{ table_name: string; data_type: string }>(
      `select table_name, data_type from information_schema.columns
       where table_schema='public' and column_name='id'
         and table_name in ('departments','teams','team_members','person_departments')
       order by table_name`,
    );
    expect(rows.map((r) => `${r.table_name}:${r.data_type}`)).toEqual([
      'departments:uuid',
      'person_departments:uuid',
      'team_members:uuid',
      'teams:uuid',
    ]);
  });

  it('carries the composite foreign keys that enforce organization consistency', async () => {
    const { rows } = await owner.query<{ conname: string }>(
      `select conname from pg_constraint
       where contype='f' and conname in (
         'departments_parent_same_org','departments_head_same_org',
         'teams_department_same_org','teams_lead_same_org',
         'team_members_team_same_org','team_members_person_same_org',
         'person_departments_person_same_org','person_departments_department_same_org')
       order by conname`,
    );
    expect(rows).toHaveLength(8);
  });

  it('has the expected indexes for both traversal directions', async () => {
    const { rows } = await owner.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname='public'
         and indexname in ('team_members_team_idx','team_members_person_idx',
                           'person_departments_person_idx','person_departments_department_idx',
                           'departments_org_code_unique','team_members_active_unique',
                           'person_departments_active_unique','teams_department_name_unique')
       order by indexname`,
    );
    expect(rows).toHaveLength(8);
  });

  it('rejects a department that is its own parent', async () => {
    await expect(
      owner.query(`update public.departments set parent_id = id where id = $1`, [deptEng]),
    ).rejects.toThrow();
  });

  it('keeps a department code immutable', async () => {
    await expect(
      owner.query(`update public.departments set code = 'CHANGED' where id = $1`, [deptEng]),
    ).rejects.toThrow(/immutable/i);
  });

  it('allows a person to rejoin a team after leaving', async () => {
    await owner.query(
      `update public.team_members set deleted_at = now()
                       where team_id=$1 and person_id=$2`,
      [teamCore, bob],
    );
    await owner.query(
      `insert into public.team_members (org_id,team_id,person_id) values ($1,$2,$3)`,
      [orgA, teamCore, bob],
    );
    await owner.query(
      `insert into public.team_members (org_id,team_id,person_id) values ($1,$2,$3)
       on conflict do nothing`,
      [orgA, teamCore, bob],
    );
    const { rows } = await owner.query<{ n: string }>(
      `select count(*) n from public.team_members
       where team_id=$1 and person_id=$2 and deleted_at is null`,
      [teamCore, bob],
    );
    expect(Number(rows[0]!.n), 'only one ACTIVE membership at a time').toBe(1);
  });
});

describe('organization consistency is enforced by the database', () => {
  it('accepts a valid same-organization structure', async () => {
    const { rows } = await owner.query<{ n: string }>(
      `select count(*) n from public.teams where org_id=$1 and department_id=$2`,
      [orgA, deptEng],
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('refuses a team attached to another organization department', async () => {
    await expect(
      owner.query(`insert into public.teams (org_id,department_id,name) values ($1,$2,'Illegal')`, [
        orgA,
        deptB,
      ]),
    ).rejects.toThrow();
  });

  it('refuses a team member whose person is in another organization', async () => {
    await expect(
      owner.query(`insert into public.team_members (org_id,team_id,person_id) values ($1,$2,$3)`, [
        orgA,
        teamCore,
        carol,
      ]),
    ).rejects.toThrow();
  });

  it('refuses a person_department crossing organizations', async () => {
    await expect(
      owner.query(
        `insert into public.person_departments (org_id,person_id,department_id) values ($1,$2,$3)`,
        [orgA, alice, deptB],
      ),
    ).rejects.toThrow();
    await expect(
      owner.query(
        `insert into public.person_departments (org_id,person_id,department_id) values ($1,$2,$3)`,
        [orgA, carol, deptEng],
      ),
    ).rejects.toThrow();
  });

  it('refuses a sub-department whose parent is in another organization', async () => {
    await expect(
      owner.query(
        `insert into public.departments (org_id,code,name,parent_id) values ($1,$2,'Illegal',$3)`,
        [orgA, `${CODE}_X1`, deptB],
      ),
    ).rejects.toThrow();
  });

  it('refuses a department head from another organization', async () => {
    await expect(
      owner.query(
        `insert into public.departments (org_id,code,name,head_person_id) values ($1,$2,'Illegal',$3)`,
        [orgA, `${CODE}_X2`, carol],
      ),
    ).rejects.toThrow();
  });

  it('refuses a team lead from another organization', async () => {
    await expect(
      owner.query(
        `insert into public.teams (org_id,department_id,name,lead_person_id) values ($1,$2,'Illegal',$3)`,
        [orgA, deptEng, carol],
      ),
    ).rejects.toThrow();
  });

  it('refuses an org_id that disagrees with both parents', async () => {
    await expect(
      owner.query(`insert into public.team_members (org_id,team_id,person_id) values ($1,$2,$3)`, [
        orgB,
        teamCore,
        alice,
      ]),
    ).rejects.toThrow();
  });
});

describe('RLS', () => {
  it('is enabled and forced on all four tables', async () => {
    const { rows } = await owner.query<{ relname: string; e: boolean; f: boolean }>(
      `select relname, relrowsecurity e, relforcerowsecurity f
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public'
         and relname in ('departments','teams','team_members','person_departments')
       order by relname`,
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.e, `${r.relname} enabled`).toBe(true);
      expect(r.f, `${r.relname} forced`).toBe(true);
    }
  });

  it('leaves no table in public unprotected', async () => {
    const { rows } = await owner.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind='r' and c.relname <> '__drizzle_migrations'
         and (not c.relrowsecurity or not c.relforcerowsecurity)`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('grants app_user no write privilege on any of the four', async () => {
    const { rows } = await owner.query<{ t: string; p: string }>(
      `select table_name t, privilege_type p from information_schema.table_privileges
       where grantee='app_user' and privilege_type in ('INSERT','UPDATE','DELETE')
         and table_name in ('departments','teams','team_members','person_departments')`,
    );
    expect(rows).toEqual([]);
  });

  it('returns nothing on any of the four without identity — no org-wide hole', async () => {
    for (const t of ['departments', 'teams', 'team_members', 'person_departments']) {
      const { rows } = await asUser.query<{ n: string }>(`select count(*) n from public.${t}`);
      expect(Number(rows[0]!.n), t).toBe(0);
    }
  });

  it('shows a person only their own structures, never the whole organization', async () => {
    const depts = await inContext<{ id: string }>(
      { personId: alice, orgId: orgA },
      `select id from public.departments`,
    );
    expect(
      depts.map((r) => r.id),
      'deptOps is in the same org but not Alice-related',
    ).toEqual([deptEng]);

    const teams = await inContext<{ id: string }>(
      { personId: alice, orgId: orgA },
      `select id from public.teams`,
    );
    const teamIds = teams.map((r) => r.id);
    expect(teamIds).toEqual([teamCore]);
    expect(teamIds, 'teamOther shares the department but not the membership').not.toContain(
      teamOther,
    );

    const tm = await inContext<{ person_id: string }>(
      { personId: alice, orgId: orgA },
      `select person_id from public.team_members`,
    );
    expect(new Set(tm.map((r) => r.person_id))).toEqual(new Set([alice]));
  });

  it('denies a cross-tenant claim', async () => {
    const rows = await inContext<{ id: string }>(
      { personId: alice, orgId: orgB },
      `select id from public.departments`,
    );
    expect(rows).toEqual([]);
  });
});

describe('authz.my_departments()', () => {
  it('is SECURITY DEFINER, STABLE, search_path pinned empty, no PUBLIC execute', async () => {
    const { rows } = await owner.query<{
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
    }>(
      `select prosecdef, provolatile, proconfig from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='authz' and proname='my_departments'`,
    );
    expect(rows[0]!.prosecdef).toBe(true);
    expect(rows[0]!.provolatile).toBe('s');
    expect(rows[0]!.proconfig ?? []).toContain('search_path=""');

    const acl = await owner.query<{ grantee: string }>(
      `select coalesce(pg_get_userbyid(nullif(ac.grantee,0)),'PUBLIC') grantee
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) ac
       where n.nspname='authz' and p.proname='my_departments' and ac.privilege_type='EXECUTE'`,
    );
    const grantees = acl.rows.map((r) => r.grantee);
    expect(grantees).not.toContain('PUBLIC');
    expect(grantees).toContain('app_user');
    expect(grantees).toContain('app_admin');
  });

  it('returns exactly the ACTIVE departments the person belongs to', async () => {
    const r = await inContext<{ d: string[] }>(
      { personId: alice, orgId: orgA },
      `select authz.my_departments() d`,
    );
    // Alice is linked to deptEng, deptArchived and deptDeleted; only deptEng qualifies.
    expect(r[0]!.d).toEqual([deptEng]);
  });

  it('excludes an unrelated department in the same organization', async () => {
    const r = await inContext<{ d: string[] }>(
      { personId: alice, orgId: orgA },
      `select authz.my_departments() d`,
    );
    expect(r[0]!.d).not.toContain(deptOps);
  });

  it('excludes archived and soft-deleted departments', async () => {
    const r = await inContext<{ d: string[] }>(
      { personId: alice, orgId: orgA },
      `select authz.my_departments() d`,
    );
    expect(r[0]!.d).not.toContain(deptArchived);
    expect(r[0]!.d).not.toContain(deptDeleted);
  });

  it('never returns another tenant departments', async () => {
    const r = await inContext<{ d: string[] }>(
      { personId: carol, orgId: orgB },
      `select authz.my_departments() d`,
    );
    expect(r[0]!.d).toEqual([deptB]);
    expect(r[0]!.d).not.toContain(deptEng);
  });

  it('fails closed with no identity — empty, not everything', async () => {
    const r = await asUser.query<{ d: string[] }>(`select authz.my_departments() d`);
    expect(r.rows[0]!.d).toEqual([]);
  });

  it('fails closed on a mismatched tenant claim', async () => {
    const r = await inContext<{ d: string[] }>(
      { personId: alice, orgId: orgB },
      `select authz.my_departments() d`,
    );
    expect(r[0]!.d).toEqual([]);
  });
});

describe('pooled-connection isolation', () => {
  it('alternating people never see each other departments', async () => {
    for (const [pid, oid, expected] of [
      [alice, orgA, deptEng],
      [carol, orgB, deptB],
      [alice, orgA, deptEng],
      [carol, orgB, deptB],
    ] as const) {
      const r = await inContext<{ d: string[] }>(
        { personId: pid, orgId: oid },
        `select authz.my_departments() d`,
      );
      expect(r[0]!.d).toEqual([expected]);
    }
  });

  it('a reused connection retains no previous identity', async () => {
    await inContext({ personId: alice, orgId: orgA }, `select authz.my_departments()`);
    const leaked = await asUser.query<{ d: string[]; n: string }>(
      `select authz.my_departments() d, (select count(*) from public.departments) n`,
    );
    expect(leaked.rows[0]!.d).toEqual([]);
    expect(Number(leaked.rows[0]!.n)).toBe(0);
  });

  it('15 concurrent interleaved contexts stay isolated', async () => {
    const cases = [
      [alice, orgA, deptEng],
      [carol, orgB, deptB],
      [bob, orgA, null],
    ] as const;
    const results = await Promise.all(
      Array.from({ length: 15 }, (_, i) => {
        const [pid, oid, expected] = cases[i % cases.length]!;
        return inContext<{ d: string[] }>(
          { personId: pid, orgId: oid },
          `select authz.my_departments() d`,
        ).then((r) => ({ expected, got: r[0]!.d }));
      }),
    );
    for (const r of results) {
      expect(r.got).toEqual(r.expected === null ? [] : [r.expected]);
    }
  }, 60_000);
});
