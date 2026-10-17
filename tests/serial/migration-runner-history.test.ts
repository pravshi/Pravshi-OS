import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { loadJournal } from '../../scripts/migrate-ws.mjs';
import { DB_READY } from '../workflows/helpers';

/**
 * The REAL migration runner (scripts/migrate-ws.mjs), as a child process, against databases of
 * its own: it migrates only from a verified clean prefix of the journal, applies the rest in
 * journal order — nothing skipped inside the historical out-of-order `when` ranges — and refuses
 * (exit 3, nothing applied) every other history. The static check, prefix by prefix, is in
 * tests/guards/migration-history.test.ts.
 *
 * ISOLATION. This suite builds partial histories and corrupts them on purpose, so it never
 * touches the shared test database. CI provisions two empty databases on its throwaway server
 * (.github/workflows/ci.yml, "Provision the migration-runner test databases") and passes owner
 * URLs for those alone: DATABASE_URL_MIGRATION_TEST_A and _B. Before writing anything the suite
 * proves each target is a different database from the shared one and is empty (no migration
 * history, no application tables), and refuses otherwise; it reads the shared database's history
 * only to prove at the end that it never changed. An interruption can leave only these two
 * scratch databases half-built — they disappear with the CI job.
 *
 * Prefix states are built by the runner itself: its file is copied byte-for-byte (hash-checked)
 * into a git-ignored directory with the journal cut at K entries, and run from there.
 *
 * It sits in the 'serial' group not for safety (it touches no shared state) but so its two full
 * migration runs (~1.5 min) do not compete for CPU with the timing-sensitive default group.
 */
const A = process.env.DATABASE_URL_MIGRATION_TEST_A;
const B = process.env.DATABASE_URL_MIGRATION_TEST_B;
const ISOLATED = DB_READY && !!A && !!B;
const ROOT = process.cwd();
const entries: { idx: number; tag: string; when: string; hash: string }[] = loadJournal();

describe.runIf(DB_READY && !!process.env.CI)('migration runner tests: CI provisioning', () => {
  it('provides the two isolated databases (otherwise the suite below would be skipped)', () => {
    expect(A, 'DATABASE_URL_MIGRATION_TEST_A').toBeTruthy();
    expect(B, 'DATABASE_URL_MIGRATION_TEST_B').toBeTruthy();
  });
});

describe.skipIf(!ISOLATED)(
  'migration runner: verified history only (isolated live databases)',
  () => {
    const shared = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE, max: 1 });
    const dbA = new Pool({ connectionString: A, max: 2 });
    const dbB = new Pool({ connectionString: B, max: 2 });
    const trees: string[] = [];
    let sharedBefore = '';

    const historyDigest = async (pool: Pool) =>
      (
        await pool.query<{ d: string }>(
          `select coalesce(md5(string_agg(id || ':' || hash || ':' || created_at, ',' order by id)), 'none') as d
           from drizzle.__drizzle_migrations`,
        )
      ).rows[0]!.d;
    const history = async (pool: Pool) =>
      (
        await pool.query<{ id: number; hash: string; created_at: string }>(
          'select id, hash, created_at::text from drizzle.__drizzle_migrations order by id',
        )
      ).rows;
    const schemaDigest = async (pool: Pool) =>
      (
        await pool.query<{ d: string }>(
          `select md5(string_agg(n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')'
                                || md5(p.prosrc), ',' order by 1)) as d
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'authz')`,
        )
      ).rows[0]!.d;
    /** The recorded history must be exactly the journal's first `k` entries, in id order. */
    const expectPrefix = async (pool: Pool, k: number) => {
      const rows = await history(pool);
      expect(rows.map((r) => [r.hash, r.created_at])).toEqual(
        entries.slice(0, k).map((e) => [e.hash, e.when]),
      );
    };
    /** Rewrite the history as exactly the journal's first `k` entries (scratch databases only). */
    const resetHistory = async (pool: Pool, k: number) => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query('delete from drizzle.__drizzle_migrations');
        for (const e of entries.slice(0, k)) {
          await c.query(
            'insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)',
            [e.hash, e.when],
          );
        }
        await c.query('commit');
      } catch (error) {
        await c.query('rollback');
        throw error;
      } finally {
        c.release();
      }
    };

    /** A runnable copy of the runner whose journal stops after `k` entries. */
    const treeWithPrefix = (k: number) => {
      const dir = join(ROOT, 'node_modules', '.cache', `pravshi-migration-runner-${randomUUID()}`);
      trees.push(dir);
      mkdirSync(join(dir, 'scripts', 'ci'), { recursive: true });
      mkdirSync(join(dir, 'drizzle', 'meta'), { recursive: true });
      copyFileSync(join(ROOT, 'scripts', 'migrate-ws.mjs'), join(dir, 'scripts', 'migrate-ws.mjs'));
      copyFileSync(
        join(ROOT, 'scripts', 'ci', 'neon-local.mjs'),
        join(dir, 'scripts', 'ci', 'neon-local.mjs'),
      );
      for (const f of readdirSync(join(ROOT, 'drizzle')).filter((f) => f.endsWith('.sql'))) {
        copyFileSync(join(ROOT, 'drizzle', f), join(dir, 'drizzle', f));
      }
      const journal = JSON.parse(
        readFileSync(join(ROOT, 'drizzle', 'meta', '_journal.json'), 'utf8'),
      );
      journal.entries = journal.entries.slice(0, k);
      writeFileSync(
        join(dir, 'drizzle', 'meta', '_journal.json'),
        JSON.stringify(journal, null, 2),
      );
      const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
      expect(sha(join(dir, 'scripts', 'migrate-ws.mjs'))).toBe(
        sha(join(ROOT, 'scripts', 'migrate-ws.mjs')),
      );
      return dir;
    };
    const run = (cwd: string, url: string) => {
      const r = spawnSync(process.execPath, ['scripts/migrate-ws.mjs'], {
        cwd,
        env: { ...process.env, DATABASE_URL_MIGRATE: url },
        encoding: 'utf8',
        timeout: 240_000,
      });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const appliedOrder = (out: string) =>
      [...out.matchAll(/^applying idx (\d+) /gm)].map((m) => Number(m[1]));

    beforeAll(async () => {
      const sharedName = (await shared.query<{ d: string }>('select current_database() as d'))
        .rows[0]!.d;
      for (const [label, pool] of [
        ['A', dbA],
        ['B', dbB],
      ] as const) {
        const { rows } = await pool.query<{
          d: string;
          history: string | null;
          app: string | null;
        }>(
          `select current_database() as d, to_regclass('drizzle.__drizzle_migrations')::text as history,
                to_regclass('public.organizations')::text as app`,
        );
        const r = rows[0]!;
        if (r.d === sharedName)
          throw new Error(`database ${label} is the shared test database — refusing`);
        if (r.history !== null || r.app !== null) {
          throw new Error(
            `database ${label} (${r.d}) is not empty — refusing; provision a fresh one`,
          );
        }
      }
      sharedBefore = await historyDigest(shared);
    }, 60_000);

    afterAll(async () => {
      try {
        // The shared test database's migration history was never touched.
        expect(await historyDigest(shared)).toBe(sharedBefore);
      } finally {
        for (const dir of trees) rmSync(dir, { recursive: true, force: true });
        await Promise.all([shared.end(), dbA.end(), dbB.end()]);
      }
    });

    it('A: the runner builds a clean prefix through idx 26, inside the out-of-order range', async () => {
      const { code, out } = run(treeWithPrefix(27), A!);
      expect(out).toContain('done: applied 27, total 27');
      expect(code).toBe(0);
      await expectPrefix(dbA, 27);
    }, 300_000);

    it('A: from it, idx 27…n-1 are applied in journal order — idx 28-30 are not skipped', async () => {
      const { code, out } = run(ROOT, A!);
      expect(out).toContain(`verified history: 27 of ${entries.length} entries`);
      expect(appliedOrder(out)).toEqual(entries.slice(27).map((e) => e.idx));
      expect(out).toContain(`done: applied ${entries.length - 27}, total ${entries.length}`);
      expect(code).toBe(0);
      await expectPrefix(dbA, entries.length);
    }, 300_000);

    it('B: from a prefix through idx 34 (the idx 34/35 tie), idx 35 is applied, not skipped', async () => {
      const built = run(treeWithPrefix(35), B!);
      expect(built.code).toBe(0);
      await expectPrefix(dbB, 35);
      const { code, out } = run(ROOT, B!);
      expect(out).toContain(`verified history: 35 of ${entries.length} entries`);
      expect(appliedOrder(out)).toEqual(entries.slice(35).map((e) => e.idx));
      expect(code).toBe(0);
      await expectPrefix(dbB, entries.length);
    }, 300_000);

    it('A: a fully migrated database is verified and nothing is applied', async () => {
      const { code, out } = run(ROOT, A!);
      expect(out).toContain(`verified history: ${entries.length} of ${entries.length} entries`);
      expect(out).toContain(`done: applied 0, total ${entries.length}`);
      expect(code).toBe(0);
    }, 300_000);

    describe('A: every other history is refused with exit 3, and the run changes nothing', () => {
      /** `k`: the history length the corruption starts from (entries.length: nothing pending). */
      const refusedCase = async (
        corrupt: () => Promise<unknown>,
        reason: RegExp,
        k = entries.length,
      ) => {
        await resetHistory(dbA, k);
        await corrupt();
        const historyBefore = await historyDigest(dbA);
        const schemaBefore = await schemaDigest(dbA);
        const { code, out } = run(ROOT, A!);
        expect(out).toMatch(reason);
        expect(out).toContain('Nothing was applied.');
        expect(out).not.toMatch(/^applying idx/m);
        expect(code).toBe(3);
        expect(await historyDigest(dbA)).toBe(historyBefore);
        expect(await schemaDigest(dbA)).toBe(schemaBefore);
      };

      it('a checksum mismatch', async () => {
        await refusedCase(
          () =>
            dbA.query(
              `update drizzle.__drizzle_migrations set hash = $1
              where id = (select id from drizzle.__drizzle_migrations order by id offset 30 limit 1)`,
              ['f'.repeat(64)],
            ),
          /REFUSED: recorded row 31 .* different checksum/,
        );
      }, 300_000);

      // With nothing pending, "nothing applied" would hold even for a runner that applied before
      // verifying. Here idx 35…n-1 are pending: the refusal must come before any of them runs.
      it('a checksum mismatch while migrations are pending', async () => {
        await refusedCase(
          () =>
            dbA.query(
              `update drizzle.__drizzle_migrations set hash = $1
              where id = (select id from drizzle.__drizzle_migrations order by id offset 30 limit 1)`,
              ['f'.repeat(64)],
            ),
          /REFUSED: recorded row 31 .* different checksum/,
          35,
        );
      }, 300_000);

      it('a missing migration', async () => {
        await refusedCase(
          () =>
            dbA.query(
              `delete from drizzle.__drizzle_migrations
              where id = (select id from drizzle.__drizzle_migrations order by id offset 10 limit 1)`,
            ),
          /REFUSED: recorded row 11 .* is idx 11 .* but idx 10 .* was expected there/,
        );
      }, 300_000);

      it('a duplicated history row', async () => {
        await refusedCase(
          () =>
            dbA.query(
              `insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`,
              [entries[5]!.hash, entries[5]!.when],
            ),
          /REFUSED: recorded row \d+ .* beyond the journal/,
        );
      }, 300_000);

      it('a history recorded in time order (idx 28-29 before 26-27)', async () => {
        await refusedCase(async () => {
          const timeOrdered = [...entries].sort(
            (x, y) => Number(BigInt(x.when) - BigInt(y.when)) || x.idx - y.idx,
          );
          await dbA.query('delete from drizzle.__drizzle_migrations');
          for (const e of timeOrdered) {
            await dbA.query(
              'insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)',
              [e.hash, e.when],
            );
          }
        }, /REFUSED: recorded row 27 .* is idx 28 .* but idx 26 .* was expected there/);
      }, 300_000);

      it('a concurrent run (the migration lock is held)', async () => {
        await resetHistory(dbA, entries.length);
        const holder = await dbA.connect();
        try {
          await holder.query("select pg_advisory_lock(hashtext('pravshi-os:migrate-ws'))");
          const { code, out } = run(ROOT, A!);
          expect(out).toContain('REFUSED: another migration run holds the lock');
          expect(code).toBe(3);
        } finally {
          await holder.query("select pg_advisory_unlock(hashtext('pravshi-os:migrate-ws'))");
          holder.release();
        }
      }, 300_000);
    });
  },
);
