/**
 * WebSocket-based migration runner that replicates drizzle-kit's migrate logic
 * exactly, for environments where the `pg` driver's direct TCP is unavailable.
 *
 * Logic (from drizzle-orm pg-core dialect):
 *  1. Read drizzle/meta/_journal.json.
 *  2. Get max(created_at) from drizzle.__drizzle_migrations.
 *  3. For each journal entry with when > max(created_at): split the SQL file
 *     into statements (dollar-quote-aware), run each in a transaction, then
 *     record (sha256(file), when).
 *
 * Usage: node scripts/migrate-ws.mjs
 * Requires: DATABASE_URL_MIGRATE in environment (direct URL; the neon
 * serverless driver tunnels over WebSocket).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

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

async function main() {
  const url = process.env.DATABASE_URL_MIGRATE;
  if (!url) throw new Error('DATABASE_URL_MIGRATE is required');
  const sql = neon(url);

  const journal = JSON.parse(
    fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8'),
  );
  const last = await sql.query(
    'select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1',
  );
  const lastTs = last.length ? Number(last[0].created_at) : 0;
  console.log(`journal entries: ${journal.entries.length}, last applied created_at: ${lastTs}`);

  let applied = 0;
  for (const e of journal.entries) {
    if (!(lastTs < e.when)) continue;
    const file = path.join(root, 'drizzle', `${e.tag}.sql`);
    const text = fs.readFileSync(file, 'utf8');
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    const stmts = splitStatements(text);
    console.log(`applying idx ${e.idx} ${e.tag} (${stmts.length} statements)`);
    await sql.query('BEGIN');
    try {
      for (const s of stmts) await sql.query(s);
      await sql.query(
        'insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)',
        [hash, String(e.when)],
      );
      await sql.query('COMMIT');
      applied++;
    } catch (err) {
      await sql.query('ROLLBACK');
      console.error(`FAILED idx ${e.idx} ${e.tag}: ${err.message.slice(0, 500)}`);
      process.exit(2);
    }
  }
  const count = await sql.query('select count(*) n from drizzle.__drizzle_migrations');
  console.log(`done: applied ${applied}, total ${count[0].n}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('migrator error:', e.message);
  process.exit(1);
});
