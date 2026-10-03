import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import {
  ALL_WORK_PERMS,
  CODE,
  assertForceRls,
  ensureWorkSchema,
  inContext,
  mkDept,
  mkEngagement,
  mkOrg,
  mkPerson,
  mkProject,
  mkRoleFor,
  mkTask,
  sqlstateOf,
  type Ctx,
} from '../work/helpers';

/**
 * Phase 4 — dedicated cross-tenant RLS matrix for the work tables.
 *
 * Every table (work_projects, work_tasks) × every operation
 * (select/insert/update/delete) is probed with two live tenants: whatever user
 * B of org B attempts against org A's rows must fail, and vice versa. This file
 * is deliberately redundant with the per-table suites — tenant isolation is the
 * property Phase 4 must never regress, so it gets its own matrix.
 *
 * Design pinned here (mirrors Phase 3 pipelines):
 *  - select/insert/update have app_user policies; there is NO delete policy —
 *    raw DELETE is denied with 42501 for everybody except app_owner, because
 *    deletes go through the soft-delete (UPDATE deleted_at) path.
 *  - soft-deleted rows are invisible to app_user of ANY org.
 *
 * Schema comes from tests/work/helpers.ts ensureWorkSchema() (contract DDL)
 * until the DB agent's migration 0042 lands; then these tests run against it.
 */

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
const asUser = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

const ctxFor = (personId: string, orgId: string): Ctx => ({ personId, orgId });

let orgA = '';
let orgB = '';
let alice = '';
let bob = '';
let projectA = '';
let projectB = '';
let taskA = '';
let taskB = '';

beforeAll(async () => {
  await ensureWorkSchema(owner);
  orgA = await mkOrg(owner, `rls-a-${CODE}`);
  orgB = await mkOrg(owner, `rls-b-${CODE}`);
  const deptA = await mkDept(owner, orgA, `${CODE}_RA`);
  const deptB = await mkDept(owner, orgB, `${CODE}_RB`);
  alice = await mkPerson(owner, orgA, 'Alice Rls');
  bob = await mkPerson(owner, orgB, 'Bob Rls');
  await mkEngagement(owner, orgA, alice, deptA);
  await mkEngagement(owner, orgB, bob, deptB);
  await mkRoleFor(owner, orgA, alice, `${CODE}_RA_FULL`, ALL_WORK_PERMS);
  await mkRoleFor(owner, orgB, bob, `${CODE}_RB_FULL`, ALL_WORK_PERMS);
  projectA = await mkProject(owner, orgA, `Matrix A ${CODE}`);
  projectB = await mkProject(owner, orgB, `Matrix B ${CODE}`);
  taskA = await mkTask(owner, orgA, `Matrix task A ${CODE}`, { projectId: projectA });
  taskB = await mkTask(owner, orgB, `Matrix task B ${CODE}`, { projectId: projectB });
}, 30_000);

afterAll(async () => {
  await owner.end();
  await asUser.end();
});

const TABLES = [
  {
    name: 'work_projects',
    rowA: () => projectA,
    rowB: () => projectB,
    seedName: (tag: string) => `Xtenant ${tag} ${CODE}`,
    insertSql: `insert into public.work_projects (org_id, name) values ($1, $2)`,
  },
  {
    name: 'work_tasks',
    rowA: () => taskA,
    rowB: () => taskB,
    seedName: (tag: string) => `Xtenant task ${tag} ${CODE}`,
    insertSql: `insert into public.work_tasks (org_id, title) values ($1, $2)`,
  },
] as const;

describe('FORCE RLS catalogue flags', () => {
  it.each(['work_projects', 'work_tasks'])('relforcerls is true on %s', async (table) => {
    await assertForceRls(owner, table);
  });

  it('each table has select/insert/update app_user policies and an app_owner policy, and no delete policy', async () => {
    for (const table of ['work_projects', 'work_tasks']) {
      const { rows } = await owner.query<{ polname: string }>(
        `select p.polname
         from pg_policy p join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = $1`,
        [table],
      );
      const names = rows.map((r) => r.polname);
      expect(names).toContain(`${table}_select`);
      expect(names).toContain(`${table}_insert`);
      expect(names).toContain(`${table}_update`);
      expect(names).toContain(`${table}_owner_all`);
      expect(names.some((n) => n.includes('delete'))).toBe(false);
    }
  });
});

describe.each(TABLES)('cross-tenant matrix: $name', ({ name, rowA, rowB, seedName, insertSql }) => {
  const selectAll = `select id from public.${name}`;
  const updateOne = `update public.${name} set updated_at = now() where id = $1 returning id`;
  const deleteOne = `delete from public.${name} where id = $1`;

  it('select: each tenant sees only its own rows', async () => {
    const seenByB = await inContext<{ id: string }>(asUser, ctxFor(bob, orgB), selectAll);
    expect(seenByB.map((r) => r.id)).not.toContain(rowA());
    expect(seenByB.map((r) => r.id)).toContain(rowB());

    const seenByA = await inContext<{ id: string }>(asUser, ctxFor(alice, orgA), selectAll);
    expect(seenByA.map((r) => r.id)).not.toContain(rowB());
    expect(seenByA.map((r) => r.id)).toContain(rowA());
  });

  it('select: a filtered query for the other org returns zero rows', async () => {
    const rows = await inContext(
      asUser,
      ctxFor(bob, orgB),
      `select id from public.${name} where id = $1`,
      [rowA()],
    );
    expect(rows).toHaveLength(0);
  });

  it('insert: writing into the other org is denied with 42501', async () => {
    // Bob → org A
    expect(
      await sqlstateOf(inContext(asUser, ctxFor(bob, orgB), insertSql, [orgA, seedName('BA')])),
    ).toBe('42501');
    // Alice → org B
    expect(
      await sqlstateOf(inContext(asUser, ctxFor(alice, orgA), insertSql, [orgB, seedName('AB')])),
    ).toBe('42501');
  });

  it('insert: writing into the own org succeeds (sanity)', async () => {
    const rows = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `${insertSql} returning id`,
      [orgB, seedName('BB')],
    );
    expect(rows).toHaveLength(1);
  });

  it('update: touching the other tenant row affects zero rows', async () => {
    const byB = await inContext(asUser, ctxFor(bob, orgB), updateOne, [rowA()]);
    expect(byB).toHaveLength(0);
    const byA = await inContext(asUser, ctxFor(alice, orgA), updateOne, [rowB()]);
    expect(byA).toHaveLength(0);
  });

  it('update: touching the own row works (sanity)', async () => {
    const rows = await inContext<{ id: string }>(asUser, ctxFor(alice, orgA), updateOne, [rowA()]);
    expect(rows).toHaveLength(1);
  });

  it('delete: raw DELETE of the other tenant row is denied with 42501', async () => {
    expect(await sqlstateOf(inContext(asUser, ctxFor(bob, orgB), deleteOne, [rowA()]))).toBe(
      '42501',
    );
    expect(await sqlstateOf(inContext(asUser, ctxFor(alice, orgA), deleteOne, [rowB()]))).toBe(
      '42501',
    );
  });

  it('delete: raw DELETE of the own row is denied too (no delete policy — soft-delete only)', async () => {
    expect(await sqlstateOf(inContext(asUser, ctxFor(alice, orgA), deleteOne, [rowA()]))).toBe(
      '42501',
    );
  });
});

describe('cross-tenant linkage attacks', () => {
  it('org B cannot attach a task to org A project (42501 project-org guard)', async () => {
    expect(
      await sqlstateOf(
        inContext(
          asUser,
          ctxFor(bob, orgB),
          `insert into public.work_tasks (org_id, project_id, title) values ($1,$2,$3)`,
          [orgB, projectA, `Hijack ${CODE}`],
        ),
      ),
    ).toBe('42501');
  });

  it('org B cannot read org A project through a task join', async () => {
    const rows = await inContext(
      asUser,
      ctxFor(bob, orgB),
      `select p.id from public.work_projects p
       join public.work_tasks t on t.project_id = p.id
       where t.id = $1`,
      [taskA],
    );
    expect(rows).toHaveLength(0);
  });

  it("org B cannot assign org A's person to a task (42501 assignee-org guard)", async () => {
    expect(
      await sqlstateOf(
        inContext(
          asUser,
          ctxFor(bob, orgB),
          `insert into public.work_tasks (org_id, title, assignee_person_id) values ($1,$2,$3)`,
          [orgB, `Poach ${CODE}`, alice],
        ),
      ),
    ).toBe('42501');
  });
});

describe('soft-deleted rows stay tenant-isolated', () => {
  it('work_soft_delete refuses a foreign row with 02000 (no tenant leak)', async () => {
    // 02000 mirrors crm_soft_delete(): missing, foreign, and deleted rows are
    // indistinguishable. Alice and Bob hold the delete permission, so the
    // function reaches the no-rows branch rather than the permission denial.
    expect(
      await sqlstateOf(
        inContext(asUser, ctxFor(bob, orgB), `select public.work_soft_delete('project', $1)`, [
          projectA,
        ]),
      ),
    ).toBe('02000');
    expect(
      await sqlstateOf(
        inContext(asUser, ctxFor(alice, orgA), `select public.work_soft_delete('task', $1)`, [
          taskB,
        ]),
      ),
    ).toBe('02000');
    // Both rows are untouched.
    expect(
      await inContext(
        asUser,
        ctxFor(alice, orgA),
        `select id from public.work_projects where id = $1`,
        [projectA],
      ),
    ).toHaveLength(1);
    expect(
      await inContext(asUser, ctxFor(bob, orgB), `select id from public.work_tasks where id = $1`, [
        taskB,
      ]),
    ).toHaveLength(1);
  });

  it('a soft-deleted row is invisible to the other tenant too', async () => {
    const id = await mkProject(owner, orgA, `Deleted secret ${CODE}`);
    await owner.query(`update public.work_projects set deleted_at = now() where id = $1`, [id]);
    expect(
      await inContext(
        asUser,
        ctxFor(bob, orgB),
        `select id from public.work_projects where id = $1`,
        [id],
      ),
    ).toHaveLength(0);
    expect(
      await inContext(
        asUser,
        ctxFor(alice, orgA),
        `select id from public.work_projects where id = $1`,
        [id],
      ),
    ).toHaveLength(0);
  });

  it('no identity sees anything on either table', async () => {
    expect(await inContext(asUser, {}, `select id from public.work_projects`)).toHaveLength(0);
    expect(await inContext(asUser, {}, `select id from public.work_tasks`)).toHaveLength(0);
  });
});
