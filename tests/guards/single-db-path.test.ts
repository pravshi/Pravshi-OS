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

  it('only the auth module uses the auth client, which is the one sanctioned exception', () => {
    // authDb reaches the `auth` schema without an identity in the transaction, because a
    // request cannot present an identity while it is being established. That exception is
    // for authentication and nothing else: business data still goes through
    // withAuthorizedDb(), where RLS meets it.
    const hits = grep(
      `-lE "from '@/lib/db/auth-client'" -- src ":!src/lib/auth/*" ":!src/lib/db/*"`,
    );
    expect(
      hits,
      `authDb bypasses withAuthorizedDb() and belongs to the auth module only, in:\n${hits}`,
    ).toBe('');
  });

  it('no feature code queries the credential tables by hand', () => {
    const hits = grep(
      `-lE "auth[.]auth_(users|sessions|accounts|verifications)" -- src ":!src/lib/auth/*"`,
    );
    expect(hits, `Direct auth-table access outside the auth layer, in:\n${hits}`).toBe('');
  });
});
