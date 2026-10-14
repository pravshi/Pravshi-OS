/**
 * WP-A1 operator probe — the authentication pool against a REAL Neon pooler (design §6.2).
 *
 * RUN ONLY AGAINST AN ISOLATED, NON-PRODUCTION Neon project or dev branch, by an operator, with
 * explicit approval. Never production. It opens many pooled connections for a few minutes and so
 * consumes compute on the branch it targets.
 *
 * What it measures, for the run record (docs/runbooks/auth-pool-probe-record.md):
 *   1. role identity — through each POOLED URL, `select session_user` answers app_user, app_auth
 *      and app_worker respectively;
 *   2. the compute's ceiling — max_connections and superuser_reserved_connections, read on the
 *      DIRECT owner connection;
 *   3. load — for k simulated web instances (default 1, 3, 10), 5k business connections (app_user,
 *      the business pool's max of 5 per instance) and 3k authentication connections (app_auth,
 *      AUTH_POOL_MAX = 3 per instance) each loop `begin; select pg_sleep(0.5); commit;` for the
 *      configured duration. Recorded: client errors, connection-acquisition p50 / p95 per role,
 *      and — sampled once a second on the direct owner connection — peak server connections per
 *      role and in total.
 *   It does NOT measure compute hours or auto-suspend: observing the compute would keep it
 *   awake. Those are read in the Neon console afterwards (record template, steps 5–6).
 *
 * Usage (environment only — nothing is read from files, nothing secret is printed):
 *   DATABASE_URL=…            pooled, app_user     (the branch under test)
 *   DATABASE_URL_AUTH=…       pooled, app_auth
 *   DATABASE_URL_WORKER=…     pooled, app_worker
 *   DATABASE_URL_MIGRATE=…    DIRECT, app_owner     (sampling only)
 *   node scripts/ops/auth-pool-probe.mjs --non-production-branch <branch-name> \
 *        [--instances 1,3,10] [--seconds 60]
 *
 * The --non-production-branch flag is a deliberate speed bump: it is printed into the result
 * together with the hosts (never credentials), so the record shows what was targeted.
 */
import { Pool } from '@neondatabase/serverless';
import '../ci/neon-local.mjs'; // inert unless NEON_LOCAL_WSPROXY is set (local dry run only)

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const branch = arg('non-production-branch');
const instances = String(arg('instances', '1,3,10'))
  .split(',')
  .map((n) => Number.parseInt(n, 10))
  .filter((n) => Number.isFinite(n) && n > 0);
const seconds = Number.parseInt(String(arg('seconds', '60')), 10);

const BUSINESS_PER_INSTANCE = 5; // src/lib/db/pool.ts
const AUTH_PER_INSTANCE = 3; // src/lib/db/auth-pool.ts AUTH_POOL_MAX (provisional)

function fail(message) {
  console.error(`auth-pool-probe: ${message}`);
  process.exit(2);
}

if (!branch) fail('refusing to run without --non-production-branch <branch-name>.');
if (/^(main|prod|production)$/i.test(branch)) fail(`'${branch}' looks like production. Refusing.`);
const urls = {
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_URL_AUTH: process.env.DATABASE_URL_AUTH,
  DATABASE_URL_WORKER: process.env.DATABASE_URL_WORKER,
  DATABASE_URL_MIGRATE: process.env.DATABASE_URL_MIGRATE,
};
for (const [name, value] of Object.entries(urls)) if (!value) fail(`${name} is not set.`);
const host = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return '(unparseable)';
  }
};
for (const name of ['DATABASE_URL', 'DATABASE_URL_AUTH', 'DATABASE_URL_WORKER']) {
  if (!host(urls[name]).includes('-pooler')) fail(`${name} must be the POOLED endpoint.`);
}
if (host(urls.DATABASE_URL_MIGRATE).includes('-pooler')) {
  fail('DATABASE_URL_MIGRATE must be the DIRECT endpoint (sampling needs pg_stat_activity).');
}
if (urls.DATABASE_URL_AUTH === urls.DATABASE_URL) fail('DATABASE_URL_AUTH equals DATABASE_URL.');

const percentile = (xs, p) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function identity() {
  const out = {};
  for (const [name, want] of [
    ['DATABASE_URL', 'app_user'],
    ['DATABASE_URL_AUTH', 'app_auth'],
    ['DATABASE_URL_WORKER', 'app_worker'],
  ]) {
    const pool = new Pool({ connectionString: urls[name], max: 1 });
    try {
      const r = await pool.query('select session_user::text as role');
      out[name] = { expected: want, got: r.rows[0].role, ok: r.rows[0].role === want };
    } catch (e) {
      out[name] = { expected: want, error: e?.code ?? e?.name ?? 'error', ok: false };
    } finally {
      await pool.end();
    }
  }
  return out;
}

async function ceiling(owner) {
  const r = await owner.query(
    `select current_setting('max_connections')::int as max_connections,
            current_setting('superuser_reserved_connections')::int as reserved,
            session_user::text as sampled_as,
            pg_has_role(session_user, 'pg_read_all_stats', 'member') as sampler_reads_all_stats`,
  );
  return r.rows[0];
}

async function load(owner, k) {
  const pools = [];
  for (let i = 0; i < k; i += 1) {
    pools.push({
      role: 'app_user',
      pool: new Pool({
        connectionString: urls.DATABASE_URL,
        max: BUSINESS_PER_INSTANCE,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 10_000,
      }),
    });
    pools.push({
      role: 'app_auth',
      pool: new Pool({
        connectionString: urls.DATABASE_URL_AUTH,
        max: AUTH_PER_INSTANCE,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 10_000,
      }),
    });
  }
  const stats = { app_user: { acquire: [], errors: {} }, app_auth: { acquire: [], errors: {} } };
  const peak = { app_user: 0, app_auth: 0, total: 0 };
  const deadline = Date.now() + seconds * 1000;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        // Counted by login, not backend_type: without pg_read_all_stats, other logins' rows are
        // visible but their backend_type is NULL. Background processes have no login.
        const r = await owner.query(
          `select usename::text as u, count(*)::int as n from pg_stat_activity
            where usename is not null group by 1`,
        );
        let total = 0;
        for (const row of r.rows) {
          total += row.n;
          if (row.u in peak) peak[row.u] = Math.max(peak[row.u], row.n);
        }
        peak.total = Math.max(peak.total, total);
      } catch {
        /* sampling is best effort */
      }
      await sleep(1000);
    }
  })();
  const worker = async ({ role, pool }) => {
    while (Date.now() < deadline) {
      const t0 = performance.now();
      let client;
      try {
        client = await pool.connect();
        stats[role].acquire.push(performance.now() - t0);
        await client.query('begin');
        await client.query('select pg_sleep(0.5)');
        await client.query('commit');
      } catch (e) {
        const key = e?.code ?? e?.name ?? 'error';
        stats[role].errors[key] = (stats[role].errors[key] ?? 0) + 1;
      } finally {
        client?.release();
      }
    }
  };
  const loops = [];
  for (const p of pools) {
    const per = p.role === 'app_user' ? BUSINESS_PER_INSTANCE : AUTH_PER_INSTANCE;
    for (let i = 0; i < per; i += 1) loops.push(worker(p));
  }
  await Promise.all(loops);
  sampling = false;
  await sampler;
  await Promise.all(pools.map((p) => p.pool.end()));
  const summarize = (s) => ({
    acquisitions: s.acquire.length,
    p50_ms: percentile(s.acquire, 50),
    p95_ms: percentile(s.acquire, 95),
    errors: s.errors,
  });
  return {
    instances: k,
    clients: { app_user: BUSINESS_PER_INSTANCE * k, app_auth: AUTH_PER_INSTANCE * k },
    app_user: summarize(stats.app_user),
    app_auth: summarize(stats.app_auth),
    peak_server_connections: peak,
  };
}

const owner = new Pool({ connectionString: urls.DATABASE_URL_MIGRATE, max: 1 });
const result = {
  probe: 'WP-A1 auth pool (design §6.2)',
  at: new Date().toISOString(),
  branch,
  hosts: Object.fromEntries(Object.entries(urls).map(([k, v]) => [k, host(v)])),
  pool_sizes: {
    business_per_instance: BUSINESS_PER_INSTANCE,
    auth_per_instance: AUTH_PER_INSTANCE,
  },
  seconds,
};
try {
  result.identity = await identity();
  result.ceiling = await ceiling(owner);
  result.load = [];
  for (const k of instances) result.load.push(await load(owner, k));
} finally {
  await owner.end();
}
console.log(JSON.stringify(result, null, 2));
const identityOk = Object.values(result.identity).every((r) => r.ok);
process.exit(identityOk ? 0 : 1);
