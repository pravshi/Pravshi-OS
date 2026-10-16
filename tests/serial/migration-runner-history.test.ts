import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { DB_READY } from '../workflows/helpers';

/**
 * The REAL migration runner (scripts/migrate-ws.mjs), as a child process, against the migrated
 * test database: it migrates only from a verified clean prefix of the journal and otherwise
 * refuses (exit 3) without applying anything. The static history check, prefix by prefix, is in
 * tests/guards/migration-history.test.ts; upgrade paths from real prefixes are rehearsed on
 * disposable databases (the production-migration runbook, Step 2).
 *
 * Runs in the 'serial' project, before every other group: each case alters
 * drizzle.__drizzle_migrations for a moment and restores it in `finally`, so no other suite may
 * run meanwhile. The database's schema is never touched.
 */
describe.skipIf(!DB_READY)('migration runner: verified history only (live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE, max: 2 });

  afterAll(async () => {
    await owner.end();
  });

  const run = () => {
    const r = spawnSync(process.execPath, ['scripts/migrate-ws.mjs'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      timeout: 120_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const history = async () =>
    (
      await owner.query<{ id: number; hash: string; created_at: string }>(
        'select id, hash, created_at::text from drizzle.__drizzle_migrations order by id',
      )
    ).rows;

  it('a fully migrated database: verified, nothing to apply, exit 0', async () => {
    const before = await history();
    const { code, out } = run();
    expect(out).toContain(`verified history: ${before.length} of ${before.length} entries`);
    expect(out).toContain(`done: applied 0, total ${before.length}`);
    expect(code).toBe(0);
    expect(await history()).toEqual(before);
  }, 150_000);

  it('a checksum mismatch is refused with exit 3 and nothing applied', async () => {
    const before = await history();
    const victim = before[30]!;
    await owner.query('update drizzle.__drizzle_migrations set hash = $1 where id = $2', [
      'f'.repeat(64),
      victim.id,
    ]);
    try {
      const { code, out } = run();
      expect(out).toMatch(/REFUSED: recorded row 31 .* different checksum/);
      expect(out).toContain('Nothing was applied.');
      expect(code).toBe(3);
      expect((await history()).length).toBe(before.length);
    } finally {
      await owner.query('update drizzle.__drizzle_migrations set hash = $1 where id = $2', [
        victim.hash,
        victim.id,
      ]);
    }
    expect(await history()).toEqual(before);
  }, 150_000);

  it('a duplicated history row is refused with exit 3', async () => {
    const before = await history();
    const copy = before[5]!;
    const { rows } = await owner.query<{ id: number }>(
      'insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2) returning id',
      [copy.hash, copy.created_at],
    );
    try {
      const { code, out } = run();
      expect(out).toMatch(/REFUSED: recorded row \d+ .* beyond the journal/);
      expect(code).toBe(3);
    } finally {
      await owner.query('delete from drizzle.__drizzle_migrations where id = $1', [rows[0]!.id]);
    }
    expect(await history()).toEqual(before);
  }, 150_000);

  it('a concurrent run (the lock is held) is refused with exit 3', async () => {
    const holder = await owner.connect();
    try {
      await holder.query("select pg_advisory_lock(hashtext('pravshi-os:migrate-ws'))");
      const { code, out } = run();
      expect(out).toContain('REFUSED: another migration run holds the lock');
      expect(code).toBe(3);
    } finally {
      await holder.query("select pg_advisory_unlock(hashtext('pravshi-os:migrate-ws'))");
      holder.release();
    }
  }, 150_000);
});
