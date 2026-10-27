/**
 * FU-3 / F-MFA-5 (migration 0079) — authz.check_rate_limit counts concurrent first uses.
 *
 * Before 0079, two requests arriving together on a key's first use both tried to INSERT the
 * bucket and the second failed with 23505 (reproduced locally: 149 of 200 concurrent calls in
 * 10 rounds of 20). The upsert form serializes on the key: every call is counted, none fails.
 * Called as app_auth, the only runtime role allowed to execute it since 0073.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

const HAS_DB = Boolean(process.env.DATABASE_URL_AUTH && process.env.DATABASE_URL_MIGRATE);
const PARALLEL = 20;
const authPool = new Pool({ connectionString: process.env.DATABASE_URL_AUTH, max: PARALLEL + 2 });
const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

const check = (key: string, max: number, windowSeconds: number) =>
  authPool
    .query<{ ok: boolean }>(`select authz.check_rate_limit($1, $2, $3) as ok`, [
      key,
      max,
      windowSeconds,
    ])
    .then((r) => r.rows[0]!.ok);

const countOf = async (key: string) =>
  Number(
    (
      await owner.query<{ count: number }>(
        `select count from auth.api_rate_limits where key = $1`,
        [key],
      )
    ).rows[0]?.count ?? 0,
  );

describe.skipIf(!HAS_DB)('rate-limit buckets on concurrent first use (FU-3, 0079)', () => {
  afterAll(async () => {
    await authPool.end();
    await owner.end();
  });

  it('20 simultaneous first uses of a key all succeed and are each counted once', async () => {
    for (let round = 0; round < 5; round++) {
      const key = `fu3:${randomUUID()}`;
      const clients = await Promise.all(Array.from({ length: PARALLEL }, () => authPool.connect()));
      const results = await Promise.allSettled(
        clients.map((c) => c.query(`select authz.check_rate_limit($1, 100, 60) as ok`, [key])),
      );
      clients.forEach((c) => c.release());
      const failures = results.filter((r) => r.status === 'rejected');
      expect(failures.map((f) => (f as PromiseRejectedResult).reason?.code)).toEqual([]);
      expect(await countOf(key)).toBe(PARALLEL);
    }
  });

  it('keeps 0024 semantics: allowed up to max, refused after, counted throughout', async () => {
    const key = `fu3:${randomUUID()}`;
    const seen = [];
    for (let i = 0; i < 5; i++) seen.push(await check(key, 3, 60));
    expect(seen).toEqual([true, true, true, false, false]);
    expect(await countOf(key)).toBe(5);
  });

  it('a stale window restarts at 1 and is allowed', async () => {
    const key = `fu3:${randomUUID()}`;
    for (let i = 0; i < 4; i++) await check(key, 2, 60);
    await owner.query(
      `update auth.api_rate_limits set window_start = now() - interval '2 minutes' where key = $1`,
      [key],
    );
    expect(await check(key, 2, 60)).toBe(true);
    expect(await countOf(key)).toBe(1);
  });

  it('a first use is allowed whatever max is, exactly as 0024 did', async () => {
    expect(await check(`fu3:${randomUUID()}`, 0, 60)).toBe(true);
  });

  it('is executable by app_auth only, and stays a SECURITY DEFINER', async () => {
    const { rows } = await owner.query<{ auth: boolean; usr: boolean; definer: boolean }>(
      `select has_function_privilege('app_auth', 'authz.check_rate_limit(text,integer,integer)', 'EXECUTE') as auth,
              has_function_privilege('app_user', 'authz.check_rate_limit(text,integer,integer)', 'EXECUTE') as usr,
              (select prosecdef from pg_proc where oid = 'authz.check_rate_limit(text,integer,integer)'::regprocedure) as definer`,
    );
    expect(rows[0]).toEqual({ auth: true, usr: false, definer: true });
  });
});
