import { expect, test, type Page } from '@playwright/test';
import { Pool } from '@neondatabase/serverless';
import { randomBytes } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';

/**
 * Workflow Engine end-to-end (Phase 5).
 *
 * Covers the flagship lifecycle through the real UI and API:
 *
 *   LIST (empty) → NEW BUILDER (deal.stage_changed + won filter + create_task)
 *   → SAVE (DRAFT) → DETAIL → ACTIVATE (ACTIVE) → RUN NOW → EXECUTION (SUCCEEDED)
 *   → STEP ROW in run detail → DEFERRED-TRIGGER ACTIVATION REJECTED (400)
 *
 * plus the 404 concealment for invisible workflows.
 *
 * ── Contracts under test ────────────────────────────────────────────────────
 * API (src/app/api/workflows/*):
 *   GET  /api/workflows                               → { rows, total, limit, offset }
 *   POST /api/workflows            { name, trigger, conditions?, actions? } → 201
 *   GET  /api/workflows/[id]                          → workflow | 404
 *   POST /api/workflows/[id]/activate                 → 200 ACTIVE | 400 deferred trigger
 *   POST /api/workflows/[id]/execute                  → 202 { executionId, status }
 *   GET  /api/workflows/[id]/executions               → { rows, total, limit, offset }
 *   GET  /api/workflow-executions/[id]                 → execution + steps[]
 * UI (src/app/(app)/workflows/*):
 *   /workflows              heading "Automations"; empty state "No workflows yet";
 *                           "New workflow" → /workflows/new
 *   /workflows/new          builder: "Workflow name *"; trigger select aria
 *                           "Trigger event" (default deal.stage_changed); won
 *                           filter checkbox "the deal is won"; "+ Add action";
 *                           "Task title"; submit "Create workflow" → detail page
 *   /workflows/[id]         status badge "Draft"/"Active"; "Activate" control;
 *                           "Run now" (disabled until ACTIVE); execution history
 *                           table ("No runs yet" empty state); step detail dialog
 * Status labels: Draft / Active / Paused / Archived; run states: Succeeded /
 *   Failed / Pending / Running / Cancelled.
 *
 * ── Assumptions ─────────────────────────────────────────────────────────────
 * 1. Migration 0044 (workflow engine DDL + permission seeds) is applied to the
 *    test database; seed_system_roles grants SUPER_ADMIN every permission, so
 *    one admin account exercises the whole surface.
 * 2. Deferred trigger types (scheduled / webhook / task.overdue) can be saved
 *    as DRAFT via the API (the UI select shows them disabled by design) but
 *    can never be ACTIVATEd: POST …/activate answers 400 INVALID_REQUEST and
 *    the UI surfaces a toast while the badge stays "Draft".
 * 3. A manual run of a deal-triggered workflow executes its actions with a
 *    `manual` event — no deal fixture is needed to prove the action path.
 *
 * ── Setup ───────────────────────────────────────────────────────────────────
 * Needs DATABASE_URL_MIGRATE (the app_owner URL, used for seeding — CI sets it
 * to the ephemeral Neon branch). Without it the whole file skips. Run:
 *   pnpm build && pnpm e2e e2e/workflows.spec.ts
 * (the playwright webServer boots `next start` on :3100 against the app's
 * normal DATABASE_URL; seed through a disposable Neon branch, never
 * production).
 */

const MIGRATE_URL = process.env.DATABASE_URL_MIGRATE;
const RUN = randomBytes(4).toString('hex');
const STAMP = Date.now().toString().slice(-10).padStart(10, '0');

// people.code must satisfy people_code_format (^[A-Z]{2,8}-[0-9]{4}-[0-9]{4,}$).
const personCode = (tag: string) => `WF-${tag}-${STAMP}`;

const ADMIN_EMAIL = `wf.admin.${RUN}@example.test`;
const PASSWORD = `Work-E2E-${RUN}!`;

async function seedPerson(
  pool: Pool,
  opts: { orgId: string; deptId: string; email: string; password: string; fullName: string },
): Promise<string> {
  const role = await pool.query<{ id: string }>(
    `select id from public.roles where org_id = $1 and key = $2`,
    [opts.orgId, 'SUPER_ADMIN'],
  );
  const roleId = role.rows[0]?.id;
  if (!roleId) throw new Error(`SUPER_ADMIN role not seeded for org ${opts.orgId}`);

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
    [opts.orgId, personCode('2026'), opts.fullName, opts.email, authUserId],
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
  test.skip(!MIGRATE_URL, 'needs DATABASE_URL_MIGRATE to seed the org and admin user');
  const pool = new Pool({ connectionString: MIGRATE_URL });
  try {
    const org = await pool.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1, $2) returning id`,
      [`Workflow E2E ${RUN}`, `wf-e2e-${RUN}`],
    );
    const orgId = org.rows[0]!.id;
    const dept = await pool.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1, 'OPS', 'Operations') returning id`,
      [orgId],
    );
    await seedPerson(pool, {
      orgId,
      deptId: dept.rows[0]!.id,
      email: ADMIN_EMAIL,
      password: PASSWORD,
      fullName: 'Workflow E2E Admin',
    });
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

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

test.describe.serial('workflow engine lifecycle', () => {
  test.skip(!MIGRATE_URL, 'needs DATABASE_URL_MIGRATE to seed the org and admin user');

  let workflowId = '';

  test('(a) list page renders, empty state, and the API agrees', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, PASSWORD);

    const res = await page.request.get('/api/workflows');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; total: number };
    expect(body.total).toBe(0);

    await page.goto('/workflows');
    await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
    await expect(page.getByText('No workflows yet')).toBeVisible();
    await expect(page.getByRole('link', { name: /new workflow/i }).first()).toBeVisible();
  });

  test('(b) builder: deal.stage_changed + won filter + create_task saves as DRAFT', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, PASSWORD);
    await page.goto('/workflows');
    await page
      .getByRole('link', { name: /new workflow/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/workflows\/new$/);

    const name = `Won deal → onboarding ${RUN}`;
    await page.getByLabel(/workflow name/i).fill(name);

    // WHEN: default trigger is deal.stage_changed; narrow to won deals.
    await expect(page.getByLabel(/trigger event/i)).toHaveValue('deal.stage_changed');
    await page.getByLabel(/the deal is won/i).check();

    // THEN: one create_task step.
    await page.getByRole('button', { name: /add action/i }).click();
    await expect(page.getByLabel(/action type for step 1/i)).toHaveValue('create_task');
    await page.getByLabel(/task title/i).fill(`Onboard the new client ${RUN}`);

    await page.getByRole('button', { name: /^create workflow$/i }).click();

    // Lands on the detail page for the new workflow.
    await expect(page).toHaveURL(new RegExp(`/workflows/${UUID_RE}$`));
    workflowId = page.url().match(/\/workflows\/([0-9a-f-]{36})/)![1]!;
    await expect(page.getByRole('heading', { name })).toBeVisible();
    // Saves as DRAFT.
    await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();

    // The API agrees: DRAFT with the won filter recorded.
    const res = await page.request.get(`/api/workflows/${workflowId}`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      status: string;
      trigger: { type: string; filters?: Record<string, unknown> };
    };
    expect(body.status).toBe('DRAFT');
    expect(body.trigger.type).toBe('deal.stage_changed');
    expect(body.trigger.filters?.isWon).toBe(true);
  });

  test('(c) activate → status badge ACTIVE', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, PASSWORD);
    await page.goto(`/workflows/${workflowId}`);

    await page.getByRole('button', { name: /^activate$/i }).click();
    await expect(page.getByText('Workflow activated.')).toBeVisible();
    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Draft', { exact: true })).toHaveCount(0);
  });

  test('(d) manual Run now → execution in history with SUCCEEDED', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, PASSWORD);
    await page.goto(`/workflows/${workflowId}`);
    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();

    // The history starts empty.
    await expect(page.getByText('No runs yet')).toBeVisible();

    await page.getByRole('button', { name: /^run now$/i }).click();
    await expect(page.getByText('Run started.')).toBeVisible();

    // The run executes synchronously in the request (D1); refresh makes the
    // server-rendered history pick it up.
    await page.reload();
    await expect(page.getByText('No runs yet')).toHaveCount(0);
    const historyRow = page.locator('tr', { hasText: 'manual' }).first();
    await expect(historyRow).toBeVisible();
    await expect(historyRow.getByText('Succeeded', { exact: true })).toBeVisible();
  });

  test('(e) execution detail shows the step row', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, PASSWORD);
    await page.goto(`/workflows/${workflowId}`);
    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();

    // Open the run via the history table row → dialog.
    await page.locator('tr', { hasText: 'manual' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Run detail' })).toBeVisible();
    await expect(dialog.getByText('Create task')).toBeVisible();
    await expect(dialog.getByText('#1')).toBeVisible();
    await expect(dialog.getByText('Succeeded', { exact: true }).first()).toBeVisible();
    await expect(dialog.getByText('Steps (1)')).toBeVisible();

    // The API-level execution detail carries the same steps[].
    const listRes = await page.request.get(`/api/workflows/${workflowId}/executions`);
    expect(listRes.status()).toBe(200);
    const list = (await listRes.json()) as { rows: { id: string; status: string }[] };
    const executionId = list.rows[0]!.id;
    const detailRes = await page.request.get(`/api/workflow-executions/${executionId}`);
    expect(detailRes.status()).toBe(200);
    const detail = (await detailRes.json()) as {
      status: string;
      steps: { actionType: string; status: string }[];
    };
    expect(detail.status).toBe('SUCCEEDED');
    expect(detail.steps).toHaveLength(1);
    expect(detail.steps[0]!.actionType).toBe('create_task');
    expect(detail.steps[0]!.status).toBe('SUCCEEDED');
  });

  test('(f) activating a deferred-trigger workflow fails with 400', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, PASSWORD);

    // A scheduled-trigger workflow can be saved as DRAFT through the API (the
    // builder's trigger select shows deferred types disabled by design).
    const createRes = await page.request.post('/api/workflows', {
      data: {
        name: `Daily digest ${RUN}`,
        trigger: { type: 'scheduled' },
        conditions: [],
        actions: [],
      },
    });
    expect(createRes.status()).toBe(201);
    const created = (await createRes.json()) as { id: string; status: string };
    expect(created.status).toBe('DRAFT');

    // The API refuses activation: 400 INVALID_REQUEST.
    const apiActivate = await page.request.post(`/api/workflows/${created.id}/activate`);
    expect(apiActivate.status()).toBe(400);

    // And the UI's Activate control surfaces the failure while the badge
    // stays Draft.
    await page.goto(`/workflows/${created.id}`);
    await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: /^activate$/i }).click();
    await expect(page.getByText(/could not activate/i)).toBeVisible();
    await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Active', { exact: true })).toHaveCount(0);
  });

  test('invisible workflow is concealed as 404', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, PASSWORD);
    const missing = '00000000-0000-0000-0000-000000000000';
    const res = await page.request.get(`/api/workflows/${missing}`);
    expect(res.status()).toBe(404);
  });
});
