import { expect, test } from '@playwright/test';

test('the shell renders and the theme toggles', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByText('PRAVSHI OS')).toBeVisible();

  await page.getByRole('button', { name: /theme/i }).click();
  await page.getByRole('menuitem', { name: /dark/i }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('health responds without touching the database', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ status: 'ok' });
});
