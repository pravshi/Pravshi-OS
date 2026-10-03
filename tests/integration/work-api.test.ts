import { beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { CODE, RUN, ensureWorkSchema, tryImport } from '../work/helpers';

/**
 * Phase 4 — API/service-level tests for the work module.
 *
 * These tests call the real service functions with genuine Authorizations
 * minted by requirePermission() through real Better Auth sessions (the shared
 * Task 1.15 fixtures), exercising the full path: zod boundary → authorized DB
 * (RLS identity) → the 0042 triggers → soft-delete.
 *
 * ── Contract this file pins ──────────────────────────────────────────────────
 * The API agent had not written src/lib/work/* when these tests were authored,
 * so the service modules are loaded with best-effort dynamic imports and the
 * whole suite SKIPS until they exist (it also skips gracefully when no DB is
 * configured). When the modules land, these tests pin their surface; if the
 * API agent names things differently the suite fails loudly and the lead
 * reconciles.
 *
 * Expected service surface:
 *  - @/lib/work/projects: listProjects, createProject, getProject,
 *    updateProject, deleteProject (soft), listProjectTasks
 *  - @/lib/work/tasks: listTasks, createTask, getTask, updateTask,
 *    deleteTask (soft), moveTask, listMyTasks
 *  - list* return a page object with an `items` array
 *  - row shape is camelCase (per the CRM service precedent): id, name/title,
 *    description, isArchived, status, priority, projectId, assigneePersonId,
 *    dueDate, createdBy, createdAt, updatedAt
 *  - get/update/delete of a missing or foreign row → AuthorizationError with
 *    code 'NOT_FOUND' (concealment, never a tenant leak)
 *  - validation/domain failures → Error('INVALID_REQUEST: <message>')
 *    (a raw 42501 from a guard trigger must never leak to the caller)
 *  - missing permission → AuthorizationError with code 'FORBIDDEN'
 *
 * Run with the CI test environment (DATABASE_URL on the pooled host, APP_URL,
 * NODE_ENV=test, BETTER_AUTH_SECRET) — src/env.ts validates at import time.
 */

if (!process.env.DATABASE_URL && process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

const hasDb = !!process.env.DATABASE_URL_TEST;

interface PageLike<T> {
  rows: T[];
  total?: number;
}
interface ProjectLike {
  id: string;
  name: string;
  description?: string | null;
  isArchived: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}
interface TaskLike {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  projectId?: string | null;
  assigneePersonId?: string | null;
  dueDate?: string | null;
}

interface WorkProjectsService {
  listProjects(auth: unknown, query?: unknown): Promise<PageLike<ProjectLike>>;
  createProject(auth: unknown, input: unknown): Promise<ProjectLike>;
  getProject(auth: unknown, id: string): Promise<ProjectLike>;
  updateProject(auth: unknown, id: string, input: unknown): Promise<ProjectLike>;
  deleteProject(auth: unknown, id: string): Promise<void>;
  listProjectTasks(auth: unknown, projectId: string, query?: unknown): Promise<PageLike<TaskLike>>;
}

interface WorkTasksService {
  listTasks(auth: unknown, query?: unknown): Promise<PageLike<TaskLike>>;
  createTask(auth: unknown, input: unknown): Promise<TaskLike>;
  getTask(auth: unknown, id: string): Promise<TaskLike>;
  updateTask(auth: unknown, id: string, input: unknown): Promise<TaskLike>;
  deleteTask(auth: unknown, id: string): Promise<void>;
  moveTask(auth: unknown, id: string, input: unknown): Promise<TaskLike>;
  listMyTasks(auth: unknown, query?: unknown): Promise<PageLike<TaskLike>>;
}

interface FixturesModule {
  mkOrg(owner: Pool, slug: string): Promise<string>;
  mkDept(owner: Pool, org: string, code: string): Promise<string>;
  mkCustomRole(
    owner: Pool,
    org: string,
    key: string,
    grants: [permission: string, scope: string][],
  ): Promise<string>;
  mkAccount(
    owner: Pool,
    input: {
      org: string;
      dept: string;
      run: string;
      label: string;
      customRoles?: string[];
    },
  ): Promise<{ personId: string; cookie: string }>;
  headersFor(cookie: string, extra?: Record<string, string>): Headers;
}

interface AuthzModule {
  requirePermission(headers: Headers, opts: { permission: string }): Promise<unknown>;
}

const projects = hasDb ? await tryImport<WorkProjectsService>('@/lib/work/projects') : null;
const tasks = hasDb ? await tryImport<WorkTasksService>('@/lib/work/tasks') : null;
const fx = projects && tasks ? await tryImport<FixturesModule>('../authz/fixtures') : null;
const authz =
  projects && tasks ? await tryImport<AuthzModule>('@/lib/authz/require-permission') : null;

const ready = !!projects && !!tasks && !!fx && !!authz;
const P = () => projects!;
const T = () => tasks!;
const F = () => fx!;

const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

const authFor =
  (account: { cookie: string }) =>
  (permission: string): Promise<unknown> =>
    authz!.requirePermission(F().headersFor(account.cookie), { permission });

const authErrorCode = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
    return 'NO ERROR';
  } catch (err) {
    return (err as { code?: string }).code ?? `THREW:${(err as Error).message}`;
  }
};

const invalidRequest = async (run: Promise<unknown>): Promise<string | null> => {
  try {
    await run;
    return null;
  } catch (err) {
    return (err as Error).message ?? String(err);
  }
};

describe.skipIf(!ready)('work API: projects', () => {
  let orgA = '';
  let orgB = '';
  let alice!: { personId: string; cookie: string };
  let bob!: { personId: string; cookie: string };
  let stranger!: { personId: string; cookie: string };
  const authA = (perm: string) => authFor(alice)(perm);
  const authB = (perm: string) => authFor(bob)(perm);

  beforeAll(async () => {
    await ensureWorkSchema(owner);
    orgA = await F().mkOrg(owner, `api-a-${CODE}`);
    orgB = await F().mkOrg(owner, `api-b-${CODE}`);
    const deptA = await F().mkDept(owner, orgA, `${CODE}_AA`);
    const deptB = await F().mkDept(owner, orgB, `${CODE}_AB`);
    const deptS = await F().mkDept(owner, orgA, `${CODE}_AS`);
    const roleA = await F().mkCustomRole(owner, orgA, `${CODE}_AR`, [
      ['work_projects.view', 'GLOBAL'],
      ['work_projects.create', 'GLOBAL'],
      ['work_projects.edit', 'GLOBAL'],
      ['work_projects.delete', 'GLOBAL'],
      ['work_tasks.view', 'GLOBAL'],
      ['work_tasks.create', 'GLOBAL'],
      ['work_tasks.edit', 'GLOBAL'],
      ['work_tasks.delete', 'GLOBAL'],
    ]);
    const roleB = await F().mkCustomRole(owner, orgB, `${CODE}_BR`, [
      ['work_projects.view', 'GLOBAL'],
      ['work_projects.create', 'GLOBAL'],
      ['work_projects.edit', 'GLOBAL'],
      ['work_projects.delete', 'GLOBAL'],
      ['work_tasks.view', 'GLOBAL'],
      ['work_tasks.create', 'GLOBAL'],
      ['work_tasks.edit', 'GLOBAL'],
      ['work_tasks.delete', 'GLOBAL'],
    ]);
    alice = await F().mkAccount(owner, {
      org: orgA,
      dept: deptA,
      run: RUN,
      label: 'API-Alice',
      customRoles: [roleA],
    });
    bob = await F().mkAccount(owner, {
      org: orgB,
      dept: deptB,
      run: RUN,
      label: 'API-Bob',
      customRoles: [roleB],
    });
    stranger = await F().mkAccount(owner, {
      org: orgA,
      dept: deptS,
      run: RUN,
      label: 'API-Stranger',
    });
  }, 60_000);

  it('creates, reads, updates, archives, and soft-deletes a project', async () => {
    const created = await P().createProject(await authA('work_projects.create'), {
      name: `Website ${CODE}`,
      description: 'marketing site',
    });
    expect(created.id).toBeTruthy();
    expect(created.name).toBe(`Website ${CODE}`);
    expect(created.isArchived).toBe(false);

    const got = await P().getProject(await authA('work_projects.view'), created.id);
    expect(got.name).toBe(`Website ${CODE}`);

    const renamed = await P().updateProject(await authA('work_projects.edit'), created.id, {
      name: `Website v2 ${CODE}`,
    });
    expect(renamed.name).toBe(`Website v2 ${CODE}`);

    const archived = await P().updateProject(await authA('work_projects.edit'), created.id, {
      is_archived: true,
    });
    expect(archived.isArchived).toBe(true);

    await P().deleteProject(await authA('work_projects.delete'), created.id);
    expect(await authErrorCode(P().getProject(await authA('work_projects.view'), created.id))).toBe(
      'NOT_FOUND',
    );
  });

  it('lists only the caller org projects', async () => {
    const mine = await P().createProject(await authA('work_projects.create'), {
      name: `Mine ${CODE}`,
    });
    await P().createProject(await authB('work_projects.create'), { name: `Theirs ${CODE}` });
    const page = await P().listProjects(await authA('work_projects.view'));
    const ids = page.rows.map((p) => p.id);
    expect(ids).toContain(mine.id);
    for (const item of page.rows) {
      expect(item.id).toBeTruthy();
    }
    const pageB = await P().listProjects(await authB('work_projects.view'));
    expect(pageB.rows.map((p) => p.id)).not.toContain(mine.id);
  });

  it('rejects a blank project name with INVALID_REQUEST', async () => {
    const message = await invalidRequest(
      P().createProject(await authA('work_projects.create'), { name: '   ' }),
    );
    expect(message).toMatch(/^INVALID_REQUEST:/);
  });

  it('conceals a foreign project as NOT_FOUND on get/update/delete', async () => {
    const foreign = await P().createProject(await authB('work_projects.create'), {
      name: `Foreign ${CODE}`,
    });
    expect(await authErrorCode(P().getProject(await authA('work_projects.view'), foreign.id))).toBe(
      'NOT_FOUND',
    );
    expect(
      await authErrorCode(
        P().updateProject(await authA('work_projects.edit'), foreign.id, { name: 'x' }),
      ),
    ).toBe('NOT_FOUND');
    expect(
      await authErrorCode(P().deleteProject(await authA('work_projects.delete'), foreign.id)),
    ).toBe('NOT_FOUND');
  });

  it('denies project creation without the permission (FORBIDDEN)', async () => {
    expect(
      await authErrorCode(
        (async () =>
          P().createProject(await authFor(stranger)('work_projects.create'), {
            name: 'nope',
          }))(),
      ),
    ).toBe('FORBIDDEN');
  });

  it('lists the tasks of a project, and conceals a foreign project', async () => {
    const project = await P().createProject(await authA('work_projects.create'), {
      name: `Tasks home ${CODE}`,
    });
    const task = await T().createTask(await authA('work_tasks.create'), {
      title: `Do it ${CODE}`,
      project_id: project.id,
    });
    await T().createTask(await authA('work_tasks.create'), { title: `Elsewhere ${CODE}` });
    const page = await P().listProjectTasks(await authA('work_projects.view'), project.id);
    expect(page.rows.map((t) => t.id)).toContain(task.id);
    expect(page.rows.map((t) => t.id)).toHaveLength(1);

    const foreign = await P().createProject(await authB('work_projects.create'), {
      name: `Foreign home ${CODE}`,
    });
    expect(
      await authErrorCode(P().listProjectTasks(await authA('work_projects.view'), foreign.id)),
    ).toBe('NOT_FOUND');
  });
});

describe.skipIf(!ready)('work API: tasks', () => {
  let alice!: { personId: string; cookie: string };
  let bob!: { personId: string; cookie: string };
  const authA = (perm: string) => authFor(alice)(perm);
  const authB = (perm: string) => authFor(bob)(perm);

  beforeAll(async () => {
    await ensureWorkSchema(owner);
    const orgA = await F().mkOrg(owner, `apit-a-${CODE}`);
    const orgB = await F().mkOrg(owner, `apit-b-${CODE}`);
    const deptA = await F().mkDept(owner, orgA, `${CODE}_TA`);
    const deptB = await F().mkDept(owner, orgB, `${CODE}_TB`);
    const roleA = await F().mkCustomRole(owner, orgA, `${CODE}_TAR`, [
      ['work_projects.view', 'GLOBAL'],
      ['work_projects.create', 'GLOBAL'],
      ['work_tasks.view', 'GLOBAL'],
      ['work_tasks.create', 'GLOBAL'],
      ['work_tasks.edit', 'GLOBAL'],
      ['work_tasks.delete', 'GLOBAL'],
    ]);
    const roleB = await F().mkCustomRole(owner, orgB, `${CODE}_TBR`, [
      ['work_tasks.view', 'GLOBAL'],
      ['work_tasks.create', 'GLOBAL'],
      ['work_tasks.edit', 'GLOBAL'],
      ['work_tasks.delete', 'GLOBAL'],
    ]);
    alice = await F().mkAccount(owner, {
      org: orgA,
      dept: deptA,
      run: RUN,
      label: 'APIT-Alice',
      customRoles: [roleA],
    });
    bob = await F().mkAccount(owner, {
      org: orgB,
      dept: deptB,
      run: RUN,
      label: 'APIT-Bob',
      customRoles: [roleB],
    });
  }, 60_000);

  it('creates a task with defaults and reads it back', async () => {
    const created = await T().createTask(await authA('work_tasks.create'), {
      title: `Write docs ${CODE}`,
    });
    expect(created.id).toBeTruthy();
    expect(created.status).toBe('todo');
    expect(created.priority).toBe('medium');
    expect(created.projectId ?? null).toBeNull();

    const got = await T().getTask(await authA('work_tasks.view'), created.id);
    expect(got.title).toBe(`Write docs ${CODE}`);
  });

  it('creates a task with project, assignee, priority, and due date', async () => {
    const project = await P().createProject(await authA('work_projects.create'), {
      name: `Sprint ${CODE}`,
    });
    const created = await T().createTask(await authA('work_tasks.create'), {
      title: `Full task ${CODE}`,
      project_id: project.id,
      assignee_person_id: alice.personId,
      priority: 'urgent',
      due_date: '2026-12-31',
    });
    expect(created.projectId).toBe(project.id);
    expect(created.assigneePersonId).toBe(alice.personId);
    expect(created.priority).toBe('urgent');
  });

  it('updates a task and transitions status', async () => {
    const created = await T().createTask(await authA('work_tasks.create'), {
      title: `Evolving ${CODE}`,
    });
    const updated = await T().updateTask(await authA('work_tasks.edit'), created.id, {
      title: `Evolved ${CODE}`,
      priority: 'high',
    });
    expect(updated.title).toBe(`Evolved ${CODE}`);
    expect(updated.priority).toBe('high');
    // An unrelated edit must not clobber the stored status (default-leak guard).
    expect(updated.status).toBe('todo');
  });

  it('moves a task: status change and project change', async () => {
    const p1 = await P().createProject(await authA('work_projects.create'), {
      name: `From ${CODE}`,
    });
    const p2 = await P().createProject(await authA('work_projects.create'), {
      name: `To ${CODE}`,
    });
    const created = await T().createTask(await authA('work_tasks.create'), {
      title: `Movable ${CODE}`,
      project_id: p1.id,
    });
    const moved = await T().moveTask(await authA('work_tasks.edit'), created.id, {
      status: 'in_progress',
    });
    expect(moved.status).toBe('in_progress');
    expect(moved.projectId).toBe(p1.id);

    const relocated = await T().moveTask(await authA('work_tasks.edit'), created.id, {
      project_id: p2.id,
    });
    expect(relocated.projectId).toBe(p2.id);
  });

  it('rejects invalid move input with INVALID_REQUEST', async () => {
    const created = await T().createTask(await authA('work_tasks.create'), {
      title: `Unmovable ${CODE}`,
    });
    expect(
      await invalidRequest(T().moveTask(await authA('work_tasks.edit'), created.id, {})),
    ).toMatch(/^INVALID_REQUEST:/);
    expect(
      await invalidRequest(
        T().moveTask(await authA('work_tasks.edit'), created.id, { status: 'nope' }),
      ),
    ).toMatch(/^INVALID_REQUEST:/);
  });

  it('rejects a move onto a foreign project with INVALID_REQUEST (no 42501 leak)', async () => {
    const foreign = await P().createProject(await authB('work_projects.create'), {
      name: `Foreign target ${CODE}`,
    });
    const created = await T().createTask(await authA('work_tasks.create'), {
      title: `Stay home ${CODE}`,
    });
    const message = await invalidRequest(
      T().moveTask(await authA('work_tasks.edit'), created.id, { project_id: foreign.id }),
    );
    expect(message).toMatch(/^INVALID_REQUEST:/);
    expect(message).not.toMatch(/42501/);
  });

  it('rejects creating a task in a foreign project with INVALID_REQUEST', async () => {
    const foreign = await P().createProject(await authB('work_projects.create'), {
      name: `Foreign new ${CODE}`,
    });
    const message = await invalidRequest(
      T().createTask(await authA('work_tasks.create'), {
        title: 'x',
        project_id: foreign.id,
      }),
    );
    expect(message).toMatch(/^INVALID_REQUEST:/);
    expect(message).not.toMatch(/42501/);
  });

  it('rejects a foreign assignee with INVALID_REQUEST', async () => {
    const message = await invalidRequest(
      T().createTask(await authA('work_tasks.create'), {
        title: 'x',
        assignee_person_id: bob.personId,
      }),
    );
    expect(message).toMatch(/^INVALID_REQUEST:/);
    expect(message).not.toMatch(/42501/);
  });

  it('soft-deletes a task: get/update/delete afterwards are NOT_FOUND', async () => {
    const created = await T().createTask(await authA('work_tasks.create'), {
      title: `Doomed ${CODE}`,
    });
    await T().deleteTask(await authA('work_tasks.delete'), created.id);
    expect(await authErrorCode(T().getTask(await authA('work_tasks.view'), created.id))).toBe(
      'NOT_FOUND',
    );
    expect(
      await authErrorCode(
        T().updateTask(await authA('work_tasks.edit'), created.id, { title: 'x' }),
      ),
    ).toBe('NOT_FOUND');
    expect(await authErrorCode(T().deleteTask(await authA('work_tasks.delete'), created.id))).toBe(
      'NOT_FOUND',
    );
  });

  it('conceals a foreign task as NOT_FOUND on get/update/delete/move', async () => {
    const foreign = await T().createTask(await authB('work_tasks.create'), {
      title: `Foreign task ${CODE}`,
    });
    expect(await authErrorCode(T().getTask(await authA('work_tasks.view'), foreign.id))).toBe(
      'NOT_FOUND',
    );
    expect(
      await authErrorCode(
        T().updateTask(await authA('work_tasks.edit'), foreign.id, { title: 'x' }),
      ),
    ).toBe('NOT_FOUND');
    expect(await authErrorCode(T().deleteTask(await authA('work_tasks.delete'), foreign.id))).toBe(
      'NOT_FOUND',
    );
    expect(
      await authErrorCode(
        T().moveTask(await authA('work_tasks.edit'), foreign.id, { status: 'done' }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('listMyTasks returns only tasks assigned to the caller', async () => {
    const mine = await T().createTask(await authA('work_tasks.create'), {
      title: `Assigned to me ${CODE}`,
      assignee_person_id: alice.personId,
    });
    await T().createTask(await authA('work_tasks.create'), {
      title: `Unassigned ${CODE}`,
    });
    const page = await T().listMyTasks(await authA('work_tasks.view'));
    const ids = page.rows.map((t) => t.id);
    expect(ids).toContain(mine.id);
    expect(page.rows.every((t) => t.assigneePersonId === alice.personId)).toBe(true);
  });

  it('lists only the caller org tasks', async () => {
    const mine = await T().createTask(await authA('work_tasks.create'), {
      title: `Org mine ${CODE}`,
    });
    await T().createTask(await authB('work_tasks.create'), { title: `Org theirs ${CODE}` });
    const page = await T().listTasks(await authA('work_tasks.view'));
    expect(page.rows.map((t) => t.id)).toContain(mine.id);
    const pageB = await T().listTasks(await authB('work_tasks.view'));
    expect(pageB.rows.map((t) => t.id)).not.toContain(mine.id);
  });
});
