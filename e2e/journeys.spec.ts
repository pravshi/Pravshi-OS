import { expect, test, type Page } from '@playwright/test';
import { Pool } from '@neondatabase/serverless';
import { randomBytes } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';

/**
 * Role-based journey — the invitation lifecycle through the real UI and API.
 *
 *   admin seeds (SQL) → admin signs in → admin issues an invitation (API) →
 *   invitee accepts (UI) → invitee signs in → invitee sees the app →
 *   invitee (no admin rights) is refused /admin/* with /access-denied.
 *
 * The admin is seeded directly as app_owner (DATABASE_URL_MIGRATE): a fresh org gets
 * its fourteen system roles from the trigger, and the SUPER_ADMIN grant rides the
 * genesis branch (no roles.manage holder exists yet and the seeder is not app_user).
 * The password hash is a genuine Better Auth scrypt hash, so the sign-ins below are
 * real authentications, not session forgeries.
 *
 * Skipped when DATABASE_URL_MIGRATE is not set: without a seeder there is no admin
 * and the journey cannot start. CI always sets it (the ephemeral Neon branch).
 */

const MIGRATE_URL = process.env.DATABASE_URL_MIGRATE;
const RUN = randomBytes(4).toString('hex');

// people.code must satisfy the people_code_format check
// (^[A-Z]{2,8}-[0-9]{4}-[0-9]{4,}$); hex RUN segments are rejected.
const PERSON_CODE = `EMP-2026-${Date.now().toString().slice(-10).padStart(10, '0')}`;

const ADMIN_EMAIL = `journey.admin.${RUN}@example.test`;
const ADMIN_PASSWORD = `Journey-Admin-${RUN}!`;
const INVITEE_EMAIL = `journey.invitee.${RUN}@example.test`;
const INVITEE_PASSWORD = `Journey-Invitee-${RUN}!`;

test.describe('invitation journey', () => {
  test.skip(!MIGRATE_URL, 'needs DATABASE_URL_MIGRATE to seed the admin org');

  let orgId = '';
  let deptId = '';
  let employeeRoleId = '';
  let acceptUrl = '';

  test.beforeAll(async () => {
    const owner = new Pool({ connectionString: MIGRATE_URL });
    try {
      const org = await owner.query<{ id: string }>(
        `insert into public.organizations (name, slug) values ($1, $2) returning id`,
        [`Journey ${RUN}`, `journey-${RUN}`],
      );
      orgId = org.rows[0]!.id;

      const dept = await owner.query<{ id: string }>(
        `insert into public.departments (org_id, code, name) values ($1, 'ENG', 'Engineering') returning id`,
        [orgId],
      );
      deptId = dept.rows[0]!.id;

      const roles = await owner.query<{ id: string; key: string }>(
        `select id, key from public.roles where org_id = $1 and key = any('{SUPER_ADMIN,EMPLOYEE}')`,
        [orgId],
      );
      const superAdminRole = roles.rows.find((r) => r.key === 'SUPER_ADMIN')!.id;
      employeeRoleId = roles.rows.find((r) => r.key === 'EMPLOYEE')!.id;

      const passwordHash = await hashPassword(ADMIN_PASSWORD);
      const authUser = await owner.query<{ id: string }>(
        `insert into auth.auth_users (email, email_verified, name) values ($1::citext, true, 'Journey Admin') returning id`,
        [ADMIN_EMAIL],
      );
      const authUserId = authUser.rows[0]!.id;
      await owner.query(
        `insert into auth.auth_accounts (user_id, account_id, provider_id, password)
         values ($1, $2::citext, 'credential', $3)`,
        [authUserId, ADMIN_EMAIL, passwordHash],
      );

      const person = await owner.query<{ id: string }>(
        `insert into public.people
           (org_id, code, full_legal_name, work_email, person_status, auth_user_id)
         values ($1, $2, 'Journey Admin', $3::citext, 'ACTIVE', $4) returning id`,
        [orgId, PERSON_CODE, ADMIN_EMAIL, authUserId],
      );
      const personId = person.rows[0]!.id;

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
    } finally {
      await owner.end();
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

  test('admin signs in and issues an invitation', async ({ page }) => {
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
    // Navigate on the test server's own origin: acceptUrl is built from the app's
    // APP_URL, which need not match the Playwright webServer port.
    acceptUrl = `/invite#token=${token}`;
  });

  test('invitee accepts the invitation through the UI', async ({ page }) => {
    expect(acceptUrl).not.toBe('');
    await page.goto(acceptUrl);
    await expect(page.getByRole('heading', { name: /accept your invitation/i })).toBeVisible();
    await page.getByLabel(/full legal name/i).fill('Journey Invitee');
    await page.getByLabel(/^password$/i).fill(INVITEE_PASSWORD);
    await page.getByLabel(/confirm password/i).fill(INVITEE_PASSWORD);
    await page.getByRole('button', { name: /accept|create/i }).click();
    await expect(page.getByRole('heading', { name: /welcome aboard/i })).toBeVisible();
  });

  test('invitee signs in and sees the app', async ({ page }) => {
    await signIn(page, INVITEE_EMAIL, INVITEE_PASSWORD);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: /^home$/i })).toBeVisible();
  });

  test('invitee without admin rights is refused /admin/*', async ({ page }) => {
    await signIn(page, INVITEE_EMAIL, INVITEE_PASSWORD);
    await page.goto('/admin/users');
    await expect(page).toHaveURL(/\/access-denied/);
    await expect(page.getByRole('heading', { name: /access denied/i })).toBeVisible();
  });

  test('admin still reaches /admin/users', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { name: /^users$/i })).toBeVisible();
  });
});
