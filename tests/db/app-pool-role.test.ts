/**
 * The business pool proves its login on a live database: a pool built exactly as
 * src/lib/db/pool.ts builds it (same verify hook) accepts app_user and refuses the owner.
 * The exported `pool` itself is exercised by every app_user suite.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { resetAppRoleProofForTests, verifyAppUserLogin } from '@/lib/db/pool';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

const poolFor = (connectionString: string | undefined) =>
  new Pool({ connectionString, max: 1, verify: verifyAppUserLogin } as ConstructorParameters<
    typeof Pool
  >[0]);

describe.skipIf(!HAS_DB)('the app_user pool refuses any other login (live)', () => {
  const pools: Pool[] = [];
  beforeEach(() => resetAppRoleProofForTests());
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
  });

  it('a pool on DATABASE_URL_TEST (app_user) connects and queries', async () => {
    const p = poolFor(process.env.DATABASE_URL_TEST);
    pools.push(p);
    const { rows } = await p.query<{ u: string }>('select session_user::text as u');
    expect(rows[0]!.u).toBe('app_user');
  });

  it('a pool on the owner login (DATABASE_URL_MIGRATE) is refused before any query runs', async () => {
    const p = poolFor(process.env.DATABASE_URL_MIGRATE);
    pools.push(p);
    await expect(p.query('select 1')).rejects.toThrow(
      "DATABASE_URL authenticates as 'app_owner', not app_user. Refusing to use it.",
    );
  });
});
