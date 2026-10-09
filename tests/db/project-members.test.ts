import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import {
  CODE,
  RUN,
  ensureWorkSchema,
  inContext,
  mkProject,
  sqlstateOf,
  type Ctx,
} from '../work/helpers';
import {
  headersFor,
  mkAccount,
  mkCustomRole,
  mkDept,
  mkEngagement,
  mkOrg,
  mkPerson,
  type Account,
} from '../authz/fixtures';
import { requirePermission, type Authorization } from '@/lib/authz/require-permission';
import { addProjectMember, listProjectMembers, removeProjectMember } from '@/lib/work/projects';

/**
 * 0063 — project_members RLS recursion fix.
 *
 * The defect: 0042's four app_user policies on project_members each carried an
 * EXISTS arm scanning project_members itself, so every app_user statement on
 * the table died in RLS policy-expansion recursion (42P17) and the members
 * endpoints 500'd deterministically. 0063 creates the long-deferred
 * authz.is_project_member / authz.is_project_manager definers, swaps only
 * those EXISTS arms for definer calls, and adds the
 * public.project_member_directory roster read definer.
 *
 * This suite pins, in order:
 *  - the 0063 catalogue shape (definers' security properties, grants, and
 *    policy text that names the helpers and no longer self-scans);
 *  - ACTOR PRECONDITIONS (Phase 11 lesson): every actor's effective grants
 *    are asserted through the helpers themselves before any behaviour is
 *    trusted — mkCustomRole insert-selects, so a mistyped key would
 *    otherwise masquerade as an RLS failure downstream;
 *  - the RLS behaviour as app_user: both select arms (projects.view, plain
 *    membership), the manager write arm, and cross-tenant denial — every one
 *    of these statements errors on the pre-0063 tree;
 *  - the service surface (real requirePermission-minted Authorizations, real
 *    sessions): list via the projects.view arm, the Finding-2 regression (a
 *    people.view SELF actor still sees the FULL roster through the
 *    directory), cross-tenant NOT_FOUND concealment, and the
 *    add → list → remove round-trip.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const ctxFor = (personId: string, orgId: string): Ctx => ({ personId, orgId });

const codeOf = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
    return 'NO ERROR';
  } catch (error) {
    return (error as { code?: string }).code ?? `THREW:${(error as Error).message}`;
  }
};

let orgA = '';
let orgB = '';
let projectP = ''; // org A — the roster under test
let projectP2 = ''; // org A — a project the plain member does NOT belong to
let projectB = ''; // org B

let admin!: Account; // org A: projects.view + projects.manage_members + people.view (GLOBAL)
let vera!: Account; // org A: projects.view only — the select policy's key arm
let selfy!: Account; // org A: projects.view GLOBAL + people.view SELF — Finding 2
let bob!: Account; // org B: projects.view — cross-tenant
let mem!: Account; // org A: no permissions at all — member of P by seed alone

let mgr = ''; // org A person, manager of P, no global keys
let newbie = ''; // org A person, the round-trip target
let other = ''; // org A person, the only member of P2

const seedMembership = async (projectId: string, personId: string, role: string, org = orgA) => {
  await owner.query(
    `insert into public.project_members (org_id, project_id, person_id, role_in_project, added_by)
     values ($1, $2, $3, $4, $5)`,
    [org, projectId, personId, role, personId],
  );
};

beforeAll(async () => {
  await ensureWorkSchema(owner);
  orgA = await mkOrg(owner, `pm-a-${CODE}`);
  orgB = await mkOrg(owner, `pm-b-${CODE}`);
  const deptA = await mkDept(owner, orgA, `${CODE}_MA`);
  const deptA2 = await mkDept(owner, orgA, `${CODE}_MB`);
  const deptB = await mkDept(owner, orgB, `${CODE}_MC`);

  const adminRole = await mkCustomRole(owner, orgA, `${CODE}_PM_ADMIN`, [
    ['projects.view', 'GLOBAL'],
    ['projects.manage_members', 'GLOBAL'],
    ['people.view', 'GLOBAL'],
  ]);
  const viewerRole = await mkCustomRole(owner, orgA, `${CODE}_PM_VIEW`, [
    ['projects.view', 'GLOBAL'],
  ]);
  const selfyRole = await mkCustomRole(owner, orgA, `${CODE}_PM_SELFY`, [
    ['projects.view', 'GLOBAL'],
    ['people.view', 'SELF'],
  ]);
  const bobRole = await mkCustomRole(owner, orgB, `${CODE}_PM_BOB`, [['projects.view', 'GLOBAL']]);

  admin = await mkAccount(owner, {
    org: orgA,
    dept: deptA,
    run: RUN,
    label: 'PM-Admin',
    customRoles: [adminRole],
  });
  vera = await mkAccount(owner, {
    org: orgA,
    dept: deptA,
    run: RUN,
    label: 'PM-Vera',
    customRoles: [viewerRole],
  });
  selfy = await mkAccount(owner, {
    org: orgA,
    dept: deptA,
    run: RUN,
    label: 'PM-Selfy',
    customRoles: [selfyRole],
  });
  bob = await mkAccount(owner, {
    org: orgB,
    dept: deptB,
    run: RUN,
    label: 'PM-Bob',
    customRoles: [bobRole],
  });
  mem = await mkAccount(owner, {
    org: orgA,
    dept: deptA2,
    run: RUN,
    label: 'PM-Mem',
  });

  mgr = await mkPerson(owner, orgA, 'PM-Mgr');
  newbie = await mkPerson(owner, orgA, 'PM-New');
  other = await mkPerson(owner, orgA, 'PM-Other');
  for (const person of [mgr, newbie, other]) {
    await mkEngagement(owner, orgA, person, deptA2);
  }

  // Display-field fixtures: preferred_name wins over full_legal_name where
  // set; work_email passes through; an unset work_email stays null.
  await owner.query(
    `update public.people set preferred_name = 'Mem Nick', work_email = 'mem@pravshi.test' where id = $1`,
    [mem.personId],
  );
  await owner.query(`update public.people set work_email = 'mgr@pravshi.test' where id = $1`, [
    mgr,
  ]);

  projectP = await mkProject(owner, orgA, `Roster ${CODE}`);
  projectP2 = await mkProject(owner, orgA, `Other project ${CODE}`);
  projectB = await mkProject(owner, orgB, `Foreign ${CODE}`);

  await seedMembership(projectP, mem.personId, 'member');
  await seedMembership(projectP, mgr, 'manager');
  await seedMembership(projectP, selfy.personId, 'member');
  await seedMembership(projectP2, other, 'member');
}, 120_000); // 120s: setup can queue behind the Phase 12 perf seed + ANALYZE under CI parallel load (PR #70 round 4).

afterAll(async () => {
  await owner.end();
  await asUser.end();
});

const authFor = (account: Account, permission: string): Promise<Authorization> =>
  requirePermission(headersFor(account.cookie), { permission });

describe('0063 catalogue', () => {
  it('creates the two authz helpers as STABLE SECURITY DEFINERs with search_path pinned empty', async () => {
    const { rows } = await owner.query<{
      proname: string;
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
    }>(
      `select p.proname, p.prosecdef, p.provolatile, p.proconfig
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'authz' and p.proname = any($1) order by p.proname`,
      [['is_project_manager', 'is_project_member']],
    );
    expect(rows.map((r) => r.proname)).toEqual(['is_project_manager', 'is_project_member']);
    for (const r of rows) {
      expect(r.prosecdef, `${r.proname} SECURITY DEFINER`).toBe(true);
      expect(r.provolatile, `${r.proname} STABLE`).toBe('s');
      expect(r.proconfig ?? [], `${r.proname} search_path pinned to empty`).toContain(
        'search_path=""',
      );
    }
  });

  it('grants the helpers to app_user and app_admin and the directory to app_user — never PUBLIC', async () => {
    const { rows } = await owner.query<{ proname: string; grantee: string }>(
      `select p.proname, coalesce(pg_get_userbyid(nullif(ac.grantee, 0)), 'PUBLIC') as grantee
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) ac
       where n.nspname in ('authz', 'public')
         and p.proname = any($1) and ac.privilege_type = 'EXECUTE'`,
      [['is_project_member', 'is_project_manager', 'project_member_directory']],
    );
    const byFn = new Map<string, string[]>();
    for (const r of rows) byFn.set(r.proname, [...(byFn.get(r.proname) ?? []), r.grantee]);
    for (const fn of ['is_project_member', 'is_project_manager']) {
      expect(byFn.get(fn), `${fn} grants app_user`).toContain('app_user');
      expect(byFn.get(fn), `${fn} grants app_admin`).toContain('app_admin');
      expect(byFn.get(fn), `${fn} must not grant PUBLIC`).not.toContain('PUBLIC');
    }
    expect(byFn.get('project_member_directory')).toContain('app_user');
    expect(byFn.get('project_member_directory')).not.toContain('PUBLIC');
    const dir = await owner.query<{ prosecdef: boolean; provolatile: string }>(
      `select p.prosecdef, p.provolatile from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'project_member_directory'`,
    );
    expect(dir.rows[0]!.prosecdef).toBe(true);
    expect(dir.rows[0]!.provolatile).toBe('s');
  });

  it('grants app_user DELETE on project_members — the privilege the delete policy presupposes', async () => {
    // roles.sql gives app_user select/insert/update on all tables and DELETE
    // on none (0060 precedent: DELETE is granted per-table, only where the
    // service hard-deletes). 0042's design is a manager-gated HARD delete and
    // removeProjectMember raw-deletes as app_user, so without this grant
    // every delete dies with 42501 "permission denied for table
    // project_members" before the (rewritten) policy is ever evaluated —
    // the failure mode PR #72 round 1 surfaced in the manager-arm tests.
    const { rows } = await owner.query<{ has_delete: boolean }>(
      `select has_table_privilege('app_user', 'public.project_members', 'DELETE') as has_delete`,
    );
    expect(rows[0]!.has_delete).toBe(true);
  });

  it('rewrites the four policies onto the helpers, with no self-scan left', async () => {
    const { rows } = await owner.query<{ policyname: string; qual: string; with_check: string }>(
      `select policyname, coalesce(qual, '') as qual, coalesce(with_check, '') as with_check
       from pg_policies
       where schemaname = 'public' and tablename = 'project_members'
         and 'app_user' = any(roles)
       order by policyname`,
    );
    expect(rows.map((r) => r.policyname)).toEqual([
      'project_members_delete',
      'project_members_insert',
      'project_members_select',
      'project_members_update',
    ]);
    const text = (name: string) => {
      const r = rows.find((x) => x.policyname === name)!;
      return `${r.qual} ${r.with_check}`;
    };
    expect(text('project_members_select')).toContain('is_project_member');
    for (const name of [
      'project_members_insert',
      'project_members_update',
      'project_members_delete',
    ]) {
      expect(text(name), name).toContain('is_project_manager');
    }
    for (const r of rows) {
      expect(
        `${r.qual} ${r.with_check}`,
        `${r.policyname} must not scan project_members in its own policy`,
      ).not.toMatch(/from\s+(public\.)?project_members\s+m\b/i);
    }
  });
});

describe('actor capability preconditions', () => {
  const probe = async (personId: string, orgId: string, expr: string) =>
    inContext<Record<string, boolean | string>>(
      asUser,
      ctxFor(personId, orgId),
      `select ${expr} v`,
    );

  it('pins each actor\u2019s effective grants through the helpers themselves', async () => {
    // vera: the key arm, and deliberately NO people.view (the roster's display
    // fields must come from the directory, not from her people access).
    expect((await probe(vera.personId, orgA, `authz.has('projects.view')`))[0]!.v).toBe(true);
    expect((await probe(vera.personId, orgA, `authz.has('people.view')`))[0]!.v).toBe(false);
    // mem: no keys at all; membership is the whole of his access.
    expect((await probe(mem.personId, orgA, `authz.has('projects.view')`))[0]!.v).toBe(false);
    expect(
      (await probe(mem.personId, orgA, `authz.is_project_member('${projectP}'::uuid)`))[0]!.v,
    ).toBe(true);
    expect(
      (await probe(mem.personId, orgA, `authz.is_project_manager('${projectP}'::uuid)`))[0]!.v,
    ).toBe(false);
    // mgr: project-level manager, no global manage_members key.
    expect((await probe(mgr, orgA, `authz.has('projects.manage_members')`))[0]!.v).toBe(false);
    expect((await probe(mgr, orgA, `authz.is_project_manager('${projectP}'::uuid)`))[0]!.v).toBe(
      true,
    );
    // selfy: projects.view GLOBAL, people.view SELF (the Finding-2 setup).
    expect((await probe(selfy.personId, orgA, `authz.has('projects.view')`))[0]!.v).toBe(true);
    expect((await probe(selfy.personId, orgA, `authz.scope_for('people.view')::text`))[0]!.v).toBe(
      'SELF',
    );
    // admin + bob hold exactly the keys their tests rely on.
    expect((await probe(admin.personId, orgA, `authz.has('projects.manage_members')`))[0]!.v).toBe(
      true,
    );
    expect((await probe(bob.personId, orgB, `authz.has('projects.view')`))[0]!.v).toBe(true);
  });
});

describe('project_members RLS as app_user', () => {
  it('selects the roster through the projects.view arm — the statement that recursed pre-0063', async () => {
    const rows = await inContext<{ person_id: string }>(
      asUser,
      ctxFor(vera.personId, orgA),
      `select person_id from public.project_members where project_id = $1`,
      [projectP],
    );
    expect(rows.map((r) => r.person_id).sort()).toEqual([mem.personId, mgr, selfy.personId].sort());
  });

  it('selects the roster through the plain-membership arm (no projects.view)', async () => {
    const rows = await inContext<{ person_id: string }>(
      asUser,
      ctxFor(mem.personId, orgA),
      `select person_id from public.project_members where project_id = $1`,
      [projectP],
    );
    expect(rows.map((r) => r.person_id).sort()).toEqual([mem.personId, mgr, selfy.personId].sort());
  });

  it('shows a non-member without the key nothing of another project in the same org', async () => {
    const rows = await inContext<{ person_id: string }>(
      asUser,
      ctxFor(mem.personId, orgA),
      `select person_id from public.project_members where project_id = $1`,
      [projectP2],
    );
    expect(rows).toEqual([]);
  });

  it('directory: full roster for a plain member, with display fields', async () => {
    const rows = await inContext<{ person_id: string; display_name: string; work_email: string }>(
      asUser,
      ctxFor(mem.personId, orgA),
      `select person_id, display_name, work_email from public.project_member_directory($1)`,
      [projectP],
    );
    const byId = new Map(rows.map((r) => [r.person_id, r]));
    expect(rows).toHaveLength(3);
    expect(byId.get(mem.personId)!.display_name).toBe('Mem Nick'); // preferred_name wins
    expect(byId.get(mem.personId)!.work_email).toBe('mem@pravshi.test');
    expect(byId.get(mgr)!.display_name).toBe('PM-Mgr'); // falls back to full_legal_name
    expect(byId.get(selfy.personId)!.work_email).toBeNull();
  });

  it('directory: zero rows cross-tenant and for a foreign project id', async () => {
    const asBob = await inContext(
      asUser,
      ctxFor(bob.personId, orgB),
      `select person_id from public.project_member_directory($1)`,
      [projectP],
    );
    expect(asBob).toEqual([]);
    const foreign = await inContext(
      asUser,
      ctxFor(vera.personId, orgA),
      `select person_id from public.project_member_directory($1)`,
      [projectB],
    );
    expect(foreign).toEqual([]);
  });

  it('lets a project manager insert and delete through the manager arm (no global key)', async () => {
    const inserted = await inContext<{ person_id: string }>(
      asUser,
      ctxFor(mgr, orgA),
      `insert into public.project_members (org_id, project_id, person_id, added_by)
       values ($1, $2, $3, $4) returning person_id`,
      [orgA, projectP, newbie, mgr],
    );
    expect(inserted.map((r) => r.person_id)).toEqual([newbie]);
    const deleted = await inContext<{ person_id: string }>(
      asUser,
      ctxFor(mgr, orgA),
      `delete from public.project_members where project_id = $1 and person_id = $2 returning person_id`,
      [projectP, newbie],
    );
    expect(deleted.map((r) => r.person_id)).toEqual([newbie]);
  });

  it('denies the manager arm on a project the actor does not manage (42501)', async () => {
    const state = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(mgr, orgA),
        `insert into public.project_members (org_id, project_id, person_id, added_by)
         values ($1, $2, $3, $4)`,
        [orgA, projectP2, newbie, mgr],
      ),
    );
    expect(state).toBe('42501');
  });

  it('denies cross-tenant reads and writes on project_members', async () => {
    const rows = await inContext(
      asUser,
      ctxFor(bob.personId, orgB),
      `select person_id from public.project_members where project_id = $1`,
      [projectP],
    );
    expect(rows).toEqual([]);
    const state = await sqlstateOf(
      inContext(
        asUser,
        ctxFor(bob.personId, orgB),
        `insert into public.project_members (org_id, project_id, person_id, added_by)
         values ($1, $2, $3, $4)`,
        [orgB, projectP, bob.personId, bob.personId],
      ),
    );
    expect(state).toBe('42501');
  });

  it('gives a plain member no delete: the row survives untouched', async () => {
    const deleted = await inContext<{ person_id: string }>(
      asUser,
      ctxFor(mem.personId, orgA),
      `delete from public.project_members where project_id = $1 and person_id = $2 returning person_id`,
      [projectP, mgr],
    );
    expect(deleted).toEqual([]);
    const { rows } = await owner.query<{ n: number }>(
      `select count(*)::int n from public.project_members where project_id = $1 and person_id = $2`,
      [projectP, mgr],
    );
    expect(rows[0]!.n).toBe(1);
  });
});

describe('members service', () => {
  it('lists the roster for a projects.view holder, display fields resolved', async () => {
    const auth = await authFor(vera, 'projects.view');
    const roster = await listProjectMembers(auth, projectP);
    const byId = new Map(roster.map((r) => [r.personId, r]));
    expect(roster).toHaveLength(3);
    expect(byId.get(mem.personId)!.name).toBe('Mem Nick');
    expect(byId.get(mem.personId)!.workEmail).toBe('mem@pravshi.test');
    expect(byId.get(mem.personId)!.roleInProject).toBe('member');
    expect(byId.get(mgr)!.name).toBe('PM-Mgr');
    expect(byId.get(mgr)!.roleInProject).toBe('manager');
    expect(byId.get(selfy.personId)!.workEmail).toBeNull();
  });

  it('Finding 2: a people.view SELF actor still sees the full roster', async () => {
    // The contrast first — SELF scope genuinely limits her direct people
    // reads to her own row, so a people-join implementation would shrink the
    // roster to one. The directory must not.
    const direct = await inContext<{ id: string }>(
      asUser,
      ctxFor(selfy.personId, orgA),
      `select id from public.people where org_id = $1`,
      [orgA],
    );
    expect(direct.map((r) => r.id)).toContain(selfy.personId);
    expect(direct.map((r) => r.id)).not.toContain(mem.personId);

    const auth = await authFor(selfy, 'projects.view');
    const roster = await listProjectMembers(auth, projectP);
    expect(roster.map((r) => r.personId).sort()).toEqual(
      [mem.personId, mgr, selfy.personId].sort(),
    );
    expect(roster.find((r) => r.personId === mem.personId)!.name).toBe('Mem Nick');
  });

  it('conceals a foreign project as NOT_FOUND', async () => {
    const auth = await authFor(bob, 'projects.view');
    expect(await codeOf(listProjectMembers(auth, projectP))).toBe('NOT_FOUND');
  });

  it('refuses the plain member at the permission gate (FORBIDDEN) — the member arm is RLS-level, not a route key', async () => {
    // mem's roster access exists only inside RLS and the directory definer;
    // the service surface is entered through requirePermission, which will
    // not mint a projects.view Authorization for him. This is why the member
    // arm above is pinned at the SQL level.
    const err = await codeOf(
      requirePermission(headersFor(mem.cookie), { permission: 'projects.view' }),
    );
    expect(err).toBe('FORBIDDEN');
  });

  it('round-trips add → list → remove through the service', async () => {
    const manageAuth = await authFor(admin, 'projects.manage_members');
    const afterAdd = await addProjectMember(manageAuth, projectP, { personId: newbie });
    expect(afterAdd.map((r) => r.personId).sort()).toEqual(
      [mem.personId, mgr, selfy.personId, newbie].sort(),
    );
    expect(afterAdd.find((r) => r.personId === newbie)!.roleInProject).toBe('member');

    const viewAuth = await authFor(admin, 'projects.view');
    const listed = await listProjectMembers(viewAuth, projectP);
    expect(listed.map((r) => r.personId)).toContain(newbie);

    await removeProjectMember(manageAuth, projectP, newbie);
    const afterRemove = await listProjectMembers(viewAuth, projectP);
    expect(afterRemove.map((r) => r.personId).sort()).toEqual(
      [mem.personId, mgr, selfy.personId].sort(),
    );
  });
});
