/**
 * Worker process bootstrap for `pnpm worker`.
 *
 * Runs via `node --import ./scripts/worker-loader.mjs` BEFORE the TypeScript
 * entrypoint (src/lib/jobs/runner.ts) is evaluated, so it can:
 *
 * 1. Load `.env` for local development when `dotenv` is available. dotenv is a
 *    devDependency and may be pruned from production images — absence is not
 *    an error there, where env vars come from the real environment.
 * 2. Register the `@/` tsconfig path-alias hook (worker-alias-hooks.mjs),
 *    which Node cannot resolve natively.
 *
 * This file is plain JavaScript on purpose: it must load without any
 * TypeScript support, because it is what ENABLES TypeScript support.
 */

import { createRequire, register } from 'node:module';

const require = createRequire(import.meta.url);

try {
  require('dotenv/config');
} catch {
  // dotenv not installed (e.g. production image with pruned devDependencies).
  // Environment variables must come from the real environment.
}

register('./worker-alias-hooks.mjs', import.meta.url);
