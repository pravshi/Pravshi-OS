/**
 * Root delegating stub for packages/database/scripts/migrate-ws.mjs (redesign Step 8).
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from '../packages/database/scripts/migrate-ws.mjs';

export * from '../packages/database/scripts/migrate-ws.mjs';

const invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invoked && invoked === fs.realpathSync(fileURLToPath(import.meta.url))) {
  run();
}
