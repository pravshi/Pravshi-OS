#!/usr/bin/env node
/**
 * Root forwarding stub for packages/database/scripts/db/run.mjs (Step 8 Package 2).
 */
export * from '../../packages/database/scripts/db/run.mjs';

import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import('../../packages/database/scripts/db/run.mjs');
}
