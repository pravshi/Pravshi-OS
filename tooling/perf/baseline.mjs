/**
 * Phase 12 (Wave D) — Tier-2 baseline entry point (audit §4.4).
 *
 * Thin launcher: the scenarios live in run-baseline.ts and call the real
 * TypeScript services, so this .mjs does exactly what `pnpm worker` does
 * — spawn node with --experimental-transform-types and the worker loader
 * (which loads .env and registers the `@/` alias hook). No new tooling,
 * no new dependency.
 *
 *   node scripts/perf/baseline.mjs [--ci] [--scale <n>]
 *                                  [--iterations <n>] [--prime <n>]
 *                                  [--out <path>]
 *
 * Record-only, never gated. First full run: the post-Nov-1 slot against
 * the disposable verification project (docs/phase12-performance.md §5).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const child = spawnSync(
  process.execPath,
  [
    '--experimental-transform-types',
    '--import',
    './scripts/worker-loader.mjs',
    'scripts/perf/run-baseline.ts',
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: 'inherit', env: process.env },
);

if (child.error) {
  console.error('baseline: failed to launch the runner:', child.error.message);
  process.exit(1);
}
process.exit(child.status ?? 1);
