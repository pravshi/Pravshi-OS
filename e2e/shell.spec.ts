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

test('mobile viewport renders hamburger trigger, drawer navigation and bottom bar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/');

  // Desktop sidebar must be hidden on mobile
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();

  // Mobile bottom tab bar must be visible
  await expect(page.getByRole('navigation', { name: 'Mobile' })).toBeVisible();

  // Mobile hamburger menu trigger must be visible
  const menuButton = page.getByRole('button', { name: 'Open navigation menu' });
  await expect(menuButton).toBeVisible();

  // Clicking hamburger opens mobile drawer
  await menuButton.click();
  const drawer = page.getByRole('navigation', { name: 'Mobile Directory' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('link', { name: 'Home' })).toBeVisible();
  await expect(drawer.getByRole('link', { name: 'My security' })).toBeVisible();
});
