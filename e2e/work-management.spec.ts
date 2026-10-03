import { expect, test, type Page } from '@playwright/test';
import { Pool } from '@neondatabase/serverless';
import { randomBytes } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';

/**
 * Work Management end-to-end (Phase 4).
 *
 * Covers the full lifecycle through the real UI and API:
 *
 *   LOGIN → SELECT ORG → CREATE PROJECT → ADD MEMBERS → CREATE TASK →
 *   ASSIGN TASK → CREATE SUBTASK → UPDATE TASK → MOVE TASK (kanban) →
 *   COMPLETE TASK → VIEW PROJECT PROGRESS → VERIFY AUDIT LOG
 *
 * plus tenant isolation (IDOR), search/filter/sort/pagination, empty states,
 * and error states.
 *
 * ── Contracts under test ────────────────────────────────────────────────────
 * API (src/app/api/work/*):
 *   POST /api/work/projects            { name, description? }            → 201
 *   GET  /api/work/projects            ?search=&limit=&offset=           → { rows, total, limit, offset }
 *                                        &includeArchived=&sort=&order=    rows carry taskCount/openTaskCount
 *   GET|PATCH|DELETE /api/work/projects/[id]                              → project / updated / archived
 *   GET|POST /api/work/projects/[id]/members  { personId, roleInProject? }→ member list / 201 + member list
 *   POST /api/work/tasks               { title, projectId?, description?,
 *                                        status?, priority?, dueDate?,
 *                                        assigneePersonId? }             → 201
 *   GET  /api/work/tasks               ?search=&projectId=&status=       → { rows, total, limit, offset }
 *                                        &priority=&assigneePersonId=
 *                                        &sort=&order=
 *   GET|PATCH|DELETE /api/work/tasks/[id]                                → task / updated / soft-deleted
 *   POST /api/work/tasks/[id]/move     { status }                        → { ok, taskId, fromStatus, toStatus }
 *   GET  /api/work/tasks/mine                                            → my tasks
 * Task statuses: todo | in_progress | done. Priorities: low | medium | high | urgent.
 * UI (src/app/(app)/work/*):
 *   /work                       project list; empty state "No projects yet"
 *   /work/projects/new          create form (Name → "Create project")
 *   /work/projects/[id]         kanban; columns aria-label "Status column: To do|In progress|Done";
 *                               cards role=option, focusable, ArrowLeft/Right moves between columns;
 *                               invisible project → "Could not load project"
 *   /work/my-tasks              empty state "Nothing assigned to you"
 *   /work/tasks/[id]            task detail; invisible task → "Could not load task"
 *
 * ── Assumptions (Phase 4 agents still integrating) ──────────────────────────
 * 1. SELECT ORG: the app has no org-switcher UI — the session is scoped to the
 *    person's org via their primary engagement. The test proves the scoping
 *    functionally (org A's user never sees org B's data; see the IDOR block).
 * 2. Subtasks: migration 0042 carries parent_task_id with org/project
 *    inheritance and cycle guards, but the /api/work/tasks body schema in the
 *    API worktree does not yet accept parentTaskId (strictObject → 400 on
 *    unknown fields). The subtask test attempts POST with { parentTaskId };
 *    if the API answers 400 it is skipped with the reason recorded — remove
 *    the skip once the subtask contract lands.
 * 3. Project progress: the API listProjects rows carry taskCount/openTaskCount
 *    (done = taskCount − openTaskCount); the kanban "Done" column shows
 *    completed cards. There is no separate progress-percentage widget.
 * 4. Audit: migration 0042 attaches audit_row_change() (HIGH, whole-row) to
 *    work_projects, project_members and work_tasks, writing actions like
 *    work_project.created / work_task.updated with result SUCCESS. Verified
 *    here by direct SQL, the same way the suite seeds.
 *
 * ── Setup ───────────────────────────────────────────────────────────────────
 * Needs DATABASE_URL_MIGRATE (the app_owner URL, used for seeding and audit
 * verification — CI sets it to the ephemeral Neon branch). Without it the
 * whole file skips. Run:  pnpm build && pnpm e2e e2e/work-management.spec.ts
 * (the playwright webServer boots `next start` on :3100 against the app's
 * normal DATABASE_URL; seed through a disposable Neon branch, never
 * production).
 */

const MIGRATE_URL = process.env.DATABASE_URL_MIGRATE;
const RUN = randomBytes(4).toString('hex');
const STAMP = Date.now().toString().slice(-10).padStart(10, '0');

// people.code must satisfy people_code_format (^[A-Z]{2,8}-[0-9]{4}-[0-9]{4,}$).
const personCode = (tag: string) => `WM-${tag}-${STAMP}`;

const ADMIN_A_EMAIL = `wm.admina.${RUN}@example.test`;
const ADMIN_B_EMAIL = `wm.adminb.${RUN}@example.test`;
const FINANCE_A_EMAIL = `wm.financea.${RUN}@example.test`;
const MEMBER_A_EMAIL = `wm.membera.${RUN}@example.test`;
const PASSWORD = `Work-E2E-${RUN}!`;

let orgAId = '';
let orgBId = '';
let adminAPersonId = '';
let memberAPersonId = '';
let orgBProjectId = '';
let orgBTaskId = '';

let projectId = '';
let taskId = '';
let subtaskId = '';

async function seedPerson(
  pool: Pool,
  opts: {
    orgId: string;
    deptId: string;
    roleKey: string;
    email: string;
    password: string;
    fullName: string;
    codeTag: string;
  },
): Promise<string> {
  const role = await pool.query<{ id: string }>(
    `select id from public.roles where org_id = $1 and key = $2`,
    [opts.orgId, opts.roleKey],
  );
  const roleId = role.rows[0]?.id;
  if (!roleId) throw new Error(`role ${opts.roleKey} not seeded for org ${opts.orgId}`);

  const passwordHash = await hashPassword(opts.password);
  const authUser = await pool.query<{ id: string }>(
    `insert into auth.auth_users (email, email_verified, name) values ($1::citext, true, $2) returning id`,
    [opts.email, opts.fullName],
  );
  const authUserId = authUser.rows[0]!.id;
  await pool.query(
    `insert into auth.auth_accounts (user_id, account_id, provider_id, password)
     values ($1, $2::citext, 'credential', $3)`,
    [authUserId, opts.email, passwordHash],
  );

  const person = await pool.query<{ id: string }>(
    `insert into public.people
       (org_id, code, full_legal_name, work_email, person_status, auth_user_id)
     values ($1, $2, $3, $4::citext, 'ACTIVE', $5) returning id`,
    [opts.orgId, personCode(opts.codeTag), opts.fullName, opts.email, authUserId],
  );
  const personId = person.rows[0]!.id;

  await pool.query(
    `insert into public.engagements
       (org_id, person_id, engagement_type, status, department_id, start_date, is_primary)
     values ($1, $2, 'EMPLOYEE', 'ACTIVE', $3, '2026-01-05', true)`,
    [opts.orgId, personId, opts.deptId],
  );
  await pool.query(
    `insert into public.person_roles (person_id, role_id, org_id) values ($1, $2, $3)`,
    [personId, roleId, opts.orgId],
  );
  return personId;
}

test.beforeAll(async () => {
  test.skip(!MIGRATE_URL, 'needs DATABASE_URL_MIGRATE to seed the orgs and users');
  const pool = new Pool({ connectionString: MIGRATE_URL });
  try {
    for (const [key, name] of [
      ['a', `Work E2E A ${RUN}`],
      ['b', `Work E2E B ${RUN}`],
    ] as const) {
      const org = await pool.query<{ id: string }>(
        `insert into public.organizations (name, slug) values ($1, $2) returning id`,
        [name, `wm-${key}-${RUN}`],
      );
      const orgId = org.rows[0]!.id;
      if (key === 'a') orgAId = orgId;
      else orgBId = orgId;

      const dept = await pool.query<{ id: string }>(
        `insert into public.departments (org_id, code, name) values ($1, 'ENG', 'Engineering') returning id`,
        [orgId],
      );
      const deptId = dept.rows[0]!.id;

      if (key === 'a') {
        adminAPersonId = await seedPerson(pool, {
          orgId,
          deptId,
          roleKey: 'SUPER_ADMIN',
          email: ADMIN_A_EMAIL,
          password: PASSWORD,
          fullName: 'Work E2E Admin A',
          codeTag: '2026',
        });
        memberAPersonId = await seedPerson(pool, {
          orgId,
          deptId,
          roleKey: 'EMPLOYEE',
          email: MEMBER_A_EMAIL,
          password: PASSWORD,
          fullName: 'Work E2E Member A',
          codeTag: '2027',
        });
        await seedPerson(pool, {
          orgId,
          deptId,
          roleKey: 'FINANCE',
          email: FINANCE_A_EMAIL,
          password: PASSWORD,
          fullName: 'Work E2E Finance A',
          codeTag: '2028',
        });
      } else {
        await seedPerson(pool, {
          orgId,
          deptId,
          roleKey: 'SUPER_ADMIN',
          email: ADMIN_B_EMAIL,
          password: PASSWORD,
          fullName: 'Work E2E Admin B',
          codeTag: '2029',
        });
        // Org B's project and task: the IDOR targets. Seeded directly; the
        // audit trigger stays silent for seed writes (no app.person_id), which
        // is exactly what the audit test later distinguishes from app writes.
        const proj = await pool.query<{ id: string }>(
          `insert into public.work_projects (org_id, name, description)
           values ($1, $2, $3) returning id`,
          [orgId, `Org B Secret Project ${RUN}`, 'must stay invisible to org A'],
        );
        orgBProjectId = proj.rows[0]!.id;
        const tsk = await pool.query<{ id: string }>(
          `insert into public.work_tasks (org_id, project_id, title, status, priority)
           values ($1, $2, $3, 'todo', 'high') returning id`,
          [orgId, orgBProjectId, `Org B Secret Task ${RUN}`],
        );
        orgBTaskId = tsk.rows[0]!.id;
      }
    }
  } finally {
    await pool.end();
  }
});

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel(/work email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  // The (app) layout renders the shell once the session resolves.
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

test.describe.serial('work-management lifecycle', () => {
  test.skip(!MIGRATE_URL, 'needs DATABASE_URL_MIGRATE to seed the orgs and users');

  test('LOGIN → SELECT ORG: admin A signs in and the session is org-scoped', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    await expect(page).toHaveURL(/\/$/);

    // SELECT ORG: the app has no org-switcher UI — the session is scoped to the
    // person's org via their primary engagement. Prove the scoping functionally:
    // org A's project list is reachable and (see the IDOR block) org B's data
    // is invisible to this session.
    const res = await page.request.get('/api/work/projects');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; total: number };
    expect(body.total).toBe(0);
  });

  test('empty state: /work shows "No projects yet" for the fresh org', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    await page.goto('/work');
    await expect(page.getByText('No projects yet')).toBeVisible();
  });

  test('CREATE PROJECT: admin creates a project through the UI', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    await page.goto('/work');
    await page.getByRole('link', { name: /new project/i }).click();
    await expect(page).toHaveURL(/\/work\/projects\/new/);

    const projectName = `Apollo Launch ${RUN}`;
    await page.getByLabel(/name/i).fill(projectName);
    await page.getByLabel(/description/i).fill('E2E work-management lifecycle project');
    await page.getByRole('button', { name: /create project/i }).click();

    // Lands on the new project's kanban board.
    await expect(page).toHaveURL(/\/work\/projects\/[0-9a-f-]{36}/);
    await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
    projectId = page.url().match(/\/work\/projects\/([0-9a-f-]{36})/)![1]!;
    expect(projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // The API agrees the project exists.
    const res = await page.request.get(`/api/work/projects/${projectId}`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { name: string; description: string };
    expect(body.name).toBe(projectName);
  });

  test('ADD MEMBERS: admin adds member A to the project', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);

    const res = await page.request.post(`/api/work/projects/${projectId}/members`, {
      data: { personId: memberAPersonId, roleInProject: 'member' },
    });
    expect(res.status()).toBe(201);

    const list = await page.request.get(`/api/work/projects/${projectId}/members`);
    expect(list.status()).toBe(200);
    const members = (await list.json()) as { personId: string; roleInProject: string }[];
    const member = members.find((m) => m.personId === memberAPersonId);
    expect(member).toBeDefined();
    expect(member!.roleInProject).toBe('member');
  });

  test('CREATE TASK: admin creates a task in the project', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);

    const res = await page.request.post('/api/work/tasks', {
      data: {
        title: `Design landing page ${RUN}`,
        projectId,
        description: 'Homepage hero and pricing section',
        priority: 'high',
      },
    });
    expect(res.status()).toBe(201);
    const task = (await res.json()) as {
      id: string;
      title: string;
      status: string;
      priority: string;
      projectId: string;
    };
    expect(task.title).toBe(`Design landing page ${RUN}`);
    expect(task.status).toBe('todo');
    expect(task.priority).toBe('high');
    expect(task.projectId).toBe(projectId);
    taskId = task.id;
  });

  test('ASSIGN TASK: admin assigns the task to member A', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);

    const res = await page.request.patch(`/api/work/tasks/${taskId}`, {
      data: { assigneePersonId: memberAPersonId },
    });
    expect(res.status()).toBe(200);
    const task = (await res.json()) as { assigneePersonId: string | null };
    expect(task.assigneePersonId).toBe(memberAPersonId);

    // Unassigning with null is accepted too.
    const unassign = await page.request.patch(`/api/work/tasks/${taskId}`, {
      data: { assigneePersonId: null },
    });
    expect(unassign.status()).toBe(200);
    expect(
      ((await unassign.json()) as { assigneePersonId: string | null }).assigneePersonId,
    ).toBeNull();

    // Re-assign for the rest of the flow.
    const reassign = await page.request.patch(`/api/work/tasks/${taskId}`, {
      data: { assigneePersonId: memberAPersonId },
    });
    expect(reassign.status()).toBe(200);
  });

  test('CREATE SUBTASK: admin creates a subtask under the task', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);

    // Contract assumption: POST /api/work/tasks accepts { parentTaskId } and the
    // subtask inherits the parent's org/project (migration 0042 parent_task_id).
    const res = await page.request.post('/api/work/tasks', {
      data: {
        title: `Draft hero copy ${RUN}`,
        projectId,
        parentTaskId: taskId,
        priority: 'medium',
      },
    });
    if (res.status() === 400) {
      test.skip(
        true,
        'parentTaskId not yet accepted by POST /api/work/tasks (subtask API contract ' +
          'pending from the subtask engineer); DB parent_task_id, org/project ' +
          'inheritance and cycle guards already live in migration 0042.',
      );
    }
    expect(res.status()).toBe(201);
    const subtask = (await res.json()) as { id: string; projectId: string };
    expect(subtask.projectId).toBe(projectId);
    subtaskId = subtask.id;
  });

  test('UPDATE TASK: admin renames and reprioritises the task', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);

    const res = await page.request.patch(`/api/work/tasks/${taskId}`, {
      data: {
        title: `Design landing page v2 ${RUN}`,
        priority: 'urgent',
        description: 'Homepage hero, pricing section, and footer',
      },
    });
    expect(res.status()).toBe(200);
    const task = (await res.json()) as {
      title: string;
      priority: string;
      description: string;
    };
    expect(task.title).toBe(`Design landing page v2 ${RUN}`);
    expect(task.priority).toBe('urgent');
    expect(task.description).toContain('footer');
  });

  test('MOVE TASK (kanban): admin moves the card with the keyboard', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    await page.goto(`/work/projects/${projectId}`);

    // The card starts in the To do column.
    const card = page.getByRole('option', { name: new RegExp(`Design landing page v2 ${RUN}`) });
    await expect(card).toBeVisible();
    const todoColumn = page.getByRole('region', { name: 'Status column: To do' });
    await expect(
      todoColumn.getByRole('option', { name: new RegExp(`Design landing page v2 ${RUN}`) }),
    ).toBeVisible();

    // Focus the card and arrow it right into In progress (the board's documented
    // keyboard contract), then confirm the move persisted server-side.
    await card.focus();
    await page.keyboard.press('ArrowRight');
    const inProgressColumn = page.getByRole('region', { name: 'Status column: In progress' });
    await expect(
      inProgressColumn.getByRole('option', { name: new RegExp(`Design landing page v2 ${RUN}`) }),
    ).toBeVisible();

    const res = await page.request.get(`/api/work/tasks/${taskId}`);
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('in_progress');
  });

  test('COMPLETE TASK: admin moves the task to done via the API', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);

    const res = await page.request.post(`/api/work/tasks/${taskId}/move`, {
      data: { status: 'done' },
    });
    expect(res.status()).toBe(200);
    const move = (await res.json()) as {
      ok: boolean;
      taskId: string;
      fromStatus: string;
      toStatus: string;
    };
    expect(move.ok).toBe(true);
    expect(move.taskId).toBe(taskId);
    expect(move.fromStatus).toBe('in_progress');
    expect(move.toStatus).toBe('done');

    // Moving to the status the task is already in is a 200 no-op.
    const noop = await page.request.post(`/api/work/tasks/${taskId}/move`, {
      data: { status: 'done' },
    });
    expect(noop.status()).toBe(200);
  });

  test('VIEW PROJECT PROGRESS: done counts and the Done column reflect completion', async ({
    page,
  }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);

    // API progress: taskCount/openTaskCount on the project list row.
    const listRes = await page.request.get(`/api/work/projects?search=Apollo%20Launch`);
    expect(listRes.status()).toBe(200);
    const list = (await listRes.json()) as {
      rows: { id: string; taskCount: number; openTaskCount: number }[];
    };
    const row = list.rows.find((r) => r.id === projectId)!;
    expect(row.taskCount).toBeGreaterThanOrEqual(1);
    expect(row.openTaskCount).toBe(row.taskCount - 1); // exactly the completed task is done

    // UI progress: the completed card sits in the Done column.
    await page.goto(`/work/projects/${projectId}`);
    const doneColumn = page.getByRole('region', { name: 'Status column: Done' });
    await expect(
      doneColumn.getByRole('option', { name: new RegExp(`Design landing page v2 ${RUN}`) }),
    ).toBeVisible();
  });

  test('VERIFY AUDIT LOG: every lifecycle write left a SUCCESS trail entry', async () => {
    const pool = new Pool({ connectionString: MIGRATE_URL });
    try {
      const res = await pool.query<{ action: string; entity_type: string; result: string }>(
        `select action, entity_type, result
         from public.audit_logs
         where org_id = $1
           and entity_type in ('work_project', 'work_task', 'project_member')
         order by occurred_at`,
        [orgAId],
      );
      const actions = res.rows.map((r) => r.action);

      expect(actions).toContain('work_project.created');
      expect(actions).toContain('project_member.created');
      expect(actions.filter((a) => a === 'work_task.created').length).toBeGreaterThanOrEqual(1);
      // update (rename/reprioritise), assignment, and the two status moves.
      expect(actions.filter((a) => a === 'work_task.updated').length).toBeGreaterThanOrEqual(3);

      // Nothing failed or was denied on this trail.
      expect(res.rows.every((r) => r.result === 'SUCCESS')).toBe(true);

      // The seed writes for org B (no app.person_id) correctly produced NO
      // audit entries — the trail only records real user actions.
      const orgB = await pool.query(
        `select count(*)::int as n from public.audit_logs
         where org_id = $1 and entity_type in ('work_project', 'work_task')`,
        [orgBId],
      );
      expect(orgB.rows[0]!.n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  test('empty kanban: a brand-new project board renders empty columns', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const created = await page.request.post('/api/work/projects', {
      data: { name: `Empty Board ${RUN}` },
    });
    expect(created.status()).toBe(201);
    const id = ((await created.json()) as { id: string }).id;

    await page.goto(`/work/projects/${id}`);
    await expect(page.getByRole('heading', { name: `Empty Board ${RUN}` })).toBeVisible();
    for (const label of [
      'Status column: To do',
      'Status column: In progress',
      'Status column: Done',
    ]) {
      const column = page.getByRole('region', { name: label });
      await expect(column).toBeVisible();
      // Privileged viewers see the drop hint; viewers without tasks.edit see "No tasks".
      await expect(column.getByText(/no tasks|drop tasks here/i)).toBeVisible();
    }
  });
});

test.describe('tenant isolation (IDOR)', () => {
  test.skip(!MIGRATE_URL, 'needs DATABASE_URL_MIGRATE to seed the orgs and users');

  test("org A's list never contains org B's project", async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const res = await page.request.get('/api/work/projects?limit=100');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { rows: { id: string }[] };
    expect(body.rows.some((r) => r.id === orgBProjectId)).toBe(false);
  });

  test("org B's project is concealed as 404 for org A", async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const res = await page.request.get(`/api/work/projects/${orgBProjectId}`);
    expect(res.status()).toBe(404);
  });

  test("org B's task is concealed as 404 for org A", async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const res = await page.request.get(`/api/work/tasks/${orgBTaskId}`);
    expect(res.status()).toBe(404);
  });

  test("org A cannot patch org B's project", async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const res = await page.request.patch(`/api/work/projects/${orgBProjectId}`, {
      data: { name: 'hijacked' },
    });
    expect([400, 403, 404]).toContain(res.status());
    expect(res.status()).not.toBe(200);
  });

  test("org A cannot move org B's task", async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const res = await page.request.post(`/api/work/tasks/${orgBTaskId}/move`, {
      data: { status: 'done' },
    });
    expect([400, 403, 404]).toContain(res.status());
    expect(res.status()).not.toBe(200);
  });

  test("org A cannot add members to org B's project", async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const res = await page.request.post(`/api/work/projects/${orgBProjectId}/members`, {
      data: { personId: memberAPersonId, roleInProject: 'member' },
    });
    expect([400, 403, 404]).toContain(res.status());
    expect(res.status()).not.toBe(201);
  });

  test("org A's UI shows an error state for org B's project page", async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    await page.goto(`/work/projects/${orgBProjectId}`);
    await expect(page.getByText('Could not load project')).toBeVisible();
  });

  test("org A's UI shows an error state for org B's task page", async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    await page.goto(`/work/tasks/${orgBTaskId}`);
    await expect(page.getByText('Could not load task')).toBeVisible();
  });
});

test.describe.serial('task list: search, filter, sort, pagination', () => {
  test.skip(!MIGRATE_URL, 'needs DATABASE_URL_MIGRATE to seed the orgs and users');

  const PREFIX = `probe-${RUN}`;
  const titles = [`${PREFIX}-alpha-1`, `${PREFIX}-alpha-2`, `${PREFIX}-beta-1`];

  test('seeds probe tasks with varied priorities and statuses', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    // A dedicated project keeps the probe set addressable.
    const proj = await page.request.post('/api/work/projects', {
      data: { name: `Probe Project ${RUN}` },
    });
    expect(proj.status()).toBe(201);
    const probeProjectId = ((await proj.json()) as { id: string }).id;

    const created: string[] = [];
    for (const [i, title] of titles.entries()) {
      const res = await page.request.post('/api/work/tasks', {
        data: {
          title,
          projectId: probeProjectId,
          priority: (['low', 'urgent', 'medium'] as const)[i],
        },
      });
      expect(res.status()).toBe(201);
      created.push(((await res.json()) as { id: string }).id);
    }
    // One probe task is completed, so status filters have something to find.
    const done = await page.request.post(`/api/work/tasks/${created[2]}/move`, {
      data: { status: 'done' },
    });
    expect(done.status()).toBe(200);
  });

  async function probeList(page: Page, qs: string) {
    const res = await page.request.get(`/api/work/tasks?${qs}`);
    expect(res.status()).toBe(200);
    return (await res.json()) as {
      rows: { title: string; status: string; priority: string }[];
      total: number;
    };
  }

  test('search matches the title prefix', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const body = await probeList(page, `search=${PREFIX}-alpha`);
    expect(body.total).toBe(2);
    expect(body.rows.map((r) => r.title).sort()).toEqual([titles[0], titles[1]].sort());
  });

  test('status filter narrows to done', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const body = await probeList(page, `search=${PREFIX}&status=done`);
    expect(body.total).toBe(1);
    expect(body.rows[0]!.title).toBe(titles[2]);
  });

  test('priority filter narrows to urgent', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const body = await probeList(page, `search=${PREFIX}&priority=urgent`);
    expect(body.total).toBe(1);
    expect(body.rows[0]!.title).toBe(titles[1]);
  });

  test('sort orders titles descending', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const body = await probeList(page, `search=${PREFIX}&sort=title&order=desc`);
    expect(body.total).toBe(3);
    const got = body.rows.map((r) => r.title);
    expect(got).toEqual([...got].sort().reverse());
  });

  test('pagination pages through the probe set without overlap', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const p1 = await probeList(page, `search=${PREFIX}&limit=2&offset=0&sort=title&order=asc`);
    const p2 = await probeList(page, `search=${PREFIX}&limit=2&offset=2&sort=title&order=asc`);
    expect(p1.total).toBe(3);
    expect(p1.rows).toHaveLength(2);
    expect(p2.rows).toHaveLength(1);
    const ids1 = p1.rows.map((r) => r.title);
    const ids2 = p2.rows.map((r) => r.title);
    expect(ids1.some((t) => ids2.includes(t))).toBe(false);
    expect([...ids1, ...ids2].sort()).toEqual([...titles].sort());
  });

  test('invalid sort field is a 400, never SQL', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const res = await page.request.get('/api/work/tasks?sort=;DROP%20TABLE%20work_tasks;--');
    expect(res.status()).toBe(400);
  });

  test('limit above the cap is a 400', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const res = await page.request.get('/api/work/tasks?limit=101');
    expect(res.status()).toBe(400);
  });
});

test.describe('error states', () => {
  test.skip(!MIGRATE_URL, 'needs DATABASE_URL_MIGRATE to seed the orgs and users');

  test('unauthenticated project creation is refused', async ({ request }) => {
    const res = await request.post('/api/work/projects', { data: { name: 'nope' } });
    expect([401, 403]).toContain(res.status());
    expect(res.status()).not.toBe(201);
  });

  test('unauthenticated task listing is refused', async ({ request }) => {
    const res = await request.get('/api/work/tasks');
    expect([401, 403]).toContain(res.status());
  });

  test('user without work grants (FINANCE) cannot create projects', async ({ page }) => {
    await signIn(page, FINANCE_A_EMAIL, PASSWORD);
    const res = await page.request.post('/api/work/projects', { data: { name: 'nope' } });
    expect(res.status()).toBe(403);
  });

  test('user without work grants (FINANCE) cannot list projects', async ({ page }) => {
    await signIn(page, FINANCE_A_EMAIL, PASSWORD);
    const res = await page.request.get('/api/work/projects');
    expect(res.status()).toBe(403);
  });

  test('empty project name is a 400', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const res = await page.request.post('/api/work/projects', { data: { name: '   ' } });
    expect(res.status()).toBe(400);
  });

  test('missing project name is a 400', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const res = await page.request.post('/api/work/projects', { data: {} });
    expect(res.status()).toBe(400);
  });

  test('empty task title is a 400', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const res = await page.request.post('/api/work/tasks', { data: { title: '' } });
    expect(res.status()).toBe(400);
  });

  test('bogus move status is a 400', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const created = await page.request.post('/api/work/tasks', {
      data: { title: `Move target ${RUN}` },
    });
    expect(created.status()).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    const res = await page.request.post(`/api/work/tasks/${id}/move`, {
      data: { status: 'shipped' },
    });
    expect(res.status()).toBe(400);
  });

  test('malformed project id is a 400, not a 500', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const res = await page.request.get('/api/work/projects/not-a-uuid');
    expect(res.status()).toBe(400);
  });

  test('unknown task id is a 404', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    const res = await page.request.get('/api/work/tasks/00000000-0000-0000-0000-000000000000');
    expect(res.status()).toBe(404);
  });

  test('cross-org assignee is rejected', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    // Admin B's person belongs to org B; assigning an org A task to them must fail.
    const pool = new Pool({ connectionString: MIGRATE_URL });
    let adminBPersonId = '';
    try {
      const r = await pool.query<{ id: string }>(
        `select id from public.people where org_id = $1 and work_email = $2::citext`,
        [orgBId, ADMIN_B_EMAIL],
      );
      adminBPersonId = r.rows[0]!.id;
    } finally {
      await pool.end();
    }
    const created = await page.request.post('/api/work/tasks', {
      data: { title: `Assignee guard ${RUN}` },
    });
    expect(created.status()).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    const res = await page.request.patch(`/api/work/tasks/${id}`, {
      data: { assigneePersonId: adminBPersonId },
    });
    expect([400, 403, 404]).toContain(res.status());
    expect(res.status()).not.toBe(200);
  });

  test('UI: malformed project id renders the error state', async ({ page }) => {
    await signIn(page, ADMIN_A_EMAIL, PASSWORD);
    await page.goto('/work/projects/not-a-uuid');
    await expect(page.getByText('Could not load project')).toBeVisible();
  });
});

test.describe('empty states', () => {
  test.skip(!MIGRATE_URL, 'needs DATABASE_URL_MIGRATE to seed the orgs and users');

  test('/work/my-tasks is empty for a user with no assignments', async ({ page }) => {
    await signIn(page, FINANCE_A_EMAIL, PASSWORD);
    await page.goto('/work/my-tasks');
    await expect(page.getByText('Nothing assigned to you')).toBeVisible();
  });
});
