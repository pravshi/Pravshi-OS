import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: 'node',
    // include is per project below: with extends: true a root include would be MERGED into
    // each project's, and the perf project would then run every file a second time.
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000, // Neon cold starts are legitimate; see Global Constraints
    // Same reason, and it needs saying separately: vitest defaults hooks to 10s regardless
    // of testTimeout, and a beforeAll that builds organizations, people and engagements
    // over a cold branch legitimately exceeds that. Fixtures are parallelised where the
    // rows are independent; this covers the round-trip latency that remains.
    hookTimeout: 30_000,
    // Two groups, run one after the other (sequence.groupOrder, lowest first). The perf
    // harness (tests/perf) seeds its dataset in ONE transaction of about two minutes — on
    // purpose, so no suite ever sees it half-seeded — and that transaction holds ordinary
    // write locks on deals, activities, notifications, audit_logs and the permissions its
    // grants reference. Any suite that needs a conflicting lock meanwhile (a trigger toggle
    // on deals, a permission rename probe, audit partition DDL) waited out the whole seed
    // and timed out. Run after everything else, the seed overlaps nothing; the perf suites
    // also measure on a quiet database. `pnpm test` still runs every file.
    //
    // A third group runs FIRST, alone (tests/serial): suites that must create and drop
    // audit_logs partitions or run the once-per-database bootstrap, which no other suite may
    // see happen — they assert exact partition windows and an unbootstrapped database. These
    // suites leave the database as they found it, and they run one file at a time
    // (fileParallelism: false): they disturb each other too — the partition-maintenance probes
    // hold a maintenance backend waiting, which the lock-order suite would take for its own.
    //
    // groupOrder indexes an array in vitest, so it must not be negative; and it must not be 0
    // for the serial project: vitest 5 moves a project with groupOrder 0 and a single worker
    // into a separate sequential group that runs LAST (groupSpecs). So the groups are 1, 2, 3.
    projects: [
      {
        extends: true,
        test: {
          name: 'serial',
          include: ['tests/serial/**/*.test.ts'],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'default',
          include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
          exclude: ['tests/perf/**', 'tests/serial/**', '**/node_modules/**'],
          sequence: { groupOrder: 2 },
        },
      },
      {
        extends: true,
        test: {
          name: 'perf',
          include: ['tests/perf/**/*.test.ts'],
          sequence: { groupOrder: 3 },
        },
      },
    ],
  },
});
