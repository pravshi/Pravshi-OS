import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000, // Neon cold starts are legitimate; see Global Constraints
    // Same reason, and it needs saying separately: vitest defaults hooks to 10s regardless
    // of testTimeout, and a beforeAll that builds organizations, people and engagements
    // over a cold branch legitimately exceeds that. Fixtures are parallelised where the
    // rows are independent; this covers the round-trip latency that remains.
    hookTimeout: 30_000,
  },
});
