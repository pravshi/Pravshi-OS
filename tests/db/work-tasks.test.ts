import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import {
  ALL_WORK_PERMS,
  CODE,
  PERMS,
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
 * Phase 4 — work_tasks: DB-level CRUD, constraints, guards, RLS.
 *
 * Same harness as the Phase 1–3 suites: owner (DATABASE_URL_MIGRATE, app_owner)
 * seeds fixtures and inspects the catalogue; user (DATABASE_URL_TEST, app_user)
 * is where every boundary is probed.
 *
 * Coverage: FORCE RLS catalogue flag, task CRUD as app_user (create with and
 * without a project, read, update, status transitions, soft-delete), column
 * defaults (status 'todo', priority 'medium', timestamps), the status/priority
 * CHECK constraints (23514 on invalid values), the title-not-blank CHECK, the
 * work_task_project_org_guard() trigger (42501 when the project lives in
 * another org — including on UPDATE that moves the task across projects), the
 * work_task_assignee_org_guard() trigger (42501 when the assignee lives in
 * another org), tenant isolation (org B sees and touches nothing of org A),
 * the permission gates (work_tasks.view/create/edit at GLOBAL scope), the
 * no-identity fail-closed default, soft-delete semantics, raw DELETE denied
 * (42501, soft-delete-only), standalone tasks (project_id NULL), due_date
 * handling, and ON DELETE SET NULL from project to task.
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

beforeAll(async () => {
  await ensureWorkSchema(owner);
  orgA = await mkOrg(owner, `task-a-${CODE}`);
  orgB = await mkOrg(owner, `task-b-${CODE}`);
  const deptA = await mkDept(owner, orgA, `${CODE}_TA`);
  const deptB = await mkDept(owner, orgB, `${CODE}_TB`);
  alice = await mkPerson(owner, orgA, 'Alice Tasks');
  bob = await mkPerson(owner, orgB, 'Bob Tasks');
  await mkEngagement(owner, orgA, alice, deptA);
  await mkEngagement(owner, orgB, bob, deptB);
  await mkRoleFor(owner, orgA, alice, `${CODE}_TA_FULL`, ALL_WORK_PERMS);
  await mkRoleFor(owner, orgB, bob, `${CODE}_TB_FULL`, ALL_WORK_PERMS);
  projectA = await mkProject(owner, orgA, `Sprint ${CODE}`);
}, 30_000);

afterAll(async () => {
  await owner.end();
  await asUser.end();
});

describe('FORCE RLS is on for work_tasks', () => {
  it('pg_class.relforcerls is true', async () => {
    await assertForceRls(owner, 'work_tasks');
  });
});

describe('task CRUD as app_user', () => {
  it('creates a task in a project with defaults and reads it back', async () => {
    const ctx = ctxFor(alice, orgA);
    const rows = await inContext<{ id: string }>(
      asUser,
      ctx,
      `insert into public.work_tasks (org_id, project_id, title, created_by)
       values ($1, $2, $3, $4) returning id`,
      [orgA, projectA, `Write tests ${CODE}`, alice],
    );
    const id = rows[0]!.id;
    const got = (
      await inContext<Record<string, unknown>>(
        asUser,
        ctx,
        `select id, org_id, project_id, title, status, priority,
                due_date, assignee_person_id, created_by, deleted_at
         from public.work_tasks where id = $1`,
        [id],
      )
    )[0]!;
    expect(got.project_id).toBe(projectA);
    expect(got.status).toBe('todo');
    expect(got.priority).toBe('medium');
    expect(got.due_date).toBeNull();
    expect(got.assignee_person_id).toBeNull();
    expect(got.created_by).toBe(alice);
    expect(got.deleted_at).toBeNull();
  });

  it('creates a standalone task (project_id NULL)', async () => {
    const ctx = ctxFor(alice, orgA);
    const rows = await inContext<{ id: string }>(
      asUser,
      ctx,
      `insert into public.work_tasks (org_id, title, description, priority, due_date)
       values ($1, $2, $3, 'high', '2026-12-31') returning id`,
      [orgA, `Ad-hoc ${CODE}`, 'no project needed'],
    );
    const got = (
      await inContext<{ project_id: string | null; priority: string; due_date: Date }>(
        asUser,
        ctx,
        `select project_id, priority, due_date from public.work_tasks where id = $1`,
        [rows[0]!.id],
      )
    )[0]!;
    expect(got.project_id).toBeNull();
    expect(got.priority).toBe('high');
    // node-postgres parses `date` columns into JS Dates (midnight UTC).
    expect(got.due_date.toISOString().slice(0, 10)).toBe('2026-12-31');
  });

  it('transitions status todo → in_progress → done', async () => {
    const ctx = ctxFor(alice, orgA);
    const id = await mkTask(owner, orgA, `Lifecycle ${CODE}`, { projectId: projectA });
    for (const status of ['in_progress', 'done']) {
      await inContext(asUser, ctx, `update public.work_tasks set status = $2 where id = $1`, [
        id,
        status,
      ]);
      const got = (
        await inContext<{ status: string }>(
          asUser,
          ctx,
          `select status from public.work_tasks where id = $1`,
          [id],
        )
      )[0]!;
      expect(got.status).toBe(status);
    }
  });

  it('updates priority, assignee, and due_date', async () => {
    const ctx = ctxFor(alice, orgA);
    const id = await mkTask(owner, orgA, `Reprioritize ${CODE}`, { projectId: projectA });
    await inContext(
      asUser,
      ctx,
      `update public.work_tasks
       set priority = 'urgent', assignee_person_id = $2, due_date = '2026-11-30'
       where id = $1`,
      [id, alice],
    );
    const got = (
      await inContext<{ priority: string; assignee_person_id: string; due_date: Date }>(
        asUser,
        ctx,
        `select priority, assignee_person_id, due_date from public.work_tasks where id = $1`,
        [id],
      )
    )[0]!;
    expect(got.priority).toBe('urgent');
    expect(got.assignee_person_id).toBe(alice);
    expect(got.due_date.toISOString().slice(0, 10)).toBe('2026-11-30');
  });

  it('moves a task to another project in the same org', async () => {
    const ctx = ctxFor(alice, orgA);
    const other = await mkProject(owner, orgA, `Other ${CODE}`);
    const id = await mkTask(owner, orgA, `Movable ${CODE}`, { projectId: projectA });
    await inContext(asUser, ctx, `update public.work_tasks set project_id = $2 where id = $1`, [
      id,
      other,
    ]);
    const got = (
      await inContext<{ project_id: string }>(
        asUser,
        ctx,
        `select project_id from public.work_tasks where id = $1`,
        [id],
      )
    )[0]!;
    expect(got.project_id).toBe(other);
  });
});

describe('status / priority / title constraints', () => {
  const ctx = () => ctxFor(alice, orgA);

  it.each(['donee', 'IN_PROGRESS', '', 'archived'])(
    'rejects invalid status %p with 23514',
    async (status) => {
      expect(
        await sqlstateOf(
          inContext(
            asUser,
            ctx(),
            `insert into public.work_tasks (org_id, title, status) values ($1,$2,$3)`,
            [orgA, `Bad status ${CODE}`, status],
          ),
        ),
      ).toBe('23514');
    },
  );

  it.each(['critical', 'MEDIUM', '', 'p0'])(
    'rejects invalid priority %p with 23514',
    async (priority) => {
      expect(
        await sqlstateOf(
          inContext(
            asUser,
            ctx(),
            `insert into public.work_tasks (org_id, title, priority) values ($1,$2,$3)`,
            [orgA, `Bad priority ${CODE}`, priority],
          ),
        ),
      ).toBe('23514');
    },
  );

  it('rejects an invalid status on update too', async () => {
    const id = await mkTask(owner, orgA, `Constrained ${CODE}`);
    expect(
      await sqlstateOf(
        inContext(asUser, ctx(), `update public.work_tasks set status = 'nope' where id = $1`, [
          id,
        ]),
      ),
    ).toBe('23514');
  });

  it('rejects a blank title with 23514', async () => {
    expect(
      await sqlstateOf(
        inContext(asUser, ctx(), `insert into public.work_tasks (org_id, title) values ($1,$2)`, [
          orgA,
          '  ',
        ]),
      ),
    ).toBe('23514');
  });
});

describe('project-org guard', () => {
  it('rejects a task whose project lives in another org (42501)', async () => {
    const projectB = await mkProject(owner, orgB, `Foreign ${CODE}`);
    expect(
      await sqlstateOf(
        inContext(
          asUser,
          ctxFor(alice, orgA),
          `insert into public.work_tasks (org_id, project_id, title) values ($1,$2,$3)`,
          [orgA, projectB, `Cross-org ${CODE}`],
        ),
      ),
    ).toBe('42501');
  });

  it('rejects moving a task onto a foreign project (42501)', async () => {
    const ctx = ctxFor(alice, orgA);
    const projectB = await mkProject(owner, orgB, `Foreign move ${CODE}`);
    const id = await mkTask(owner, orgA, `Move me ${CODE}`, { projectId: projectA });
    expect(
      await sqlstateOf(
        inContext(asUser, ctx, `update public.work_tasks set project_id = $2 where id = $1`, [
          id,
          projectB,
        ]),
      ),
    ).toBe('42501');
  });

  it('rejects re-homing a task into another org_id (42501)', async () => {
    const id = await mkTask(owner, orgA, `Rehome ${CODE}`, { projectId: projectA });
    expect(
      await sqlstateOf(
        inContext(
          asUser,
          ctxFor(alice, orgA),
          `update public.work_tasks set org_id = $2 where id = $1`,
          [id, orgB],
        ),
      ),
    ).toBe('42501');
  });
});

describe('assignee-org guard', () => {
  it('rejects assigning a task to a person in another org (42501)', async () => {
    expect(
      await sqlstateOf(
        inContext(
          asUser,
          ctxFor(alice, orgA),
          `insert into public.work_tasks (org_id, title, assignee_person_id) values ($1,$2,$3)`,
          [orgA, `Foreign assignee ${CODE}`, bob],
        ),
      ),
    ).toBe('42501');
  });

  it('rejects re-assigning to a foreign person on update (42501)', async () => {
    const ctx = ctxFor(alice, orgA);
    const id = await mkTask(owner, orgA, `Reassign ${CODE}`, { assignee: alice });
    expect(
      await sqlstateOf(
        inContext(
          asUser,
          ctx,
          `update public.work_tasks set assignee_person_id = $2 where id = $1`,
          [id, bob],
        ),
      ),
    ).toBe('42501');
  });

  it('allows unassigning (assignee → NULL)', async () => {
    const ctx = ctxFor(alice, orgA);
    const id = await mkTask(owner, orgA, `Unassign ${CODE}`, { assignee: alice });
    await inContext(
      asUser,
      ctx,
      `update public.work_tasks set assignee_person_id = null where id = $1`,
      [id],
    );
    const got = (
      await inContext<{ assignee_person_id: string | null }>(
        asUser,
        ctx,
        `select assignee_person_id from public.work_tasks where id = $1`,
        [id],
      )
    )[0]!;
    expect(got.assignee_person_id).toBeNull();
  });
});

describe('referential integrity', () => {
  it('hard-deleting a project nulls the task project_id (ON DELETE SET NULL)', async () => {
    const doomed = await mkProject(owner, orgA, `Doomed ${CODE}`);
    const id = await mkTask(owner, orgA, `Orphan ${CODE}`, { projectId: doomed });
    await owner.query(`delete from public.work_projects where id = $1`, [doomed]);
    const got = await owner.query<{ project_id: string | null }>(
      `select project_id from public.work_tasks where id = $1`,
      [id],
    );
    expect(got.rows[0]!.project_id).toBeNull();
  });

  it('a task cannot reference a nonexistent project: the org guard fires first (42501)', async () => {
    // BEFORE triggers run ahead of FK constraint checks, so the
    // work_task_project_org_guard() denies the write with 42501 before the
    // foreign key could report 23503. The guard is the contract pin; the FK
    // remains as backstop.
    expect(
      await sqlstateOf(
        inContext(
          asUser,
          ctxFor(alice, orgA),
          `insert into public.work_tasks (org_id, project_id, title) values ($1,$2,$3)`,
          [orgA, '00000000-0000-0000-0000-000000000000', `Ghost project ${CODE}`],
        ),
      ),
    ).toBe('42501');
  });
});

describe('soft-delete semantics for tasks', () => {
  it('soft-deleted tasks vanish for app_user but remain for app_owner', async () => {
    const ctx = ctxFor(alice, orgA);
    const id = await mkTask(owner, orgA, `Delete me ${CODE}`, { projectId: projectA });
    await inContext(asUser, ctx, `select public.work_soft_delete('task', $1)`, [id]);
    expect(
      await inContext(asUser, ctx, `select id from public.work_tasks where id = $1`, [id]),
    ).toHaveLength(0);
    const asOwner = await owner.query(`select deleted_at from public.work_tasks where id = $1`, [
      id,
    ]);
    expect(asOwner.rows).toHaveLength(1);
    expect(asOwner.rows[0]!.deleted_at).toBeTruthy();
  });

  it('a direct UPDATE of deleted_at is denied with 42501', async () => {
    const ctx = ctxFor(alice, orgA);
    const id = await mkTask(owner, orgA, `Direct ${CODE}`);
    expect(
      await sqlstateOf(
        inContext(asUser, ctx, `update public.work_tasks set deleted_at = now() where id = $1`, [
          id,
        ]),
      ),
    ).toBe('42501');
  });

  it('work_soft_delete raises 02000 for a foreign task (no tenant leak)', async () => {
    const foreign = await mkTask(owner, orgB, `Foreign task del ${CODE}`);
    expect(
      await sqlstateOf(
        inContext(asUser, ctxFor(alice, orgA), `select public.work_soft_delete('task', $1)`, [
          foreign,
        ]),
      ),
    ).toBe('02000');
  });

  it('raw DELETE is denied with 42501 even for own rows', async () => {
    const ctx = ctxFor(alice, orgA);
    const id = await mkTask(owner, orgA, `Hard delete ${CODE}`);
    expect(
      await sqlstateOf(inContext(asUser, ctx, `delete from public.work_tasks where id = $1`, [id])),
    ).toBe('42501');
  });
});

describe('tenant isolation for work_tasks', () => {
  it("org B cannot select org A's tasks", async () => {
    await mkTask(owner, orgA, `Secret task ${CODE}`, { projectId: projectA });
    const rows = await inContext(
      asUser,
      ctxFor(bob, orgB),
      `select id from public.work_tasks where org_id = $1`,
      [orgA],
    );
    expect(rows).toHaveLength(0);
  });

  it('org B cannot insert a task into org A (42501)', async () => {
    expect(
      await sqlstateOf(
        inContext(
          asUser,
          ctxFor(bob, orgB),
          `insert into public.work_tasks (org_id, title) values ($1,$2)`,
          [orgA, `Sneaky task ${CODE}`],
        ),
      ),
    ).toBe('42501');
  });

  it("org B cannot update org A's tasks (0 rows)", async () => {
    const id = await mkTask(owner, orgA, `Untouchable task ${CODE}`);
    const rows = await inContext<{ id: string }>(
      asUser,
      ctxFor(bob, orgB),
      `update public.work_tasks set title = 'pwned' where id = $1 returning id`,
      [id],
    );
    expect(rows).toHaveLength(0);
  });

  it("org B cannot delete org A's tasks (42501)", async () => {
    const id = await mkTask(owner, orgA, `Doomed task ${CODE}`);
    expect(
      await sqlstateOf(
        inContext(asUser, ctxFor(bob, orgB), `delete from public.work_tasks where id = $1`, [id]),
      ),
    ).toBe('42501');
  });
});

describe('permission gates for work_tasks', () => {
  it('a user with no work permissions sees nothing and cannot write', async () => {
    const ghost = await mkPerson(owner, orgA, 'Ghost Writer');
    const dept = await mkDept(owner, orgA, `${CODE}_TG`);
    await mkEngagement(owner, orgA, ghost, dept);
    const ctx = ctxFor(ghost, orgA);
    await mkTask(owner, orgA, `Hidden task ${CODE}`);
    expect(await inContext(asUser, ctx, `select id from public.work_tasks`)).toHaveLength(0);
    expect(
      await sqlstateOf(
        inContext(asUser, ctx, `insert into public.work_tasks (org_id, title) values ($1,$2)`, [
          orgA,
          `Nope ${CODE}`,
        ]),
      ),
    ).toBe('42501');
  });

  it('view+edit user can update but not create', async () => {
    const editor = await mkPerson(owner, orgA, 'Editor Only');
    const dept = await mkDept(owner, orgA, `${CODE}_TE`);
    await mkEngagement(owner, orgA, editor, dept);
    await mkRoleFor(owner, orgA, editor, `${CODE}_TE_ONLY`, [PERMS.tasks.view, PERMS.tasks.edit]);
    const ctx = ctxFor(editor, orgA);
    const id = await mkTask(owner, orgA, `Editable ${CODE}`);
    await inContext(asUser, ctx, `update public.work_tasks set title = 'edited' where id = $1`, [
      id,
    ]);
    const got = (
      await inContext<{ title: string }>(
        asUser,
        ctx,
        `select title from public.work_tasks where id = $1`,
        [id],
      )
    )[0]!;
    expect(got.title).toBe('edited');
    expect(
      await sqlstateOf(
        inContext(asUser, ctx, `insert into public.work_tasks (org_id, title) values ($1,$2)`, [
          orgA,
          `Denied ${CODE}`,
        ]),
      ),
    ).toBe('42501');
  });

  it('without the view permission a row is invisible to UPDATE too (0 rows, no error)', async () => {
    // PostgreSQL applies the SELECT policy to the UPDATE's row lookup: a
    // caller who cannot SELECT a row cannot UPDATE it either, even holding
    // the edit permission. You cannot touch what you cannot see.
    const editor = await mkPerson(owner, orgA, 'Editor Two');
    const dept = await mkDept(owner, orgA, `${CODE}_TE2`);
    await mkEngagement(owner, orgA, editor, dept);
    await mkRoleFor(owner, orgA, editor, `${CODE}_TE2_ONLY`, [PERMS.tasks.edit]);
    const ctx = ctxFor(editor, orgA);
    const id = await mkTask(owner, orgA, `Untouchable edit ${CODE}`);
    const rows = await inContext<{ id: string }>(
      asUser,
      ctx,
      `update public.work_tasks set title = 'edited2' where id = $1 returning id`,
      [id],
    );
    expect(rows).toHaveLength(0);
    const got = await owner.query<{ title: string }>(
      `select title from public.work_tasks where id = $1`,
      [id],
    );
    expect(got.rows[0]!.title).toBe(`Untouchable edit ${CODE}`);
  });

  it('no identity sees nothing and cannot insert (fail closed)', async () => {
    await mkTask(owner, orgA, `Fail closed ${CODE}`);
    expect(await inContext(asUser, {}, `select id from public.work_tasks`)).toHaveLength(0);
    expect(
      await sqlstateOf(
        inContext(asUser, {}, `insert into public.work_tasks (org_id, title) values ($1,$2)`, [
          orgA,
          `Ghost ${CODE}`,
        ]),
      ),
    ).toBe('42501');
  });
});
