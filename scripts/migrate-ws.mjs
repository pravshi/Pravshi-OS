/**
 * WebSocket-based migration runner, for environments where the `pg` driver's
 * direct TCP is unavailable. It records history in drizzle-kit's table and
 * format — one row per migration: (sha256 of the file's bytes, journal `when`) —
 * but it does NOT select pending migrations the way drizzle-kit does.
 *
 * WHY NOT drizzle-kit's rule. drizzle-kit applies every journal entry whose
 * `when` is greater than max(created_at). This journal's historical `when`
 * values are not monotonic (idx 28-30 carry earlier values than idx 27; idx 35
 * ties idx 34), so a database stopped inside those ranges would have pending
 * migrations skipped without a word, and the rule never checks that what was
 * applied is what the repository contains.
 *
 * Logic:
 *  1. Read drizzle/meta/_journal.json — the canonical order is the journal's
 *     (idx 0…n-1), never time.
 *  2. Read the recorded history in insertion order (ORDER BY id).
 *  3. Verify it is exactly the journal's prefix idx 0…K-1: same file-byte hash
 *     and same `when`, row for row. Anything else — a missing, duplicated,
 *     reordered, unknown or checksum-mismatched row, or more rows than the
 *     journal has — stops the run with exit 3 before anything is applied: the
 *     history must be reconciled by a person, never repaired by the runner.
 *  4. Apply idx K…n-1 in journal order: split the SQL file into statements
 *     (dollar-quote-aware), run them in one transaction, record
 *     (sha256(file), when), commit.
 *
 * One runner at a time: a session advisory lock is taken without waiting; if
 * another run holds it, this one exits 3 having done nothing. Each migration's
 * transaction re-checks the history length, so a concurrent writer to the
 * history table also stops the run — with exit 3, but after the migrations this
 * run had already committed, which stay applied (the message says how many).
 *
 * Exit codes: 0 success · 1 the runner itself errored · 2 a migration failed
 * and was rolled back · 3 refused: the recorded history is not a clean prefix of
 * the journal, or another run is in progress (refused before applying anything),
 * or the history changed during the run (whole migrations committed earlier in
 * this run stay applied; the message says how many).
 *
 * ONE CONNECTION, REAL TRANSACTIONS. Every statement runs on a single pooled
 * WebSocket connection, so BEGIN … COMMIT genuinely wraps each migration and a
 * failure rolls the whole migration back. (An earlier version used the driver's
 * HTTP mode, where each query is its own request and its own transaction — its
 * BEGIN/COMMIT wrapped nothing, so a failed migration left partial state.)
 *
 * Usage: node scripts/migrate-ws.mjs
 * Requires: DATABASE_URL_MIGRATE in environment (direct URL; the neon
 * serverless driver tunnels over WebSocket). In CI, scripts/ci/neon-local.mjs
 * points the same driver at the job's local Postgres.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from '@neondatabase/serverless';
import './ci/neon-local.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Split SQL on semicolons, respecting dollar-quoted bodies, quoted strings, line comments. */
export function splitStatements(text) {
  const stmts = [];
  let buf = '';
  let i = 0;
  let dollarTag = null;
  while (i < text.length) {
    if (dollarTag) {
      if (text.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        buf += text[i++];
      }
      continue;
    }
    const m = text.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
    if (m) {
      dollarTag = m[0];
      buf += dollarTag;
      i += dollarTag.length;
      continue;
    }
    const ch = text[i];
    if (ch === "'") {
      // Quoted string, '' is an escaped quote.
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      buf += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '-' && text[i + 1] === '-') {
      const j = text.indexOf('\n', i);
      const end = j === -1 ? text.length : j + 1;
      buf += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ';') {
      buf += ch;
      i++;
      // A chunk is executable if it contains anything besides comments/whitespace.
      const code = buf.replace(/--[^\n]*\n?/g, '').trim();
      if (code) stmts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += text[i++];
  }
  const code = buf.replace(/--[^\n]*\n?/g, '').trim();
  if (code) stmts.push(buf.trim());
  return stmts;
}

/** sha256 of a migration file's text — exactly what the history table records. */
export function fileHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * The repository journal in canonical order, each entry with its file text and hash. Throws if
 * the journal itself is malformed: entries must be numbered 0…n-1 in array order, tags unique,
 * and every file present.
 */
export function loadJournal(rootDir = root) {
  const journal = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'drizzle/meta/_journal.json'), 'utf8'),
  );
  const seen = new Set();
  return journal.entries.map((e, i) => {
    if (e.idx !== i) {
      throw new Error(
        `journal entry at position ${i} has idx ${e.idx}; the journal must be numbered 0…n-1`,
      );
    }
    if (seen.has(e.tag)) throw new Error(`journal tag ${e.tag} appears twice`);
    seen.add(e.tag);
    const text = fs.readFileSync(path.join(rootDir, 'drizzle', `${e.tag}.sql`), 'utf8');
    return { idx: e.idx, tag: e.tag, when: String(e.when), text, hash: fileHash(text) };
  });
}

/** Why recorded row `i` does not match journal entry `i`, in terms an operator can act on. */
function describeMismatch(i, row, entries) {
  const expected = entries[i];
  const recorded = `recorded row ${i + 1} (id ${row.id}, created_at ${row.created_at ?? 'NULL'})`;
  const same = entries.findIndex((e) => e.hash === row.hash);
  if (!expected) {
    return `${recorded} is beyond the journal's ${entries.length} entries: the database has migrations this repository does not know`;
  }
  if (same === -1) {
    return String(row.created_at) === expected.when
      ? `${recorded} has the timing of idx ${i} ${expected.tag} but a different checksum: the file changed after it was applied, or a different version was applied`
      : `${recorded} matches no migration in this repository (unknown checksum)`;
  }
  if (same === i) {
    return `${recorded} has the checksum of idx ${i} ${expected.tag} but created_at ${row.created_at ?? 'NULL'} instead of its journal when ${expected.when}`;
  }
  if (same < i) {
    return `${recorded} repeats idx ${same} ${entries[same].tag}: a duplicated history row`;
  }
  return `${recorded} is idx ${same} ${entries[same].tag}, but idx ${i} ${expected.tag} was expected there: history is missing a migration or was applied out of order`;
}

/**
 * Compare the recorded history (rows in insertion order: ORDER BY id) with the journal. The
 * history is clean only if it is exactly idx 0…K-1, row for row, by checksum and `when`.
 * Returns { ok: true, applied: K } or { ok: false, problem }.
 */
export function verifyHistory(rows, entries) {
  for (let i = 0; i < rows.length; i++) {
    const e = entries[i];
    const r = rows[i];
    if (!e || r.hash !== e.hash || String(r.created_at) !== e.when) {
      return { ok: false, problem: describeMismatch(i, r, entries) };
    }
  }
  return { ok: true, applied: rows.length };
}

/** Advisory lock key: one migration run per database at a time. */
const RUN_LOCK = "hashtext('pravshi-os:migrate-ws')";

class Refused extends Error {}

/** Migrations committed by this run, for the refusal message. */
let appliedThisRun = 0;

async function main() {
  const url = process.env.DATABASE_URL_MIGRATE;
  if (!url) throw new Error('DATABASE_URL_MIGRATE is required');
  // One dedicated connection for the whole run. `sql.query` keeps the shape the rest of
  // this file was written against: it resolves to the result rows.
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  const sql = { query: async (text, params) => (await client.query(text, params)).rows };

  const entries = loadJournal();

  const [{ locked }] = await sql.query(`select pg_try_advisory_lock(${RUN_LOCK}) as locked`);
  if (!locked) throw new Refused('another migration run holds the lock on this database');

  // drizzle-kit creates the journal schema/table on first use; do the same so
  // this runner also works against a database no migrator has ever touched.
  await sql.query('create schema if not exists drizzle');
  await sql.query(
    'create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)',
  );

  const rows = await sql.query(
    'select id, hash, created_at from drizzle.__drizzle_migrations order by id',
  );
  const maxTs = rows.reduce((m, r) => (Number(r.created_at) > m ? Number(r.created_at) : m), 0);
  console.log(`journal entries: ${entries.length}, last applied created_at: ${maxTs}`);

  const history = verifyHistory(rows, entries);
  if (!history.ok) throw new Refused(history.problem);
  const k = history.applied;
  console.log(
    `verified history: ${k} of ${entries.length} entries match the repository` +
      (k ? ` (idx 0-${k - 1}, through ${entries[k - 1].tag})` : ''),
  );

  for (const e of entries.slice(k)) {
    const stmts = splitStatements(e.text);
    console.log(`applying idx ${e.idx} ${e.tag} (${stmts.length} statements)`);
    await sql.query('BEGIN');
    try {
      // Re-check inside the transaction: the history must still end exactly before this entry.
      const [{ n }] = await sql.query(
        'select count(*)::int as n from drizzle.__drizzle_migrations',
      );
      if (n !== e.idx) {
        throw new Refused(
          `the history changed during the run: ${n} rows recorded, ${e.idx} expected before idx ${e.idx}`,
        );
      }
      for (const s of stmts) await sql.query(s);
      await sql.query(
        'insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)',
        [e.hash, e.when],
      );
      await sql.query('COMMIT');
      appliedThisRun++;
    } catch (err) {
      await sql.query('ROLLBACK');
      if (err instanceof Refused) throw err;
      console.error(`FAILED idx ${e.idx} ${e.tag}: ${err.message.slice(0, 500)}`);
      process.exit(2);
    }
  }
  const count = await sql.query('select count(*) n from drizzle.__drizzle_migrations');
  console.log(`done: applied ${appliedThisRun}, total ${count[0].n}`);
  process.exit(0);
}

const invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invoked && invoked === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    if (e instanceof Refused) {
      console.error(`REFUSED: ${e.message}`);
      console.error(
        `${appliedThisRun ? `${appliedThisRun} migration(s) committed earlier in this run; nothing after them.` : 'Nothing was applied.'} ` +
          'The recorded history must be reconciled before migrating — see ' +
          'docs/runbooks/production-migration.md, Step 0.',
      );
      process.exit(3);
    }
    console.error('migrator error:', e.message);
    process.exit(1);
  });
}
