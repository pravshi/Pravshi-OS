import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { analyseWorkflow } from '../../scripts/guards/workflow-secret-flow.mjs';

const run = (yaml: string) => analyseWorkflow(parse(yaml), 'fixture.yml');

describe('workflow secret-flow guard (finding #2)', () => {
  it('detects a DIRECT secret binding', () => {
    expect(
      run(`
jobs:
  a:
    steps:
      - run: pnpm migrate
        env:
          DATABASE_URL_MIGRATE: \${{ secrets.PROD_DB }}
`).length,
    ).toBeGreaterThan(0);
  });

  it('detects a RENAMED intermediary env var', () => {
    expect(
      run(`
env:
  INNOCENT: \${{ secrets.PROD_DB }}
jobs:
  a:
    steps:
      - run: pnpm migrate
        env:
          DATABASE_URL: \${{ env.INNOCENT }}
`).length,
    ).toBeGreaterThan(0);
  });

  it('detects SHELL indirection inside a run block', () => {
    expect(
      run(`
env:
  SNEAKY: \${{ secrets.PROD_DB }}
jobs:
  a:
    steps:
      - run: |
          export DATABASE_URL_TEST=$SNEAKY
          pnpm test
`).length,
    ).toBeGreaterThan(0);
  });

  it('detects a step OUTPUT derived from a secret', () => {
    expect(
      run(`
jobs:
  a:
    steps:
      - id: leak
        env:
          SRC: \${{ secrets.PROD_DB }}
        run: echo "url=$SRC" >> "$GITHUB_OUTPUT"
      - run: pnpm test
        env:
          DATABASE_URL: \${{ steps.leak.outputs.url }}
`).length,
    ).toBeGreaterThan(0);
  });

  it('allows a URL derived from a step output that is NOT secret-derived', () => {
    // This is the real pipeline's shape: the Neon API call produces the URL.
    expect(
      run(`
jobs:
  a:
    steps:
      - id: neon
        env:
          NEON_API_KEY: \${{ secrets.NEON_API_KEY }}
        run: node scripts/ci/provision-branch-role.mjs create
      - run: pnpm test
        env:
          APP_URL: http://localhost:3000
`),
    ).toHaveLength(0);
  });
});
