#!/usr/bin/env node
/**
 * Delegating stub for tooling/security-checks/auth-pool-probe.mjs (redesign Step 8).
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main } from '../../tooling/security-checks/auth-pool-probe.mjs';

export * from '../../tooling/security-checks/auth-pool-probe.mjs';

const invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invoked && invoked === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const code = await main(process.argv.slice(2), process.env);
  process.exit(code);
}
