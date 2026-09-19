import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * Task 1.16 — scope-aware RLS, and the manager chain TEAM scope needs.
 *
 * Task 1.15 proved the application-layer chain against a probe table because no real Phase 1
 * table answered anything but SELF. This file is the other half: the database.md 4.2 template on
 * people, engagements and engagement_events, and authz.reports_to_me() underneath it.
 *
 * Everything here runs as app_user through RLS. Nothing asks requirePermission() — if a row is
 * reachable it is because a policy said so, which is the property that has to survive a mistake
 * in the application layer.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const RUN = Math.random().toString(36).slice(2, 8);
const CODE = `R${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

type Ctx = { personId?: string | null; orgId?: string | null; aal?: string };

/** One transaction as app_user, carrying exactly the identity given — nothing more. */
async function inContext<T extends Record<string, unknown> = Record<string, unknown>>(
  ctx: Ctx,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = await asUser.connect();
  try {
    await c.query('begin');
    await c.query(
      `select set_config('app.person_id',$1,true),
              set_config('app.org_id',$2,true),
              set_config('app.aal',$3,true)`,
      [ctx.personId ?? '', ctx.orgId ?? '', ctx.aal ?? 'aal1'],
    );
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

/** The sqlstate of a rejected statement. 42501 is insufficient_privilege. */
async function sqlstateOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'NO ERROR';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

/** An owner transaction that carries an identity, for writes app_user may not perform. */
async function asActor(ctx: Ctx, sql: string, params: unknown[] = []): Promise<void> {
  const c = await owner.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.person_id',$1,true), set_config('app.org_id',$2,true)`, [
      ctx.personId ?? '',
      ctx.orgId ?? '',
    ]);
    await c.query(sql, params);
    await c.query('commit');
  } catch (error) {
    await c.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

const mkOrg = async (slug: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1,$2) returning id`,
      [`Scope ${slug}`, slug],
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
  const role = (
    await owner.query<{ id: string }>(
      `insert into public.roles (org_id, key, name) values ($1,$2,$3) returning id`,
      [org, key, `Custom ${key}`],
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
  return role;
};

let orgA = '';
let orgB = '';
let dA1 = '';
let dA2 = '';
let dA3 = '';

// viewers, one scope each
let vGlobal = '';
let vDept = '';
let vTeam = '';
let vSelf = '';
let vNone = '';
let vGlobalSuspended = '';
let eGlobal = '';
let eDept = '';
let eTeam = '';

// subjects
let sDept1 = '';
let sDept2 = '';
let sDept3 = '';
let sReport = '';
let sDeep = '';
let sNonReport = '';
let sDeleted = '';
let sForeign = '';
let cycleA = '';
let cycleB = '';
let sEvent = '';
let sEventEngagement = '';
let chain: string[] = [];

// Two reporting lines that exist only to be broken, below.
let mSusp = '';
let rSusp = '';
let rSuspDeep = '';
let mGone = '';
let rUnderGone = '';

const ctxOf = (person: string) => ({ personId: person, orgId: orgA });

const peopleVisibleTo = async (person: string) =>
  (await inContext<{ id: string }>(ctxOf(person), `select id from public.people`)).map((r) => r.id);

const engagementsVisibleTo = async (person: string) =>
  (await inContext<{ id: string }>(ctxOf(person), `select id from public.engagements`)).map(
    (r) => r.id,
  );

const reportsToMe = async (viewer: string, target: string | null) =>
  (
    await inContext<{ r: boolean }>(ctxOf(viewer), `select authz.reports_to_me($1::uuid) r`, [
      target,
    ])
  )[0]!.r;

const inMyDepartments = async (viewer: string, target: string | null) =>
  (
    await inContext<{ r: boolean }>(ctxOf(viewer), `select authz.in_my_departments($1::uuid) r`, [
      target,
    ])
  )[0]!.r;

beforeAll(async () => {
  [orgA, orgB] = await Promise.all([mkOrg(`sr-${RUN}-a`), mkOrg(`sr-${RUN}-b`)]);
  [dA1, dA2, dA3] = await Promise.all([
    mkDept(orgA, `${CODE}_1`),
    mkDept(orgA, `${CODE}_2`),
    mkDept(orgA, `${CODE}_3`),
  ]);
  const dB = await mkDept(orgB, `${CODE}_B`);

  [
    vGlobal,
    vDept,
    vTeam,
    vSelf,
    vNone,
    vGlobalSuspended,
    eGlobal,
    eDept,
    eTeam,
    sDept1,
    sDept2,
    sDept3,
    sReport,
    sDeep,
    sNonReport,
    sDeleted,
    cycleA,
    cycleB,
    sEvent,
  ] = await Promise.all([
    mkPerson(orgA, 'Viewer Global'),
    mkPerson(orgA, 'Viewer Dept'),
    mkPerson(orgA, 'Viewer Team'),
    mkPerson(orgA, 'Viewer Self'),
    mkPerson(orgA, 'Viewer None'),
    mkPerson(orgA, 'Viewer Global Suspended'),
    mkPerson(orgA, 'Eng Global'),
    mkPerson(orgA, 'Eng Dept'),
    mkPerson(orgA, 'Eng Team'),
    mkPerson(orgA, 'Subject One'),
    mkPerson(orgA, 'Subject Two'),
    mkPerson(orgA, 'Subject Three'),
    mkPerson(orgA, 'Direct Report'),
    mkPerson(orgA, 'Indirect Report'),
    mkPerson(orgA, 'Non Report'),
    mkPerson(orgA, 'Deleted Person'),
    mkPerson(orgA, 'Cycle A'),
    mkPerson(orgA, 'Cycle B'),
    mkPerson(orgA, 'Event Subject'),
  ]);
  sForeign = await mkPerson(orgB, 'Foreign Person');

  await Promise.all([
    mkEngagement(orgA, vGlobal, dA1),
    mkEngagement(orgA, vDept, dA1),
    mkEngagement(orgA, vTeam, dA1),
    mkEngagement(orgA, vSelf, dA1),
    mkEngagement(orgA, vNone, dA1),
    mkEngagement(orgA, vGlobalSuspended, dA1, { status: 'SUSPENDED' }),
    mkEngagement(orgA, eGlobal, dA1),
    mkEngagement(orgA, eDept, dA1),
    mkEngagement(orgA, eTeam, dA1),
    mkEngagement(orgA, sDept1, dA1),
    mkEngagement(orgA, sDept2, dA2),
    mkEngagement(orgA, sDept3, dA3),
    mkEngagement(orgA, sNonReport, dA3),
    mkEngagement(orgA, sDeleted, dA1),
    mkEngagement(orgB, sForeign, dB),
  ]);
  // The reporting lines: sReport -> vTeam (and eTeam), sDeep -> sReport.
  await mkEngagement(orgA, sReport, dA3, { manager: vTeam });
  await mkEngagement(orgA, sDeep, dA3, { manager: sReport });
  // A cycle the schema permits: A manages B and B manages A. Closing it is what makes it a
  // cycle, and it also seals it off — every member's manager is inside it, so no chain from
  // outside leads in and only a walk that STARTS inside can loop.
  await mkEngagement(orgA, cycleA, dA3, { manager: vTeam });
  await mkEngagement(orgA, cycleB, dA3, { manager: cycleA });
  await owner.query(`update public.engagements set manager_person_id = $1 where person_id = $2`, [
    cycleB,
    cycleA,
  ]);
  sEventEngagement = await mkEngagement(orgA, sEvent, dA1);

  // A chain twelve deep below the TEAM viewer, to pin the depth cap.
  chain = [];
  let manager = vTeam;
  for (let i = 0; i < 12; i++) {
    const person = await mkPerson(orgA, `Chain ${i + 1}`);
    await mkEngagement(orgA, person, dA3, { manager });
    chain.push(person);
    manager = person;
  }

  await Promise.all([
    mkRoleFor(orgA, vGlobal, `PV_G_${CODE}`, 'people.view', 'GLOBAL'),
    mkRoleFor(orgA, vDept, `PV_D_${CODE}`, 'people.view', 'DEPARTMENT'),
    mkRoleFor(orgA, vTeam, `PV_T_${CODE}`, 'people.view', 'TEAM'),
    mkRoleFor(orgA, vSelf, `PV_S_${CODE}`, 'people.view', 'SELF'),
    mkRoleFor(orgA, vGlobalSuspended, `PV_GS_${CODE}`, 'people.view', 'GLOBAL'),
    mkRoleFor(orgA, eGlobal, `EV_G_${CODE}`, 'engagements.view', 'GLOBAL'),
    mkRoleFor(orgA, eDept, `EV_D_${CODE}`, 'engagements.view', 'DEPARTMENT'),
    mkRoleFor(orgA, eTeam, `EV_T_${CODE}`, 'engagements.view', 'TEAM'),
  ]);
  // The DEPARTMENT viewers sit in dA1 through their engagement and in dA2 by membership.
  await Promise.all(
    [vDept, eDept].map((p) =>
      owner.query(
        `insert into public.person_departments (org_id, person_id, department_id) values ($1,$2,$3)`,
        [orgA, p, dA2],
      ),
    ),
  );
  // eTeam manages sReport too, so the engagement TEAM branch has a subject of its own.
  await owner.query(
    `update public.engagements set manager_person_id = $1 where person_id = $2 and manager_person_id is null`,
    [eTeam, sNonReport],
  );

  // The two lines the liveness test spends. Suspension is ONE WAY: migration 0006 draws no
  // SUSPENDED → ACTIVE edge, deliberately, so a fixture that suspends and restores would be
  // testing a transition the machine refuses. These people belong to nothing else.
  [mSusp, rSusp, rSuspDeep, mGone, rUnderGone] = await Promise.all([
    mkPerson(orgA, 'Manager Kept'),
    mkPerson(orgA, 'Report Suspended'),
    mkPerson(orgA, 'Below The Suspended Report'),
    mkPerson(orgA, 'Manager Suspended'),
    mkPerson(orgA, 'Report Under Suspended Manager'),
  ]);
  await mkEngagement(orgA, mSusp, dA3);
  await mkEngagement(orgA, rSusp, dA3, { manager: mSusp });
  await mkEngagement(orgA, rSuspDeep, dA3, { manager: rSusp });
  await mkEngagement(orgA, mGone, dA3);
  await mkEngagement(orgA, rUnderGone, dA3, { manager: mGone });

  await owner.query(`update public.people set deleted_at = now() where id = $1`, [sDeleted]);
  // One lifecycle event, written by a real actor as the trigger requires.
  await asActor(ctxOf(vGlobal), `update public.engagements set status='SUSPENDED' where id=$1`, [
    sEventEngagement,
  ]);
}, 300_000);

afterAll(async () => {
  await Promise.all([owner.end().catch(() => undefined), asUser.end().catch(() => undefined)]);
});

// ── 1. the helper ────────────────────────────────────────────────────────────────

// Both helpers this task adds are definer functions that read engagements as the owner, so
// both carry the same obligations and both are checked for them.
describe.each(['reports_to_me', 'in_my_departments'])('authz.%s() — security properties', (fn) => {
  it('is SECURITY DEFINER, STABLE, owned by app_owner, with search_path pinned empty', async () => {
    const { rows } = await owner.query<{
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
      owner: string;
    }>(
      `select p.prosecdef, p.provolatile, p.proconfig, r.rolname as owner
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       join pg_roles r on r.oid = p.proowner
       where n.nspname='authz' and p.proname=$1`,
      [fn],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.prosecdef).toBe(true);
    expect(rows[0]!.provolatile).toBe('s');
    expect(rows[0]!.proconfig ?? []).toContain('search_path=""');
    expect(rows[0]!.owner).toBe('app_owner');
  });

  it('grants EXECUTE to app_user and app_admin, never to PUBLIC', async () => {
    const { rows } = await owner.query<{ grantee: string }>(
      `select coalesce(pg_get_userbyid(nullif(ac.grantee,0)),'PUBLIC') grantee
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) ac
       where n.nspname='authz' and p.proname=$1 and ac.privilege_type='EXECUTE'`,
      [fn],
    );
    const grantees = rows.map((r) => r.grantee);
    expect(grantees).toContain('app_user');
    expect(grantees).toContain('app_admin');
    expect(grantees).not.toContain('PUBLIC');
  });

  it('qualifies every table it reads and builds no dynamic SQL', async () => {
    const { rows } = await owner.query<{ src: string }>(
      `select pg_get_functiondef(p.oid) src from pg_proc p
       join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='authz' and p.proname=$1`,
      [fn],
    );
    const body = (rows[0]!.src.split('AS $function$')[1] ?? '')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    for (const table of body.match(/\b(from|join)\s+([a-z_.]+)/gi) ?? []) {
      // `join chain` is the recursive CTE itself, which is not a table.
      if (/\bchain\b/.test(table)) continue;
      expect(table).toMatch(/\s(public|authz)\./);
    }
    expect(body).not.toMatch(/\bexecute\b/i);
    expect(body).toMatch(/authz\.org_id\(\)/);
  });
});

describe('authz.reports_to_me() — semantics', () => {
  it('is true for a direct report and for one further down the chain', async () => {
    expect(await reportsToMe(vTeam, sReport)).toBe(true);
    expect(await reportsToMe(vTeam, sDeep)).toBe(true);
  });

  it('is false for the caller themselves, and for somebody who reports to nobody', async () => {
    expect(await reportsToMe(vTeam, vTeam)).toBe(false);
    expect(await reportsToMe(vTeam, sNonReport)).toBe(false);
  });

  it('is false across an organization boundary, and for a NULL argument', async () => {
    expect(await reportsToMe(vTeam, sForeign)).toBe(false);
    expect(await reportsToMe(vTeam, null)).toBe(false);
  });

  it('is false with no identity, and on a mismatched tenant claim', async () => {
    const none = await inContext<{ r: boolean }>(
      { personId: null, orgId: null },
      `select authz.reports_to_me($1::uuid) r`,
      [sReport],
    );
    expect(none[0]!.r).toBe(false);
    const spoofed = await inContext<{ r: boolean }>(
      { personId: vTeam, orgId: orgB },
      `select authz.reports_to_me($1::uuid) r`,
      [sReport],
    );
    expect(spoofed[0]!.r).toBe(false);
  });

  it('stops being true when the report stops being live, and everything below them with it', async () => {
    expect(await reportsToMe(mSusp, rSusp)).toBe(true);
    expect(await reportsToMe(mSusp, rSuspDeep)).toBe(true);
    // A status change needs an actor — the transition machine says so — so this goes through
    // one, exactly as a real suspension would.
    const suspend = `update public.engagements set status='SUSPENDED' where person_id=$1`;
    await asActor(ctxOf(vGlobal), suspend, [rSusp]);
    expect(await reportsToMe(mSusp, rSusp), 'a suspended report').toBe(false);
    expect(await reportsToMe(mSusp, rSuspDeep), 'and the link below them is cut too').toBe(false);
  });

  it('stops being true when the manager stops being live', async () => {
    expect(await reportsToMe(mGone, rUnderGone)).toBe(true);
    await asActor(
      ctxOf(vGlobal),
      `update public.engagements set status='SUSPENDED' where person_id=$1`,
      [mGone],
    );
    expect(await reportsToMe(mGone, rUnderGone), 'a suspended manager reaches nobody').toBe(false);
  });

  it('terminates on a cycle the schema permits, and answers from inside it', async () => {
    // Nobody outside a closed cycle can reach into it: each member's manager is another
    // member, so there is no edge from vTeam's chain into it, even though cycleA once had one.
    expect(await reportsToMe(vTeam, cycleA), 'a closed cycle has no entrance').toBe(false);
    expect(await reportsToMe(vTeam, cycleB)).toBe(false);
    // Starting INSIDE is the walk that would not terminate. Each member sees the other, and
    // neither sees themselves: the visited set ends the walk, and the explicit self-exclusion
    // is what keeps "reports to me" from including me once the walk comes back around.
    expect(await reportsToMe(cycleA, cycleB)).toBe(true);
    expect(await reportsToMe(cycleB, cycleA)).toBe(true);
    expect(await reportsToMe(cycleA, cycleA), 'not even through a cycle').toBe(false);
    expect(await reportsToMe(cycleB, cycleB)).toBe(false);
  }, 60_000);

  it('answers ten levels down and stops there, by the documented cap', async () => {
    expect(await reportsToMe(vTeam, chain[9]!), 'level ten').toBe(true);
    expect(await reportsToMe(vTeam, chain[10]!), 'level eleven is past the cap').toBe(false);
  });
});

describe('authz.in_my_departments() — semantics', () => {
  it('is true through my primary department and through a secondary one', async () => {
    // vDept sits in dA1 through their live engagement and in dA2 by membership.
    expect(await inMyDepartments(vDept, sDept1), 'primary').toBe(true);
    expect(await inMyDepartments(vDept, sDept2), 'secondary').toBe(true);
  });

  it('is false for another department, another tenant, and a NULL argument', async () => {
    expect(await inMyDepartments(vDept, sDept3)).toBe(false);
    expect(await inMyDepartments(vDept, sForeign)).toBe(false);
    expect(await inMyDepartments(vDept, null)).toBe(false);
  });

  it('is false when the subject has no live engagement there', async () => {
    // sEvent's engagement is in dA1 — one of vDept's — but it was suspended in the fixture.
    expect(await inMyDepartments(vDept, sEvent)).toBe(false);
  });

  it('is false when the CALLER is not live, on a forged tenant, and with no identity', async () => {
    // vGlobalSuspended's own engagement is in dA1, so without the liveness gate this would
    // be true for everybody in that department.
    expect(await inMyDepartments(vGlobalSuspended, sDept1)).toBe(false);
    const spoofed = await inContext<{ r: boolean }>(
      { personId: vDept, orgId: orgB },
      `select authz.in_my_departments($1::uuid) r`,
      [sDept1],
    );
    expect(spoofed[0]!.r).toBe(false);
    const anonymous = await inContext<{ r: boolean }>(
      { personId: null, orgId: null },
      `select authz.in_my_departments($1::uuid) r`,
      [sDept1],
    );
    expect(anonymous[0]!.r).toBe(false);
  });

  it('answers about a person whose engagement the caller cannot read', async () => {
    // THE REASON THIS FUNCTION EXISTS. vDept holds people.view and nothing on engagements,
    // so as app_user they see exactly one engagement row — their own. An inline subquery in
    // the people policy would have been filtered the same way and could never have matched a
    // colleague; running as the owner, the helper answers anyway.
    const visibleEngagements = await inContext<{ person_id: string }>(
      ctxOf(vDept),
      `select person_id from public.engagements`,
    );
    expect(visibleEngagements.map((r) => r.person_id)).toEqual([vDept]);
    expect(await inMyDepartments(vDept, sDept1)).toBe(true);
  });
});

// ── 2. people ────────────────────────────────────────────────────────────────────

describe('people — the database.md 4.2 template', () => {
  it('shows every viewer their own row, whatever their scope or engagement', async () => {
    for (const [label, person] of [
      ['GLOBAL', vGlobal],
      ['DEPARTMENT', vDept],
      ['TEAM', vTeam],
      ['SELF', vSelf],
      ['no role at all', vNone],
      ['suspended engagement', vGlobalSuspended],
    ] as const) {
      expect(await peopleVisibleTo(person), label).toContain(person);
    }
  });

  it('GLOBAL reaches the whole organization, and stops at the tenant and the tombstone', async () => {
    const seen = await peopleVisibleTo(vGlobal);
    for (const subject of [sDept1, sDept2, sDept3, sReport, sNonReport]) {
      expect(seen).toContain(subject);
    }
    expect(seen).not.toContain(sForeign);
    expect(seen, 'a soft-deleted person is gone for everyone').not.toContain(sDeleted);
  });

  it('DEPARTMENT reaches the live engagements of my departments, primary and secondary', async () => {
    const seen = await peopleVisibleTo(vDept);
    expect(seen).toContain(sDept1);
    expect(seen).toContain(sDept2);
    expect(seen).not.toContain(sDept3);
    expect(seen).not.toContain(sForeign);
  });

  it('TEAM reaches the manager chain and nothing beside it', async () => {
    const seen = await peopleVisibleTo(vTeam);
    expect(seen).toContain(sReport);
    expect(seen).toContain(sDeep);
    expect(seen).toContain(vTeam);
    expect(seen).not.toContain(sNonReport);
    expect(seen).not.toContain(sDept1);
  });

  it('SELF, and no role at all, reach exactly one row', async () => {
    expect(await peopleVisibleTo(vSelf)).toEqual([vSelf]);
    expect(await peopleVisibleTo(vNone)).toEqual([vNone]);
  });

  it('gives a suspended GLOBAL holder their own row and no other', async () => {
    // is_active() gates the widening branches; it never gates seeing yourself.
    expect(await peopleVisibleTo(vGlobalSuspended)).toEqual([vGlobalSuspended]);
  });

  it('returns nothing on a forged tenant claim, and nothing without an identity', async () => {
    const spoofed = await inContext<{ id: string }>(
      { personId: vGlobal, orgId: orgB },
      `select id from public.people`,
    );
    expect(spoofed).toEqual([]);
    const anonymous = await inContext<{ id: string }>(
      { personId: null, orgId: null },
      `select id from public.people`,
    );
    expect(anonymous).toEqual([]);
  });

  it('lets a record grant reach exactly one extra row, and only while it is live', async () => {
    const grant = (
      await owner.query<{ id: string }>(
        `insert into public.record_grants
           (org_id, entity_type, entity_id, person_id, permission_id, granted_by, reason)
         select $1,'person',$2,$3,p.id,$4,'Task 1.16 suite'
         from public.permissions p where p.key='people.view'
         returning id`,
        [orgA, sDept3, vSelf, vGlobal],
      )
    ).rows[0]!.id;

    const withGrant = await peopleVisibleTo(vSelf);
    expect([...withGrant].sort()).toEqual([vSelf, sDept3].sort());
    expect(withGrant, 'the grant reaches one row, not a scope').not.toContain(sDept1);

    await owner.query(`update public.record_grants set revoked_at = now() where id=$1`, [grant]);
    expect(await peopleVisibleTo(vSelf)).toEqual([vSelf]);
  });
});

describe('people — the columns RLS cannot filter', () => {
  it('refuses the sensitive columns to app_user, one by one', async () => {
    for (const column of ['date_of_birth', 'personal_email', 'phone']) {
      expect(
        await sqlstateOf(inContext(ctxOf(vGlobal), `select ${column} from public.people`)),
        column,
      ).toBe('42501');
    }
  });

  it('refuses a star select, which is how this leaks by accident', async () => {
    expect(await sqlstateOf(inContext(ctxOf(vGlobal), `select * from public.people`))).toBe(
      '42501',
    );
  });

  it('still serves the directory columns the matrix does allow', async () => {
    const rows = await inContext<{ id: string; full_legal_name: string }>(
      ctxOf(vGlobal),
      `select id, code, full_legal_name, preferred_name, work_email, photo_url, person_status
       from public.people where id = $1`,
      [sDept1],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.full_legal_name).toBe('Subject One');
  });

  it('records the boundary in the catalogue, not just in behaviour', async () => {
    const { rows } = await owner.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
       where table_schema='public' and table_name='people'
         and grantee='app_user' and privilege_type='SELECT'
       order by column_name`,
    );
    const granted = rows.map((r) => r.column_name);
    for (const hidden of ['date_of_birth', 'personal_email', 'phone']) {
      expect(granted, `${hidden} must not be readable by app_user`).not.toContain(hidden);
    }
    for (const visible of ['id', 'org_id', 'full_legal_name', 'work_email', 'person_status']) {
      expect(granted, visible).toContain(visible);
    }
  });

  it('withholds exactly those three columns and nothing else', async () => {
    // This is the test that will fail when somebody adds a column to people, and it is meant
    // to: the table-level SELECT is gone, and a column grant does not extend to columns that
    // do not exist yet, so a new column is unreadable by app_user until 'grant select (…)'
    // names it. Failing here is the reminder. Deciding the new column is HR-only and leaving
    // it out is a legitimate answer — updating this list is how that decision gets recorded.
    const { rows } = await owner.query<{ column_name: string; granted: boolean }>(
      `select c.column_name,
              exists (
                select 1 from information_schema.column_privileges p
                where p.table_schema=c.table_schema and p.table_name=c.table_name
                  and p.column_name=c.column_name
                  and p.grantee='app_user' and p.privilege_type='SELECT'
              ) granted
       from information_schema.columns c
       where c.table_schema='public' and c.table_name='people'
       order by c.column_name`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const withheld = rows.filter((r) => !r.granted).map((r) => r.column_name);
    expect(withheld.sort()).toEqual(['date_of_birth', 'personal_email', 'phone']);
  });

  it('leaves the owner, and therefore every definer function, able to read them', async () => {
    const { rows } = await owner.query<{ date_of_birth: string | null }>(
      `select date_of_birth from public.people where id=$1`,
      [sDept1],
    );
    expect(rows[0]!.date_of_birth).not.toBeNull();
  });
});

// ── 3. engagements and their events ──────────────────────────────────────────────

describe('engagements — the same template, keyed on engagements.view', () => {
  it('shows a person their own engagement, including one that has ended', async () => {
    const own = await engagementsVisibleTo(sEvent);
    expect(own).toContain(sEventEngagement);
  });

  it('reaches the organization at GLOBAL, the department at DEPARTMENT, the chain at TEAM', async () => {
    const globalSeen = await inContext<{ person_id: string }>(
      ctxOf(eGlobal),
      `select person_id from public.engagements`,
    );
    const globalPeople = globalSeen.map((r) => r.person_id);
    expect(globalPeople).toContain(sDept3);
    expect(globalPeople).toContain(sDept1);
    expect(globalPeople).not.toContain(sForeign);

    const deptSeen = await inContext<{ person_id: string }>(
      ctxOf(eDept),
      `select person_id from public.engagements`,
    );
    const deptPeople = deptSeen.map((r) => r.person_id);
    expect(deptPeople).toContain(sDept1);
    expect(deptPeople).toContain(sDept2);
    expect(deptPeople).not.toContain(sDept3);

    const teamSeen = await inContext<{ person_id: string }>(
      ctxOf(eTeam),
      `select person_id from public.engagements`,
    );
    const teamPeople = teamSeen.map((r) => r.person_id);
    expect(teamPeople).toContain(sNonReport);
    expect(teamPeople).toContain(eTeam);
    expect(teamPeople).not.toContain(sDept1);
  });

  it('gives a person with no engagements.view nothing but their own', async () => {
    const seen = await inContext<{ person_id: string }>(
      ctxOf(vGlobal),
      `select person_id from public.engagements`,
    );
    // people.view at GLOBAL says nothing about engagements: the keys are separate.
    expect(seen.map((r) => r.person_id)).toEqual([vGlobal]);
  });

  it('hides a soft-deleted engagement from everyone', async () => {
    const throwaway = await mkPerson(orgA, 'Soft Deleted Engagement');
    const engagement = await mkEngagement(orgA, throwaway, dA1);
    await owner.query(`update public.engagements set deleted_at=now() where id=$1`, [engagement]);
    expect(await engagementsVisibleTo(eGlobal)).not.toContain(engagement);
    expect(await engagementsVisibleTo(throwaway)).not.toContain(engagement);
  });
});

describe('engagement_events — visibility follows the engagement', () => {
  it('shows the subject their own history', async () => {
    const rows = await inContext<{ id: string }>(
      ctxOf(sEvent),
      `select id from public.engagement_events where engagement_id = $1`,
      [sEventEngagement],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('agrees with the engagements policy row for row, at GLOBAL and at DEPARTMENT', async () => {
    for (const [label, viewer] of [
      ['GLOBAL', eGlobal],
      ['DEPARTMENT', eDept],
    ] as const) {
      const engagements = await inContext<{ id: string }>(
        ctxOf(viewer),
        `select id from public.engagements order by id`,
      );
      const eventEngagements = await inContext<{ engagement_id: string }>(
        ctxOf(viewer),
        `select distinct engagement_id from public.engagement_events order by engagement_id`,
      );
      const visible = new Set(engagements.map((r) => r.id));
      for (const row of eventEngagements) {
        expect(visible.has(row.engagement_id), `${label}: event for an unreadable engagement`).toBe(
          true,
        );
      }
    }
  });

  it('shows nothing to somebody who cannot read the engagement', async () => {
    const rows = await inContext<{ id: string }>(
      ctxOf(vSelf),
      `select id from public.engagement_events where engagement_id = $1`,
      [sEventEngagement],
    );
    expect(rows).toEqual([]);
  });
});

// ── 4. the rest of the model ─────────────────────────────────────────────────────

describe('the authorization model around these policies', () => {
  it('keeps one app_user policy per table, and names the permission each one uses', async () => {
    const { rows } = await owner.query<{ tablename: string; policyname: string; qual: string }>(
      `select tablename, policyname, qual from pg_policies
       where schemaname='public' and 'app_user' = any(roles)
         and tablename in ('people','engagements','engagement_events')
       order by tablename`,
    );
    expect(rows.map((r) => r.policyname)).toEqual([
      'engagement_events_select',
      'engagements_select',
      'people_select',
    ]);
    expect(rows.find((r) => r.tablename === 'people')!.qual).toContain('people.view');
    for (const t of ['engagements', 'engagement_events']) {
      expect(rows.find((r) => r.tablename === t)!.qual).toContain('engagements.view');
    }
    for (const r of rows) {
      expect(r.qual, `${r.tablename} derives scope from scope_for`).toContain('scope_for');
      expect(r.qual, `${r.tablename} keeps the tenant first`).toContain('org_id');
      expect(r.qual, `${r.tablename} must not gate on aal yet`).not.toContain('aal');
    }
  });

  it('adds two helpers and nothing else, and still has no is_project_member', async () => {
    const { rows } = await owner.query<{ proname: string }>(
      `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='authz' order by proname`,
    );
    const names = rows.map((r) => r.proname);
    expect(names).toContain('reports_to_me');
    expect(names).toContain('in_my_departments');
    expect(names, 'PROJECT scope is Phase 4').not.toContain('is_project_member');
    expect(names.length).toBe(12);
  });

  it('leaves internships SELF-scoped, because no catalogue key gates it', async () => {
    const { rows } = await owner.query<{ qual: string }>(
      `select qual from pg_policies
       where schemaname='public' and tablename='internships' and 'app_user' = any(roles)`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.qual).not.toContain('scope_for');
  });

  it('still refuses every write to people and engagements from app_user', async () => {
    expect(
      await sqlstateOf(
        inContext(ctxOf(vGlobal), `update public.people set preferred_name='x' where id=$1`, [
          sDept1,
        ]),
      ),
    ).toBe('42501');
    expect(
      await sqlstateOf(
        inContext(
          ctxOf(eGlobal),
          `update public.engagements set job_title='x' where person_id=$1`,
          [sDept1],
        ),
      ),
    ).toBe('42501');
  });
});
