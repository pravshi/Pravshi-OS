import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const baseURL = `http://127.0.0.1:${PORT}`;

/**
 * The suite runs against a PRODUCTION build, not `next dev`. Phase 0's whole
 * point is proving the deployed shape works, and dev-mode differences (no
 * minification, different route handling) would let a broken build pass here.
 *
 * `pnpm build` is deliberately NOT part of webServer.command: the plan runs it
 * first (`pnpm build && pnpm e2e`) so a compile failure is reported as a build
 * failure rather than as an opaque server-start timeout.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next start --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    // A cold Next start plus a Neon wake is legitimately slow; see Global Constraints.
    timeout: 120_000,
  },
});
