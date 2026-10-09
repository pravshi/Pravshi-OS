import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { CODE, RUN, ensureWorkSchema, inContext, mkProject, type Ctx } from '../work/helpers';
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
import { listOrgPeopleCandidates } from '@/lib/work/people-candidates';
import { addProjectMember, listProjectMembers } from '@/lib/work/projects';

/**
 * AUD-06 — org people candidates for the project/task pickers.
 *
 * The defect: the project and task pages built picker candidates ONLY from
 * people already appearing on the project's tasks, so a project's FIRST
 * member could never be added through the UI and a first task could only be
 * "Unassigned". The fix is a read-side service, listOrgPeopleCandidates,
 * whose set is — by construction — the caller's people_select-visible
 * ACTIVE people:
 *
 *  - NO directory definer and NO migration. people_select (0017) already
 *    implements the exact scope semantics (org isolation, liveness, self
 *    arm, GLOBAL / DEPARTMENT via authz.in_my_departments / TEAM via
 *    reports_to_me / PROJECT / SELF, record grants), and the write paths
 *    probe the same policy (assertPersonVisible, assertAssigneeVisibleForWrite),
 *    so a direct query under RLS makes the picker set identical to the
 *    write-accept set. A definer would re-implement that scope logic and
 *    drift from it; the 0063 roster definer exists only because the roster
 *    must EXCEED people scope under a project-membership gate.
 *  - The one deliberate narrowing over the raw policy is liveness for work:
 *    person_status = 'ACTIVE' (mirroring the 0063 roster directory). The
 *    policy-delta test below pins that this is the ONLY divergence.
 *
 * This suite pins, in order: actor preconditions (Phase 11 lesson — grants
 * asserted at build time AND probed through the authz helpers, so a bad key
 * fails here, not downstream); the exact candidate set per scope class
 * (GLOBAL incl. people on no project/task — the first-member case;
 * DEPARTMENT; SELF); the policy delta; write-probe coherence; cross-tenant
 * exclusion; and the end-to-end first-member flow through the real services.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const ctxFor = (personId: string, orgId: string): Ctx => ({ personId, orgId });

/** mkCustomRole insert-selects grants; a mistyped key would silently grant
 *  nothing. Assert the landed grant count so the failure is loud and local. */
const mkRoleChecked = async (
  org: string,
  key: string,
  grants: [permission: string, scope: string][],
): Promise<string> => {
  const role = await mkCustomRole(owner, org, key, grants);
  const { rows } = await owner.query<{ n: number }>(
    `select count(*)::int as n from public.role_permissions where role_id = $1`,
    [role],
  );
  if (rows[0]!.n !== grants.length) {
    throw new Error(
      `role ${key}: expected ${grants.length} grants, found ${rows[0]!.n} — a permission key is not in the catalogue`,
    );
  }
  return role;
};

describe.skipIf(!HAS_DB)('org people candidates (AUD-06)', () => {
  let orgA = '';
  let orgB = '';

  let admin!: Account; // org A: people.view GLOBAL (+ work keys) — dept A
  let selfy!: Account; // org A: people.view SELF — dept A
  let deptMgr!: Account; // org A: people.view DEPARTMENT — dept A
  let bob!: Account; // org B: people.view GLOBAL

  let colleagueA = ''; // org A person, engagement in dept A
  let colleagueB = ''; // org A person, engagement in dept B
  let noEng = ''; // org A person, ACTIVE, no engagement at all
  let inactive = ''; // org A person, INACTIVE, dept A engagement
  let prospect = ''; // org A person, PROSPECT, dept A engagement
  let archived = ''; // org A person, ARCHIVED, dept A engagement
  let ghost = ''; // org A person, ACTIVE but soft-deleted, dept A engagement
  let foreign = ''; // org B person

  const authFor = (account: Account, permission: string): Promise<Authorization> =>
    requirePermission(headersFor(account.cookie), { permission });

  const candidateIds = async (account: Account, permission = 'projects.view') =>
    (await listOrgPeopleCandidates(await authFor(account, permission))).map((c) => c.personId);

  beforeAll(async () => {
    await ensureWorkSchema(owner);
    orgA = await mkOrg(owner, `pc-a-${CODE}`);
    orgB = await mkOrg(owner, `pc-b-${CODE}`);
    const deptA = await mkDept(owner, orgA, `${CODE}_PA`);
    const deptB = await mkDept(owner, orgA, `${CODE}_PB`);
    const deptO = await mkDept(owner, orgB, `${CODE}_PO`);

    const adminRole = await mkRoleChecked(orgA, `${CODE}_PC_ADMIN`, [
      ['projects.view', 'GLOBAL'],
      ['projects.manage_members', 'GLOBAL'],
      ['people.view', 'GLOBAL'],
      ['tasks.view', 'GLOBAL'],
    ]);
    const selfyRole = await mkRoleChecked(orgA, `${CODE}_PC_SELFY`, [
      ['projects.view', 'GLOBAL'],
      ['people.view', 'SELF'],
    ]);
    const deptRole = await mkRoleChecked(orgA, `${CODE}_PC_DEPT`, [
      ['projects.view', 'GLOBAL'],
      ['people.view', 'DEPARTMENT'],
    ]);
    const bobRole = await mkRoleChecked(orgB, `${CODE}_PC_BOB`, [
      ['projects.view', 'GLOBAL'],
      ['people.view', 'GLOBAL'],
    ]);

    admin = await mkAccount(owner, {
      org: orgA,
      dept: deptA,
      run: RUN,
      label: 'PC-Admin',
      customRoles: [adminRole],
    });
    selfy = await mkAccount(owner, {
      org: orgA,
      dept: deptA,
      run: RUN,
      label: 'PC-Selfy',
      customRoles: [selfyRole],
    });
    deptMgr = await mkAccount(owner, {
      org: orgA,
      dept: deptA,
      run: RUN,
      label: 'PC-DeptMgr',
      customRoles: [deptRole],
    });
    bob = await mkAccount(owner, {
      org: orgB,
      dept: deptO,
      run: RUN,
      label: 'PC-Bob',
      customRoles: [bobRole],
    });

    colleagueA = await mkPerson(owner, orgA, 'PC-ColA');
    colleagueB = await mkPerson(owner, orgA, 'PC-ColB');
    noEng = await mkPerson(owner, orgA, 'PC-NoEng');
    inactive = await mkPerson(owner, orgA, 'PC-Inactive', { status: 'INACTIVE' });
    prospect = await mkPerson(owner, orgA, 'PC-Prospect', { status: 'PROSPECT' });
    archived = await mkPerson(owner, orgA, 'PC-Archived', { status: 'ARCHIVED' });
    ghost = await mkPerson(owner, orgA, 'PC-Ghost');
    foreign = await mkPerson(owner, orgB, 'PC-Foreign');

    await mkEngagement(owner, orgA, colleagueA, deptA);
    await mkEngagement(owner, orgA, colleagueB, deptB);
    await mkEngagement(owner, orgA, inactive, deptA);
    await mkEngagement(owner, orgA, prospect, deptA);
    await mkEngagement(owner, orgA, archived, deptA);
    await mkEngagement(owner, orgA, ghost, deptA);
    await mkEngagement(owner, orgB, foreign, deptO);
    // noEng deliberately gets NO engagement: visible at GLOBAL scope only.

    await owner.query(`update public.people set deleted_at = now() where id = $1`, [ghost]);
    // Display-field fixtures: preferred name wins; work email passes through.
    await owner.query(
      `update public.people set preferred_name = 'Col A Nick', work_email = 'cola@pravshi.test' where id = $1`,
      [colleagueA],
    );
  }, 120_000); // 120s: CI parallel load (the project-members suite's convention).

  afterAll(async () => {
    await owner.end();
    await asUser.end();
  });

  describe('actor capability preconditions', () => {
    const probe = async (personId: string, orgId: string, expr: string) =>
      inContext<Record<string, boolean | string | null>>(
        asUser,
        ctxFor(personId, orgId),
        `select ${expr} v`,
      );

    it('pins each actor’s people.view scope and work keys through the helpers', async () => {
      expect(
        (await probe(admin.personId, orgA, `authz.scope_for('people.view')::text`))[0]!.v,
      ).toBe('GLOBAL');
      expect(
        (await probe(selfy.personId, orgA, `authz.scope_for('people.view')::text`))[0]!.v,
      ).toBe('SELF');
      expect(
        (await probe(deptMgr.personId, orgA, `authz.scope_for('people.view')::text`))[0]!.v,
      ).toBe('DEPARTMENT');
      expect((await probe(bob.personId, orgB, `authz.scope_for('people.view')::text`))[0]!.v).toBe(
        'GLOBAL',
      );
      for (const [account, org] of [
        [admin, orgA],
        [selfy, orgA],
        [deptMgr, orgA],
        [bob, orgB],
      ] as const) {
        expect((await probe(account.personId, org, `authz.has('people.view')`))[0]!.v).toBe(true);
        expect((await probe(account.personId, org, `authz.has('projects.view')`))[0]!.v).toBe(true);
      }
      expect(
        (await probe(admin.personId, orgA, `authz.has('projects.manage_members')`))[0]!.v,
      ).toBe(true);
      expect(
        (await probe(deptMgr.personId, orgA, `authz.has('projects.manage_members')`))[0]!.v,
      ).toBe(false);
      expect(
        (await probe(selfy.personId, orgA, `authz.has('projects.manage_members')`))[0]!.v,
      ).toBe(false);
    });
  });

  describe('candidate sets per scope class', () => {
    it('GLOBAL: every ACTIVE live org person — including people on no project or task', async () => {
      // None of these fixture people belong to any project or task: this set
      // IS the first-member case the task-derived construction could not serve.
      const ids = await candidateIds(admin);
      expect(ids.sort()).toEqual(
        [admin.personId, selfy.personId, deptMgr.personId, colleagueA, colleagueB, noEng].sort(),
      );
    });

    it('GLOBAL: projection is id + preferred-name display + work email, name-ordered', async () => {
      const rows = await listOrgPeopleCandidates(await authFor(admin, 'projects.view'));
      const byId = new Map(rows.map((r) => [r.personId, r]));
      expect(byId.get(colleagueA)!.displayName).toBe('Col A Nick'); // preferred_name wins
      expect(byId.get(colleagueA)!.workEmail).toBe('cola@pravshi.test');
      expect(byId.get(colleagueB)!.displayName).toBe('PC-ColB'); // legal-name fallback
      const names = rows.map((r) => r.displayName);
      expect(names).toEqual([...names].sort());
    });

    it('the set is gate-agnostic: a tasks.view Authorization returns the same rows', async () => {
      expect((await candidateIds(admin, 'tasks.view')).sort()).toEqual(
        (await candidateIds(admin, 'projects.view')).sort(),
      );
    });

    it('DEPARTMENT: only people with a live engagement in the caller’s departments, plus self', async () => {
      const ids = await candidateIds(deptMgr);
      expect(ids.sort()).toEqual(
        [admin.personId, selfy.personId, deptMgr.personId, colleagueA].sort(),
      );
      expect(ids).not.toContain(colleagueB); // dept B — outside scope, no widening
      expect(ids).not.toContain(noEng); // no engagement — unreachable at DEPARTMENT
    });

    it('SELF: exactly the caller — no widening (the SALES case)', async () => {
      expect(await candidateIds(selfy)).toEqual([selfy.personId]);
    });

    it('cross-tenant: org B’s GLOBAL actor sees org B only, never org A people', async () => {
      const ids = await candidateIds(bob);
      expect(ids.sort()).toEqual([bob.personId, foreign].sort());
    });

    it('non-ACTIVE and soft-deleted people are excluded at every scope', async () => {
      for (const account of [admin, deptMgr]) {
        const ids = await candidateIds(account);
        for (const excluded of [inactive, prospect, archived, ghost]) {
          expect(ids, `${account.personId} must not see ${excluded}`).not.toContain(excluded);
        }
      }
    });
  });

  describe('the policy delta — the ACTIVE filter is the ONLY divergence from people_select', () => {
    it('GLOBAL raw RLS read vs service: raw adds exactly the non-ACTIVE live people', async () => {
      const raw = await inContext<{ id: string }>(
        asUser,
        ctxFor(admin.personId, orgA),
        `select id from public.people`,
      );
      const rawIds = raw.map((r) => r.id);
      // The policy itself hides the soft-deleted and the foreign — the
      // service inherits both behaviours rather than re-implementing them.
      expect(rawIds).not.toContain(ghost);
      expect(rawIds).not.toContain(foreign);
      const serviceIds = await candidateIds(admin);
      const delta = rawIds.filter((id) => !serviceIds.includes(id)).sort();
      expect(delta).toEqual([inactive, prospect, archived].sort());
      expect(serviceIds.sort()).toEqual(
        rawIds.filter((id) => ![inactive, prospect, archived].includes(id)).sort(),
      );
    });

    it('SELF raw RLS read equals the service set (no delta at SELF)', async () => {
      const raw = await inContext<{ id: string }>(
        asUser,
        ctxFor(selfy.personId, orgA),
        `select id from public.people`,
      );
      expect(raw.map((r) => r.id)).toEqual([selfy.personId]);
      expect(await candidateIds(selfy)).toEqual([selfy.personId]);
    });
  });

  describe('picker/write coherence', () => {
    it('the write probe (assertPersonVisible’s query) agrees with the picker for a DEPARTMENT actor', async () => {
      // addProjectMember and task assignment both probe `select 1 from
      // public.people where id = $1` under the caller's context. What the
      // picker hides, the probe must miss; what it shows, the probe must hit.
      const probeVisible = async (personId: string) =>
        inContext<{ ok: number }>(
          asUser,
          ctxFor(deptMgr.personId, orgA),
          `select 1 as ok from public.people where id = $1`,
          [personId],
        );
      expect(await probeVisible(colleagueA)).toHaveLength(1); // in deptMgr's candidates
      expect(await probeVisible(colleagueB)).toHaveLength(0); // hidden from the picker too
      expect(await probeVisible(foreign)).toHaveLength(0);
    });
  });

  describe('the first-member flow, end to end at service level', () => {
    it('candidates → addProjectMember on a project with no members and no tasks', async () => {
      const project = await mkProject(owner, orgA, `First member ${CODE}`);
      const { rows: counts } = await owner.query<{ members: number; tasks: number }>(
        `select (select count(*)::int from public.project_members where project_id = $1) as members,
                (select count(*)::int from public.work_tasks where project_id = $1) as tasks`,
        [project],
      );
      expect(counts[0]).toEqual({ members: 0, tasks: 0 });

      // The person being added appears on no project and no task — under the
      // old task-derived construction she was unpickable.
      const ids = await candidateIds(admin);
      expect(ids).toContain(colleagueB);

      const manageAuth = await authFor(admin, 'projects.manage_members');
      const roster = await addProjectMember(manageAuth, project, { personId: colleagueB });
      expect(roster.map((r) => r.personId)).toEqual([colleagueB]);
      expect(roster[0]!.name).toBe('PC-ColB');

      const viewAuth = await authFor(admin, 'projects.view');
      const listed = await listProjectMembers(viewAuth, project);
      expect(listed.map((r) => r.personId)).toEqual([colleagueB]);
    });
  });
});
