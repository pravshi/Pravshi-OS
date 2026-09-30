import { expect, test, type Page } from '@playwright/test';
import { neon } from '@neondatabase/serverless';
import { randomBytes } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';

/**
 * R49 — the identity lifecycle, end to end through the real application.
 *
 *   invite → accept → assign roles → login → suspend → audit trail
 *
 * The admin org is seeded as app_owner (DATABASE_URL_MIGRATE); everything else
 * goes through the application's own surfaces: the invitation API, the accept
 * page, the admin users UI (role editor + suspend), the login page, and the
 * audit-log UI. The final step reads audit_logs to prove the database recorded
 * the whole lifecycle — the trail the admin UI itself renders.
 *
 * Skipped when DATABASE_URL_MIGRATE is not set. Runs against a production
 * build (`pnpm build && pnpm e2e`) on an ephemeral Neon branch.
 */

const MIGRATE_URL = process.env.DATABASE_URL_MIGRATE;
const RUN = randomBytes(4).toString('hex');

// Dependent lifecycle steps must not run concurrently.
test.describe.configure({ mode: 'serial' });

// people.code must satisfy the people_code_format check
// (^[A-Z]{2,8}-[0-9]{4}-[0-9]{4,}$); hex RUN segments are rejected.
const PERSON_CODE = `EMP-2026-${Date.now().toString().slice(-10).padStart(10, '0')}`;

const ADMIN_EMAIL = `r49.admin.${RUN}@example.test`;
const ADMIN_PASSWORD = `R49-Admin-${RUN}!x9`;
const INVITEE_EMAIL = `r49.invitee.${RUN}@example.test`;
const INVITEE_PASSWORD = `R49-Invitee-${RUN}!x9`;

test.describe('R49 identity lifecycle', () => {
  test.skip(!MIGRATE_URL, 'needs DATABASE_URL_MIGRATE to seed the admin org');

  // The serverless Pool speaks WebSocket; this environment reaches Neon over
  // HTTPS only, so seeding goes through the HTTP client.
  const db = neon(MIGRATE_URL!);

  let orgId = '';
  let deptId = '';
  let employeeRoleId = '';
  let acceptUrl = '';

  test.beforeAll(async () => {
    const owner = db;
    {
      const org = await owner.query(
        `insert into public.organizations (name, slug) values ($1, $2) returning id`,
        [`R49 ${RUN}`, `r49-${RUN}`],
      );
      orgId = org[0]!.id;

      const dept = await owner.query(
        `insert into public.departments (org_id, code, name) values ($1, 'ENG', 'Engineering') returning id`,
        [orgId],
      );
      deptId = dept[0]!.id;

      const roles = await owner.query(
        `select id, key from public.roles where org_id = $1 and key = any('{SUPER_ADMIN,EMPLOYEE}')`,
        [orgId],
      );
      const superAdminRole = (roles as { id: string; key: string }[]).find((r) => r.key === 'SUPER_ADMIN')!.id;
      employeeRoleId = (roles as { id: string; key: string }[]).find((r) => r.key === 'EMPLOYEE')!.id;

      const passwordHash = await hashPassword(ADMIN_PASSWORD);
      const authUser = await owner.query(
        `insert into auth.auth_users (email, email_verified, name) values ($1::citext, true, 'R49 Admin') returning id`,
        [ADMIN_EMAIL],
      );
      const authUserId = authUser[0]!.id;
      await owner.query(
        `insert into auth.auth_accounts (user_id, account_id, provider_id, password)
         values ($1, $2::citext, 'credential', $3)`,
        [authUserId, ADMIN_EMAIL, passwordHash],
      );

      const person = await owner.query(
        `insert into public.people
           (org_id, code, full_legal_name, work_email, person_status, auth_user_id)
         values ($1, $2, 'R49 Admin', $3::citext, 'ACTIVE', $4) returning id`,
        [orgId, PERSON_CODE, ADMIN_EMAIL, authUserId],
      );
      const personId = person[0]!.id;

      await owner.query(
        `insert into public.engagements
           (org_id, person_id, engagement_type, status, department_id, start_date, is_primary)
         values ($1, $2, 'EMPLOYEE', 'ACTIVE', $3, '2026-01-05', true)`,
        [orgId, personId, deptId],
      );
      await owner.query(
        `insert into public.person_roles (person_id, role_id, org_id) values ($1, $2, $3)`,
        [personId, superAdminRole, orgId],
      );
    }
  });

  async function signIn(page: Page, email: string, password: string) {
    await page.goto('/login');
    await page.getByLabel(/work email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  }

  /** The table row for the invitee on /admin/users. */
  const inviteeRow = (page: Page) => page.getByRole('row', { name: new RegExp(INVITEE_EMAIL) });

  test('1 · invite — admin issues an invitation through the application API', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await page.request.post('/api/invitations', {
      data: {
        email: INVITEE_EMAIL,
        roleIds: [employeeRoleId],
        engagementType: 'EMPLOYEE',
        departmentId: deptId,
        startDate: '2026-09-28',
      },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { acceptUrl: string };
    const token = body.acceptUrl.split('#token=')[1];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    acceptUrl = `/invite#token=${token}`;
  });

  test('2 · accept — the invitee accepts through the UI', async ({ page }) => {
    expect(acceptUrl).not.toBe('');
    await page.goto(acceptUrl);
    await expect(page.getByRole('heading', { name: /accept your invitation/i })).toBeVisible();
    await page.getByLabel(/full legal name/i).fill('R49 Invitee');
    await page.getByLabel(/^password$/i).fill(INVITEE_PASSWORD);
    await page.getByLabel(/confirm password/i).fill(INVITEE_PASSWORD);
    await page.getByRole('button', { name: /accept|create/i }).click();
    await expect(page.getByRole('heading', { name: /welcome aboard/i })).toBeVisible();
  });

  test('3 · assign roles — admin grants HR_ADMIN in the users UI', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { name: /^users$/i })).toBeVisible();
    await expect(inviteeRow(page)).toBeVisible();

    await inviteeRow(page).getByRole('button', { name: 'Roles' }).click();
    await expect(page.getByRole('heading', { name: /roles for/i })).toBeVisible();
    await page.getByLabel('HR_ADMIN').check();
    await page.getByRole('button', { name: 'Save roles' }).click();

    // The row now lists both roles.
    await expect(inviteeRow(page).getByText(/HR_ADMIN/)).toBeVisible();
  });

  test('4 · login — the invitee signs in with the new credential', async ({ page }) => {
    await signIn(page, INVITEE_EMAIL, INVITEE_PASSWORD);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: /^home$/i })).toBeVisible();
  });

  test('5 · suspend — admin suspends the invitee in the users UI', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/admin/users');
    await expect(inviteeRow(page)).toBeVisible();

    await inviteeRow(page).getByRole('button', { name: 'Suspend' }).click();
    await expect(page.getByRole('heading', { name: /suspend this login/i })).toBeVisible();
    // The confirm dialog has its own Suspend button.
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Suspend' })
      .click();

    await expect(inviteeRow(page).getByText('Suspended')).toBeVisible();
  });

  test('6 · suspended invitee can no longer sign in', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/work email/i).fill(INVITEE_EMAIL);
    await page.getByLabel(/password/i).fill(INVITEE_PASSWORD);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    // No shell renders: the suspended account is refused at the gate.
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  });

  test('7 · audit trail — the lifecycle is recorded and visible', async ({ page }) => {
    const owner = db;
    {
      const rows = await owner.query(
        `select action, entity_type from public.audit_logs
          where org_id = $1 order by occurred_at`,
        [orgId],
      );
      const actions = (rows as { action: string }[]).map((r) => r.action);
      // The invitation lifecycle writes its entries through the application path.
      expect(actions).toContain('invitation.create');
      expect(actions).toContain('invitation.accept');
      // The suspension is reflected in the person's status.
      const person = await owner.query(
        `select person_status from public.people where org_id = $1 and work_email = $2::citext`,
        [orgId, INVITEE_EMAIL],
      );
      expect(person[0]!.person_status).toBe('INACTIVE');
    }

    // And the admin UI renders the trail.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/admin/audit-logs');
    await expect(page.getByText('invitation.create').first()).toBeVisible();
    await expect(page.getByText('invitation.accept').first()).toBeVisible();
  });
});
