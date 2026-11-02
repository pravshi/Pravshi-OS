#!/usr/bin/env node
/**
 * Delegating stub for tooling/release/verify-pr-merge.mjs (redesign Step 8).
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main } from '../../tooling/release/verify-pr-merge.mjs';

export * from '../../tooling/release/verify-pr-merge.mjs';

const invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invoked && invoked === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
