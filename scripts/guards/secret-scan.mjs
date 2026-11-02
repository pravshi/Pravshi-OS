#!/usr/bin/env node
/**
 * Delegating stub for tooling/repository-guards/secret-scan.mjs (redesign Step 8).
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main } from '../../tooling/repository-guards/secret-scan.mjs';

export * from '../../tooling/repository-guards/secret-scan.mjs';

const invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invoked && invoked === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
