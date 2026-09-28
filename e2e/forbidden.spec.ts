import { expect, test } from '@playwright/test';

/**
 * Forbidden URLs — what an unauthenticated visitor meets at the application boundary.
 *
 * No database seeding is needed: every assertion is about the routing/authorization
 * layer, not about data. Authenticated pages redirect to /login; the API answers 401
 * without a session. The public auth pages still render.
 *
 * These run against the production build (`pnpm build && pnpm e2e`), the same shape
 * CI deploys, so a dev-mode quirk cannot hide a broken redirect.
 */

test.describe('unauthenticated page access', () => {
  for (const path of [
    '/',
    '/admin/users',
    '/admin/roles',
    '/admin/departments',
    '/admin/audit-logs',
    '/me/security',
  ]) {
    test(`${path} redirects to /login`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login(\?|$)/);
    });
  }

  test('/login renders for a visitor', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /sign in|log in/i })).toBeVisible();
  });

  test('/access-denied renders for a visitor', async ({ page }) => {
    const res = await page.goto('/access-denied');
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: /access denied/i })).toBeVisible();
  });

  test('/invite with no token explains the link is invalid', async ({ page }) => {
    await page.goto('/invite');
    await expect(
      page.getByText(/invitation link is invalid, expired, or already used/i),
    ).toBeVisible();
  });
});

test.describe('unauthenticated API access', () => {
  test('POST /api/invitations without a session is refused', async ({ request }) => {
    const res = await request.post('/api/invitations', {
      data: { email: 'nobody@example.test', roleIds: [] },
    });
    expect([401, 403]).toContain(res.status());
    // Never a success-shaped body for an unauthenticated caller.
    expect(res.status()).not.toBe(201);
  });

  test('POST /api/invitations/accept with a garbage token is refused', async ({ request }) => {
    const res = await request.post('/api/invitations/accept', {
      data: { token: 'deadbeef', fullName: 'Nobody', password: 'WrongPassword123!' },
    });
    expect([400, 401, 403, 404]).toContain(res.status());
  });

  test('GET /api/bootstrap/complete is not a thing', async ({ request }) => {
    const res = await request.get('/api/bootstrap/complete');
    expect([404, 405]).toContain(res.status());
  });
});
