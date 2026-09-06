#!/usr/bin/env node
// PRAVSHI OS — database script runner (Task 3b).
//
// Applies scripts/db/*.sql to a Neon branch and runs the RLS proof. Three properties of
// this runner are load-bearing; scripts/db/README.md and prove-rls-assert.sql both depend
// on them, so read the comments before changing how anything here executes.
//
//   1. ONE plain-TCP session per invocation. `pg.Client`, never a Pool, never the
//      @neondatabase/serverless HTTP driver. A pooled or per-statement-stateless transport
//      makes prove-rls-assert.sql's release assertion pass vacuously on a backend that
//      never had the GUC set.
//   2. Each .sql file is sent as ONE simple-query string with no parameters, so Postgres
//      treats it as an implicit transaction block and the in-file `begin;`/`commit;` do
//      what the file says they do. The file is never split on ';' (the `DO $$ ... $$`
//      bodies contain semicolons) and is never wrapped in a transaction opened here.
//   3. Execution stops at the first error, with a non-zero exit. Continuing past a failure
//      inside the explicit transaction would leave the run looking half-green.
//
// Secrets: every byte written to stdout/stderr — log lines, caught exceptions, stack
// traces, anything a dependency prints — is passed through redact() by construction; see
// installOutputRedaction(). Nothing here ever logs a connection string, host, user, or
// password, and the stream wrapper is what makes that true even for output this file did
// not author.
//
// Usage:
//   node scripts/db/run.mjs --as <role> --file <path.sql> [--createrole-self-grant]
//   node scripts/db/run.mjs --as owner --set-passwords
//   node scripts/db/run.mjs --as owner --verify-roles
//
// <role> is one of: owner (the branch owner from NEON_OWNER_URL), app_owner, app_user,
// app_admin. Non-owner roles reuse the host and database from NEON_OWNER_URL with the
// role's own name and its password from .env.
//
// --createrole-self-grant is required for roles.sql on PG16+ and is explained at
// SELF_GRANT below. It is a privilege grant, so it is never implicit.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const ENV_PATH = fileURLToPath(new URL('../../.env', import.meta.url));
const POOLER = '-pooler';
const ROLE_PASSWORD_KEYS = {
  app_owner: 'APP_OWNER_PASSWORD',
  app_user: 'APP_USER_PASSWORD',
  app_admin: 'APP_ADMIN_PASSWORD',
};

// ------------------------------------------------------------------------------ env

// Deliberately not `dotenv`: this runner reads one file with one shape, and a dependency
// that can execute expansion syntax has no business near a file of database passwords.
export function parseEnv(text) {
  const env = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    env.set(key, value);
  }
  return env;
}

export function loadEnv(path = ENV_PATH) {
  return parseEnv(readFileSync(path, 'utf8'));
}

// ------------------------------------------------------------------------ redaction

const SECRET_KEY = /(URL|PASSWORD|SECRET|TOKEN|KEY|DSN)$/;
const CONNECTION_STRING = /postgres(?:ql)?:\/\/\S*/gi;

// Builds a substring replacer over every secret value in .env plus every component of
// every connection string in it — host, user, password, database — because Postgres and
// node-postgres both embed those in error text on their own, not only inside a URL.
export function buildRedactor(env) {
  const secrets = new Set();
  // Short values would redact common substrings out of ordinary prose; a 6-character
  // floor keeps the output readable without letting any real credential through.
  const add = (value) => {
    if (typeof value === 'string' && value.length >= 6) secrets.add(value);
  };

  for (const [key, value] of env) {
    if (SECRET_KEY.test(key)) add(value);
  }

  for (const [key, value] of env) {
    if (!/URL$/.test(key) || !value.startsWith('postgres')) continue;
    let url;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    add(decodeURIComponent(url.username));
    add(decodeURIComponent(url.password));
    add(url.host);
    add(url.hostname);
    add(url.pathname.replace(/^\//, ''));
    const label = url.hostname.split('.')[0];
    add(label);
    add(label + POOLER);
    add(url.hostname.replace(label, label + POOLER));
  }

  // Longest first, so `neondb_owner` is consumed before `neondb` can eat half of it.
  const ordered = [...secrets].sort((a, b) => b.length - a.length);

  return function redact(input) {
    let text = typeof input === 'string' ? input : String(input);
    for (const secret of ordered) text = text.split(secret).join('[redacted]');
    return text.replace(CONNECTION_STRING, '[redacted]');
  };
}

// Wraps the process's own output streams. This is the "by construction" half of the
// secrets rule: being careful at each call site is not enough, because an exception thrown
// from inside pg, or a stack trace Node prints on its way out, is output this file never
// touched.
export function installOutputRedaction(redact) {
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = (chunk, encoding, callback) => {
      if (typeof encoding === 'function') {
        callback = encoding;
        encoding = undefined;
      }
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return original(redact(text), 'utf8', callback);
    };
  }
}

// ----------------------------------------------------------------------- connection

// A config object rather than a connection string: no percent-encoding round trip for the
// password, and TLS is verified explicitly instead of inheriting whatever `sslmode=require`
// happens to mean to this client version (in libpq it means "encrypt but do not verify").
export function clientConfigFor(role, env) {
  const base = env.get('NEON_OWNER_URL');
  if (!base) throw new Error('NEON_OWNER_URL is missing from .env');

  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error('NEON_OWNER_URL is not a parseable connection string');
  }

  const host = url.hostname;
  if (host.includes(POOLER)) {
    throw new Error(
      'NEON_OWNER_URL points at a pooled host. Every script here needs one real session ' +
        'for the whole file; use the direct endpoint (no "-pooler" in the host).',
    );
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error('NEON_OWNER_URL has no database name');

  let user;
  let password;
  if (role === 'owner') {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    if (!user || !password) throw new Error('NEON_OWNER_URL has no user or no password');
  } else {
    const key = ROLE_PASSWORD_KEYS[role];
    if (!key) throw new Error(`unknown role "${role}"`);
    user = role;
    password = env.get(key);
    if (!password) throw new Error(`${key} is missing from .env`);
  }

  return {
    host,
    port: Number(url.port) || 5432,
    user,
    password,
    database,
    ssl: { rejectUnauthorized: true, servername: host },
    application_name: 'pravshi-db-runner',
  };
}

// ------------------------------------------------------------------------- commands

// Requirement 8. The ownership assertion in prove-rls-assert.sql does not exclude
// pg_temp_*, so a temp table created earlier on this session would trip it as a false
// alarm. This runner never creates one; the guard proves that rather than asserting it.
async function assertNoVisibleTempRelations(client) {
  const { rows } = await client.query(
    "select count(*)::int as n from pg_class where relpersistence = 't' and pg_table_is_visible(oid)",
  );
  if (rows[0].n !== 0) {
    throw new Error(
      `this session already has ${rows[0].n} visible temp relation(s); the ownership assertion would misfire`,
    );
  }
}

// PG16+ splits role membership into ADMIN / INHERIT / SET. A CREATEROLE non-superuser that
// creates a role is auto-granted ADMIN OPTION on it and nothing else, and `roles.sql` needs
// both of the other two on `app_owner`:
//
//   - `create schema ... authorization app_owner` and `alter schema public owner to
//     app_owner` call check_can_set_role(), which needs the SET option;
//   - `alter default privileges for role app_owner` and `revoke create on schema public`
//     (once app_owner owns it) call has_privs_of_role(), which needs INHERIT.
//
// `roles.sql` is one implicit transaction, so a grant issued after a failed run is rolled
// back with the roles it would have applied to — the memberships have to exist the moment
// the roles do. `createrole_self_grant` is Postgres's own mechanism for exactly that: it
// makes the auto-grant include SET and INHERIT. It is session-scoped here, applies only to
// roles created later in this same session, and grants the EXECUTING role membership in the
// roles it creates — it never grants anything to app_user.
const SELF_GRANT = "set createrole_self_grant = 'set, inherit'";

async function runFile(client, filePath, { createroleSelfGrant = false } = {}) {
  const sql = readFileSync(filePath, 'utf8');
  await assertNoVisibleTempRelations(client);
  if (createroleSelfGrant) {
    console.log(`  PRIVILEGE GRANT (session-scoped): ${SELF_GRANT}`);
    await client.query(SELF_GRANT);
  }
  console.log(`  executing ${filePath} as one simple-query string (${sql.length} bytes)`);
  // No parameters => node-postgres uses the simple query protocol => Postgres runs the
  // whole file as one implicit transaction block. Do not add a second argument here, do
  // not split this string, and do not put a begin/commit around it.
  const results = await client.query(sql);
  const list = Array.isArray(results) ? results : [results];
  console.log(`  ok — ${list.length} result(s), no exception raised`);
  for (const result of list) {
    if (result?.rows?.length) console.log(`  rows: ${JSON.stringify(result.rows)}`);
  }
}

async function setPasswords(client, env) {
  for (const [role, key] of Object.entries(ROLE_PASSWORD_KEYS)) {
    const password = env.get(key);
    if (!password) throw new Error(`${key} is missing from .env`);
    // Postgres does the quoting. The password is never interpolated into DDL by hand and
    // never appears in any string this file builds.
    const { rows } = await client.query(
      "select format('alter role %I password %L', $1::text, $2::text) as ddl",
      [role, password],
    );
    await client.query(rows[0].ddl);
    console.log(`  ${role}: password set (length ${password.length})`);
  }
}

// Roles whose attributes and ownership this check actually gates. `neon_superuser` and the
// connecting branch owner (`current_user`) are printed for context only — their attributes are
// fixed by Neon (the branch owner needs BYPASSRLS-adjacent privileges to administer the branch;
// see README) and are not something this project controls or can correct, so a nonzero reading
// on either of those two is informational, not a violation.
const GATED_ROLES = new Set(['app_owner', 'app_user', 'app_admin']);

async function verifyRoles(client) {
  // Violations are collected rather than thrown immediately, so a single run prints every
  // check's detail before the process dies — an operator (or a CI log) then sees the full
  // picture in one pass instead of fixing one failure only to hit the next on a re-run.
  const violations = [];

  const attrs = await client.query(
    `select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin, rolinherit
       from pg_roles
      where rolname in ('app_owner', 'app_user', 'app_admin', 'neon_superuser', current_user)
      order by rolname`,
  );
  console.log('  role attributes:');
  for (const r of attrs.rows) {
    console.log(
      `    ${r.rolname}: super=${r.rolsuper} bypassrls=${r.rolbypassrls} ` +
        `createrole=${r.rolcreaterole} createdb=${r.rolcreatedb} ` +
        `login=${r.rolcanlogin} inherit=${r.rolinherit}`,
    );
  }
  // roles.sql asserts this once, at creation time. This re-checks it at whatever later moment
  // --verify-roles is run, because these attributes can be changed afterwards (e.g. through the
  // Neon console) without roles.sql ever running again. BYPASSRLS/SUPERUSER defeat RLS directly;
  // CREATEROLE/CREATEDB are privilege-escalation surface these three roles have no legitimate
  // reason to hold, mirroring roles.sql's own defense-in-depth assertion.
  for (const r of attrs.rows) {
    if (!GATED_ROLES.has(r.rolname)) continue;
    const bad = [];
    if (r.rolsuper) bad.push('SUPERUSER');
    if (r.rolbypassrls) bad.push('BYPASSRLS');
    if (r.rolcreaterole) bad.push('CREATEROLE');
    if (r.rolcreatedb) bad.push('CREATEDB');
    if (bad.length) violations.push(`${r.rolname} holds ${bad.join(', ')}`);
  }

  const owned = await client.query(
    `select coalesce(n.nspname, '?') as schema, c.relname, c.relkind
       from pg_class c
       left join pg_namespace n on n.oid = c.relnamespace
      where c.relowner = 'app_user'::regrole
      order by 1, 2`,
  );
  console.log(`  relations owned by app_user: ${owned.rowCount}`);
  for (const r of owned.rows) console.log(`    ${r.schema}.${r.relname} (${r.relkind})`);
  // app_user must never own a relation: Postgres does not enforce RLS against a relation's
  // owner unless it is FORCE'd, so ownership is a direct bypass, not merely undesirable.
  if (owned.rowCount !== 0) {
    violations.push(`app_user owns ${owned.rowCount} relation(s)`);
  }

  // Requirement 7. Attributes are NOT inherited through membership, so neither roles.sql's
  // assertion nor assertion 5 of the proof would see a BYPASSRLS role reachable by SET ROLE.
  const members = await client.query(
    `select m.roleid::regrole::text as granted_role,
            m.admin_option,
            g.rolsuper as granted_role_is_super,
            g.rolbypassrls as granted_role_bypasses_rls
       from pg_auth_members m
       join pg_roles g on g.oid = m.roleid
      where m.member = 'app_user'::regrole`,
  );
  console.log(`  memberships held by app_user: ${members.rowCount} (requirement 7 wants 0)`);
  for (const r of members.rows) {
    console.log(
      `    -> ${r.granted_role}: admin_option=${r.admin_option} ` +
        `super=${r.granted_role_is_super} bypassrls=${r.granted_role_bypasses_rls}`,
    );
  }
  // This is the check that closes the SET ROLE path the ownership assertion (assertion 6 of
  // prove-rls-assert.sql) cannot reach by design: ownership follows role membership with
  // inheritance, not name equality, so any membership at all — not just one flagged bypassrls
  // or super above — is one `SET ROLE` away from owner-equivalence. A nonzero count here must
  // fail the run; printing it and continuing would be a false pass at the one point requirement
  // 7 exists to cover.
  if (members.rowCount !== 0) {
    violations.push(`app_user holds membership in ${members.rowCount} role(s)`);
  }

  const schemas = await client.query(
    `select nspname, pg_get_userbyid(nspowner) as owner
       from pg_namespace
      where nspname in ('public', 'authz')
      order by nspname`,
  );
  console.log('  schema owners:');
  for (const r of schemas.rows) console.log(`    ${r.nspname}: ${r.owner}`);

  const probe = await client.query(
    "select count(*)::int as n from pg_class where relname = '_rls_probe'",
  );
  console.log(`  _rls_probe relations present: ${probe.rows[0].n}`);

  if (violations.length) {
    throw new Error(
      `--verify-roles found ${violations.length} violation(s): ${violations.join('; ')}`,
    );
  }
}

// ----------------------------------------------------------------------------- main

function parseArgs(argv) {
  const args = {
    role: null,
    file: null,
    setPasswords: false,
    verifyRoles: false,
    createroleSelfGrant: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--as') {
      i += 1;
      args.role = argv[i];
    } else if (arg === '--file') {
      i += 1;
      args.file = argv[i];
    } else if (arg === '--createrole-self-grant') {
      args.createroleSelfGrant = true;
    } else if (arg === '--set-passwords') {
      args.setPasswords = true;
    } else if (arg === '--verify-roles') {
      args.verifyRoles = true;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return args;
}

async function main() {
  const env = loadEnv();
  installOutputRedaction(buildRedactor(env));

  const args = parseArgs(process.argv.slice(2));
  if (!args.role) throw new Error('--as <owner|app_owner|app_user|app_admin> is required');
  const actions = [args.file, args.setPasswords, args.verifyRoles].filter(Boolean).length;
  if (actions !== 1) throw new Error('give exactly one of --file, --set-passwords, --verify-roles');
  if (args.createroleSelfGrant && !args.file) {
    throw new Error('--createrole-self-grant only applies to --file');
  }

  const config = clientConfigFor(args.role, env);
  // Derived facts only — never the values themselves.
  console.log(
    `connecting as ${args.role} (host contains "${POOLER}": ${config.host.includes(POOLER)})`,
  );

  // One Client. Not a Pool. One session for the whole invocation.
  const client = new pg.Client(config);
  client.on('notice', (n) => console.log(`  NOTICE: ${n.severity}: ${n.message}`));

  await client.connect();
  try {
    const who = await client.query('select current_user, session_user, version()');
    console.log(
      `  session_user=${who.rows[0].session_user} current_user=${who.rows[0].current_user}`,
    );
    console.log(`  server: ${who.rows[0].version.split(' on ')[0]}`);

    if (args.file) {
      await runFile(client, args.file, { createroleSelfGrant: args.createroleSelfGrant });
    } else if (args.setPasswords) {
      await setPasswords(client, env);
    } else {
      await verifyRoles(client);
    }
  } finally {
    await client.end();
  }
}

// Stop at the first error, non-zero exit, redacted. Every field Postgres populates on an
// error is printed explicitly because `message` alone often omits the useful part.
function reportAndExit(error) {
  console.error('FAILED');
  for (const field of ['message', 'code', 'severity', 'detail', 'hint', 'where', 'position']) {
    const value = error?.[field];
    if (value !== undefined && value !== null && value !== '') {
      console.error(`  ${field}: ${value}`);
    }
  }
  if (error?.stack) console.error(String(error.stack));
  process.exit(1);
}

// Only when run as a script. The helpers above are exported so they can be exercised
// directly — importing this file must not open a connection.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on('uncaughtException', reportAndExit);
  process.on('unhandledRejection', reportAndExit);
  await main().catch(reportAndExit);
}
