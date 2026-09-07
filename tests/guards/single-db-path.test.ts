import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const grep = (args: string) => execSync(`git grep ${args} || true`, { encoding: 'utf8' }).trim();

describe('there is exactly one path to Postgres', () => {
  it('nothing calls pool.connect() outside src/lib/db/pool.ts', () => {
    const hits = grep(`-l "pool.connect(" -- src ":!src/lib/db/pool.ts"`);
    expect(hits, `Direct pool.connect() bypasses cold-start retry, in:\n${hits}`).toBe('');
  });

  it('nothing outside the db module imports the pool', () => {
    const hits = grep(
      `-lE "from '@/lib/db/pool'" -- src ":!src/lib/db/*" ":!src/app/health/db/route.ts"`,
    );
    expect(hits, `Unexpected pool import — use withAuthorizedDb(), in:\n${hits}`).toBe('');
  });
});
