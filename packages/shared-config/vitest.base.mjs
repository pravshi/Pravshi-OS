import react from '@vitejs/plugin-react';

/**
 * The Vitest options every suite in the workspace shares (redesign Step 8, package 1:
 * shared-config). The repository's vitest.config.mts spreads this and adds what belongs to this
 * repository: the setup file, the project groups and their ordering.
 */
export const baseVitestConfig = {
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: 'node',
    testTimeout: 30_000, // Neon cold starts are legitimate; see Global Constraints
    // Same reason, and it needs saying separately: vitest defaults hooks to 10s regardless
    // of testTimeout, and a beforeAll that builds organizations, people and engagements
    // over a cold branch legitimately exceeds that. Fixtures are parallelised where the
    // rows are independent; this covers the round-trip latency that remains.
    hookTimeout: 30_000,
  },
};
