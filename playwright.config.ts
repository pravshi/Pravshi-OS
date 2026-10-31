import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { assertTestDatabaseTargets, nextProductionEnv } from './tests/db-target-guard';

// The specs seed through DATABASE_URL_MIGRATE and the webServer reads .env on its own, so
// neither passes through tests/setup.ts. Refuse here — before the server starts or a spec
// seeds anything — if any DATABASE_URL* the run would use is not an approved test target.
// Since Step 7 the server runs in apps/web and loads its .env* files from there, while the specs
// and the worker read the repository root: check the files of both places.
for (const dir of [process.cwd(), join(process.cwd(), 'apps/web')]) {
  assertTestDatabaseTargets(nextProductionEnv(dir, process.env));
}

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
    command: `pnpm --filter @pravshi/web exec next start --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    // A cold Next start plus a Neon wake is legitimately slow; see Global Constraints.
    timeout: 120_000,
  },
});
