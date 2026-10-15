/**
 * WP-A1 operator probe — the authentication pool against a REAL Neon pooler (design §6.2).
 *
 * RUN ONLY AGAINST AN ISOLATED, NON-PRODUCTION Neon project or dev branch, by an operator, with
 * explicit approval. Never production. It opens many pooled connections for a few minutes and so
 * consumes compute on the branch it targets. Procedure: docs/runbooks/auth-pool-probe.md.
 *
 * What it measures, for the run record (docs/runbooks/auth-pool-probe-record.md):
 *   1. identity — each URL logs in as its own role: through each POOLED URL `session_user` is
 *      app_user, app_auth and app_worker; through the DIRECT URL it is app_owner. Every role has
 *      no SUPERUSER, BYPASSRLS, CREATEROLE or CREATEDB, and the three runtime roles are members of
 *      no other role. Any mismatch fails the run and the load phases are skipped;
 *   2. the compute's ceiling — max_connections and superuser_reserved_connections, read on the
 *      DIRECT owner connection;
 *   3. load — for k simulated web instances (default 1, 3, 10), k × business-per-instance
 *      connections as app_user and k × auth-per-instance connections as app_auth each loop
 *      `begin; select pg_sleep(0.5); commit;` for the configured duration. Each phase reports its
 *      own status: client errors (connection, acquisition or query), connection-acquisition
 *      p50 / p95 per role, and — sampled once a second on the direct owner connection — peak
 *      server connections per role and in total, checked against the acceptance thresholds.
 *   It does NOT measure compute hours or auto-suspend: observing the compute would keep it
 *   awake. Those are read in the Neon console afterwards.
 *
 * Every statement it sends is read-only: session_user / pg_roles / pg_auth_members /
 * current_setting / pg_stat_activity reads, and empty transactions around pg_sleep. It creates,
 * changes and deletes nothing.
 *
 * Usage (environment only — nothing is read from files; credentials, usernames, query parameters
 * and full hostnames are never printed; endpoint IDs are printed masked):
 *   DATABASE_URL=…            pooled, app_user     (the branch under test)
 *   DATABASE_URL_AUTH=…       pooled, app_auth
 *   DATABASE_URL_WORKER=…     pooled, app_worker
 *   DATABASE_URL_MIGRATE=…    DIRECT, app_owner     (identity, ceiling and sampling)
 *   node scripts/ops/auth-pool-probe.mjs --non-production-branch <branch-name> \
 *        --expect-endpoint <endpoint ID from the Neon console> \
 *        [--instances 1,3,10] [--seconds 60] [--auth-per-instance 3] [--business-per-instance 5]
 *
 * The four URLs must name the same Neon endpoint (the pooled and direct hostnames of one compute)
 * and the same database, and that endpoint must be the one the operator confirmed in the console
 * and passed as --expect-endpoint. NEON_LOCAL_WSPROXY and NEON_LOCAL_PG_ADDRESS must both be
 * unset: either one sends every connection to a local Postgres instead (scripts/ci/neon-local.mjs),
 * which would prove nothing about Neon's pooler.
 *
 * --local-dry-run exercises the probe against a local Postgres through wsproxy (it REQUIRES
 * NEON_LOCAL_WSPROXY). It never contacts Neon, never reports a Neon verification, and never exits 0.
 *
 * Output: one JSON document on stdout — including when a run fails midway or is refused.
 * Exit codes:
 *   0  NEON_VERIFIED       a real Neon run: identity passed AND every load phase passed
 *   1  failed              identity failed, a load phase failed, or the run stopped midway
 *   2  REFUSED             a precondition failed; nothing was connected
 *   3  LOCAL_DRY_RUN_ONLY  a local dry run completed; no Neon verification happened
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const EXIT = { VERIFIED: 0, FAILED: 1, REFUSED: 2, LOCAL_DRY_RUN: 3 };

export const LOCAL_PROXY_VARS = ['NEON_LOCAL_WSPROXY', 'NEON_LOCAL_PG_ADDRESS'];

/** The four connections, the login each must authenticate as, and the endpoint form each uses. */
export const TARGETS = [
  { name: 'DATABASE_URL', role: 'app_user', endpoint: 'pooled', runtime: true },
  { name: 'DATABASE_URL_AUTH', role: 'app_auth', endpoint: 'pooled', runtime: true },
  { name: 'DATABASE_URL_WORKER', role: 'app_worker', endpoint: 'pooled', runtime: true },
  { name: 'DATABASE_URL_MIGRATE', role: 'app_owner', endpoint: 'direct', runtime: false },
];

const KNOWN_ROLES = new Set(TARGETS.map((t) => t.role));
const POOLER_SUFFIX = '-pooler';
const PRODUCTION_LIKE = /^(main|prod|production)$/i;
const ENDPOINT_ID = /^ep-[a-z0-9-]+$/;

// src/lib/db/pool.ts (max 5 per instance) and src/lib/db/auth-pool.ts (AUTH_POOL_MAX = 3).
export const DEFAULTS = {
  instances: [1, 3, 10],
  seconds: 60,
  authPerInstance: 3,
  businessPerInstance: 5,
};
const LIMITS = { instances: 50, seconds: 600, authPerInstance: 20, businessPerInstance: 50 };

// ─────────────────────────────────────────────────────────────── arguments

const VALUE_FLAGS = new Set([
  'non-production-branch',
  'expect-endpoint',
  'instances',
  'seconds',
  'auth-per-instance',
  'business-per-instance',
]);
const BOOLEAN_FLAGS = new Set(['local-dry-run']);

const positiveInt = (raw, max) => {
  if (!/^\d+$/.test(String(raw))) return null;
  const n = Number.parseInt(String(raw), 10);
  return n >= 1 && n <= max ? n : null;
};

/** Parse the command line. Unknown flags and malformed values are errors: the probe fails closed. */
export function parseArgs(argv) {
  const errors = [];
  const raw = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const name = typeof token === 'string' && token.startsWith('--') ? token.slice(2) : null;
    if (name !== null && BOOLEAN_FLAGS.has(name)) {
      raw[name] = true;
    } else if (name !== null && VALUE_FLAGS.has(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        errors.push(`--${name} needs a value.`);
      } else {
        raw[name] = value;
        i += 1;
      }
    } else {
      errors.push(`unknown argument ${name !== null ? `--${name}` : '(positional)'}.`);
    }
  }

  const options = {
    branch: raw['non-production-branch'] ?? null,
    expectEndpoint: raw['expect-endpoint'] ?? null,
    localDryRun: raw['local-dry-run'] === true,
    instances: DEFAULTS.instances,
    seconds: DEFAULTS.seconds,
    authPerInstance: DEFAULTS.authPerInstance,
    businessPerInstance: DEFAULTS.businessPerInstance,
  };
  if (raw.instances !== undefined) {
    const list = String(raw.instances)
      .split(',')
      .map((n) => positiveInt(n.trim(), LIMITS.instances));
    if (list.length === 0 || list.some((n) => n === null)) {
      errors.push(
        `--instances must be a comma-separated list of whole numbers 1–${LIMITS.instances}.`,
      );
    } else {
      options.instances = list;
    }
  }
  for (const [flag, key] of [
    ['seconds', 'seconds'],
    ['auth-per-instance', 'authPerInstance'],
    ['business-per-instance', 'businessPerInstance'],
  ]) {
    if (raw[flag] === undefined) continue;
    const n = positiveInt(raw[flag], LIMITS[key]);
    if (n === null) errors.push(`--${flag} must be a whole number 1–${LIMITS[key]}.`);
    else options[key] = n;
  }
  return { options, errors };
}

// ─────────────────────────────────────────────────────────────── endpoints

/** `ep-…` + the last four characters: enough to compare with the console, not enough to publish. */
export function maskEndpoint(id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  if (id.length <= 8) return '…';
  return `${id.slice(0, 3)}…${id.slice(-4)}`;
}

/** The pooled and direct forms of one endpoint name the same ID: strip the pooler suffix. */
export function normalizeEndpointId(value) {
  const v = String(value).trim().toLowerCase();
  return v.endsWith(POOLER_SUFFIX) ? v.slice(0, -POOLER_SUFFIX.length) : v;
}

/** Everything the checks need from a URL. Internal: none of these values is ever printed raw. */
export function describeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return null;
  let username;
  try {
    username = decodeURIComponent(u.username);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const dot = host.indexOf('.');
  const label = dot === -1 ? host : host.slice(0, dot);
  return {
    pooled: label.endsWith(POOLER_SUFFIX),
    endpointId: normalizeEndpointId(label),
    domain: dot === -1 ? '' : host.slice(dot + 1),
    port: u.port,
    database: u.pathname.replace(/^\//, ''),
    username,
  };
}

const isNeonDomain = (domain) => domain === 'neon.tech' || domain.endsWith('.neon.tech');

/**
 * Every precondition, checked before anything connects. Reasons name variables and expectations,
 * never values: no password, username, query parameter, full hostname or unmasked endpoint ID.
 */
export function validateEnvironment(env, options) {
  const reasons = [];
  const mode = options.localDryRun ? 'local-dry-run' : 'neon';
  const setProxyVars = LOCAL_PROXY_VARS.filter((v) => env[v] !== undefined);

  if (mode === 'neon') {
    for (const v of setProxyVars) {
      reasons.push(
        `${v} is set: it would send every connection to a local Postgres instead of Neon. ` +
          'Unset it (or use --local-dry-run, which never verifies Neon).',
      );
    }
  } else if (!env.NEON_LOCAL_WSPROXY) {
    reasons.push(
      '--local-dry-run requires NEON_LOCAL_WSPROXY (a local wsproxy): a dry run never contacts Neon.',
    );
  }

  if (!options.branch)
    reasons.push('refusing to run without --non-production-branch <branch-name>.');
  else if (PRODUCTION_LIKE.test(options.branch)) {
    reasons.push('--non-production-branch looks like production. Refusing.');
  }

  const parsed = {};
  for (const t of TARGETS) {
    const value = env[t.name];
    if (!value) {
      reasons.push(`${t.name} is not set.`);
      continue;
    }
    const d = describeUrl(value);
    if (!d) {
      reasons.push(`${t.name} is not a postgres:// connection string.`);
      continue;
    }
    if (d.username !== t.role) reasons.push(`${t.name} must log in as ${t.role}.`);
    if (t.endpoint === 'pooled' && !d.pooled) {
      reasons.push(`${t.name} must be the POOLED endpoint (hostname label ending in -pooler).`);
    }
    if (t.endpoint === 'direct' && d.pooled) {
      reasons.push(`${t.name} must be the DIRECT endpoint (sampling needs pg_stat_activity).`);
    }
    parsed[t.name] = d;
  }
  if (env.DATABASE_URL_AUTH && env.DATABASE_URL_AUTH === env.DATABASE_URL) {
    reasons.push('DATABASE_URL_AUTH equals DATABASE_URL.');
  }

  const all = TARGETS.map((t) => parsed[t.name]).filter(Boolean);
  const first = all[0];
  let endpointId = null;
  if (all.length === TARGETS.length && first) {
    const key = (d) => `${d.endpointId}.${d.domain}:${d.port}`;
    if (all.some((d) => key(d) !== key(first))) {
      reasons.push(
        'the four URLs do not name the same endpoint (compare the pooled and direct hostnames ' +
          'of ONE compute in the Neon console).',
      );
    } else {
      endpointId = first.endpointId;
    }
    if (all.some((d) => d.database !== first.database)) {
      reasons.push('the four URLs do not name the same database.');
    }
  }

  let expectedMatches = null;
  if (mode === 'neon' && endpointId !== null && first) {
    if (!isNeonDomain(first.domain))
      reasons.push('the URLs do not name a Neon host (*.neon.tech).');
    if (!ENDPOINT_ID.test(endpointId)) {
      reasons.push('the endpoint ID is not in Neon form (ep-…).');
    }
  }
  if (options.expectEndpoint) {
    const expected = normalizeEndpointId(options.expectEndpoint);
    if (endpointId !== null) {
      expectedMatches = expected === endpointId;
      if (!expectedMatches) {
        reasons.push(
          `--expect-endpoint (${maskEndpoint(expected)}) does not match the URLs' endpoint ` +
            `(${maskEndpoint(endpointId)}).`,
        );
      }
    }
  } else if (mode === 'neon') {
    reasons.push(
      'refusing without --expect-endpoint <endpoint ID> — read it in the Neon console for the ' +
        'non-production branch and pass it here.',
    );
  }

  return {
    ok: reasons.length === 0,
    reasons,
    mode,
    target: {
      endpoint: maskEndpoint(endpointId),
      expected_endpoint: maskEndpoint(
        options.expectEndpoint ? normalizeEndpointId(options.expectEndpoint) : null,
      ),
      endpoint_matches_expected: expectedMatches,
      domain: first && endpointId !== null ? first.domain : null,
      urls: Object.fromEntries(
        TARGETS.map((t) => [t.name, { endpoint: t.endpoint, login: t.role }]),
      ),
    },
  };
}

// ─────────────────────────────────────────────────────────────── errors

/** A short, safe label for an error: its SQLSTATE or errno code, else its class. Never its message. */
export function errorCode(e) {
  const code = e?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_]{2,40}$/.test(code)) return code;
  // pg-pool reports an exhausted acquisition wait only in its message; classify, never print it.
  if (typeof e?.message === 'string' && /timeout/i.test(e.message)) return 'TIMEOUT';
  const name = e?.name;
  if (typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name)) return name;
  return 'error';
}

// ─────────────────────────────────────────────────────────────── probe

const IDENTITY_SQL = `select session_user::text as role,
       r.rolsuper as superuser, r.rolbypassrls as bypass_rls,
       r.rolcreaterole as create_role, r.rolcreatedb as create_db,
       (select count(*)::int from pg_auth_members m where m.member = r.oid) as member_of
  from pg_roles r where r.rolname = session_user`;

const CEILING_SQL = `select current_setting('max_connections')::int as max_connections,
       current_setting('superuser_reserved_connections')::int as reserved,
       pg_has_role(session_user, 'pg_read_all_stats', 'member') as sampler_reads_all_stats`;

// Counted by login, not backend_type: without pg_read_all_stats, other logins' rows are visible
// but their backend_type is NULL. Background processes have no login.
const ACTIVITY_SQL = `select usename::text as u, count(*)::int as n from pg_stat_activity
  where usename is not null group by 1`;

const percentile = (xs, p) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};

const endQuietly = async (pool) => {
  try {
    await pool.end();
  } catch {
    /* closing is best effort; the result already records what happened */
  }
};

async function identity(env, Pool) {
  const out = {};
  for (const t of TARGETS) {
    const pool = new Pool({ connectionString: env[t.name], max: 1 });
    const entry = { expected: t.role, ok: false };
    try {
      const r = await pool.query(IDENTITY_SQL);
      const row = r.rows[0];
      if (!row) {
        entry.error = 'NO_ROLE_ROW';
      } else {
        // A role name that is not one of ours is reported only as "another role".
        entry.got = KNOWN_ROLES.has(row.role) ? row.role : '(another role)';
        entry.login_ok = row.role === t.role;
        entry.attributes = {
          superuser: row.superuser === true,
          bypass_rls: row.bypass_rls === true,
          create_role: row.create_role === true,
          create_db: row.create_db === true,
        };
        entry.attributes_ok = Object.values(entry.attributes).every((v) => v === false);
        if (t.runtime) {
          entry.member_of_other_roles = Number(row.member_of);
          entry.membership_ok = entry.member_of_other_roles === 0;
        }
        entry.ok =
          entry.login_ok && entry.attributes_ok && (t.runtime ? entry.membership_ok : true);
      }
    } catch (e) {
      entry.error = errorCode(e);
    } finally {
      await endQuietly(pool);
    }
    out[t.name] = entry;
  }
  return out;
}

async function load(env, owner, k, options, ceiling, baseline, deps) {
  const per = { app_user: options.businessPerInstance, app_auth: options.authPerInstance };
  const url = { app_user: env.DATABASE_URL, app_auth: env.DATABASE_URL_AUTH };
  const pools = [];
  for (let i = 0; i < k; i += 1) {
    for (const role of ['app_user', 'app_auth']) {
      pools.push({
        role,
        pool: new deps.Pool({
          connectionString: url[role],
          max: per[role],
          idleTimeoutMillis: 10_000,
          connectionTimeoutMillis: 10_000,
        }),
      });
    }
  }
  const stats = { app_user: { acquire: [], errors: {} }, app_auth: { acquire: [], errors: {} } };
  const peak = { app_user: 0, app_auth: 0, total: 0 };
  const sampling = { samples: 0, errors: 0 };
  const count = (role, stage, e) => {
    const key = `${stage}:${errorCode(e)}`;
    stats[role].errors[key] = (stats[role].errors[key] ?? 0) + 1;
  };
  const deadline = deps.now() + deps.phaseMs;
  let running = true;
  const sampler = (async () => {
    while (running) {
      try {
        const r = await owner.query(ACTIVITY_SQL);
        let total = 0;
        for (const row of r.rows) {
          total += row.n;
          if (row.u in peak) peak[row.u] = Math.max(peak[row.u], row.n);
        }
        peak.total = Math.max(peak.total, total);
        sampling.samples += 1;
      } catch {
        sampling.errors += 1;
      }
      await deps.sleep(deps.sampleIntervalMs);
    }
  })();
  const worker = async ({ role, pool }) => {
    while (deps.now() < deadline) {
      const t0 = deps.perfNow();
      let client;
      try {
        client = await pool.connect();
      } catch (e) {
        count(role, 'acquire', e);
        await deps.sleep(100); // a failing pool must not spin
        continue;
      }
      stats[role].acquire.push(deps.perfNow() - t0);
      try {
        await client.query('begin');
        await client.query('select pg_sleep(0.5)');
        await client.query('commit');
      } catch (e) {
        count(role, 'query', e);
      } finally {
        client.release();
      }
    }
  };
  const loops = [];
  for (const p of pools) for (let i = 0; i < per[p.role]; i += 1) loops.push(worker(p));
  try {
    await Promise.all(loops);
  } finally {
    running = false;
    await sampler;
    await Promise.all(pools.map((p) => endQuietly(p.pool)));
  }

  const summarize = (s) => ({
    acquisitions: s.acquire.length,
    p50_ms: percentile(s.acquire, 50),
    p95_ms: percentile(s.acquire, 95),
    errors: s.errors,
  });
  const app_user = summarize(stats.app_user);
  const app_auth = summarize(stats.app_auth);
  const noErrors =
    Object.keys(app_user.errors).length === 0 && Object.keys(app_auth.errors).length === 0;
  const ceilingFree = ceiling.max_connections - ceiling.reserved;
  let p95Check = 'NOT_EVALUATED';
  if (k === 1) p95Check = 'BASELINE';
  else if (baseline !== null && app_auth.p95_ms !== null) {
    p95Check = app_auth.p95_ms <= baseline + 200 ? 'PASS' : 'FAIL';
  }
  const checks = {
    no_client_errors: noErrors ? 'PASS' : 'FAIL',
    sampled: sampling.samples > 0 ? 'PASS' : 'FAIL',
    peak_total_below_max_minus_reserved:
      sampling.samples === 0 ? 'FAIL' : peak.total < ceilingFree ? 'PASS' : 'FAIL',
    app_auth_p95_within_single_instance_plus_200ms: p95Check,
    // Neon's per-role pooler limit is not readable from Postgres: the operator compares
    // peak_server_connections.app_auth with the documented value and records it.
    app_auth_peak_within_documented_pool_size: 'MANUAL',
  };
  return {
    instances: k,
    status: Object.values(checks).includes('FAIL') ? 'FAIL' : 'PASS',
    clients: { app_user: per.app_user * k, app_auth: per.app_auth * k },
    app_user,
    app_auth,
    peak_server_connections: peak,
    sampling,
    checks,
  };
}

/**
 * Runs the stages in order and always returns a complete, safe result — with the stage it stopped
 * at and a sanitized error code when something throws midway.
 */
export async function runProbe(env, options, check, deps) {
  const d = {
    now: () => Date.now(),
    perfNow: () => performance.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    sampleIntervalMs: 1000,
    phaseMs: options.seconds * 1000,
    clock: () => new Date().toISOString(),
    ...deps,
  };
  const dryRun = check.mode === 'local-dry-run';
  const result = {
    probe: 'WP-A1 auth pool (design §6.2)',
    mode: dryRun ? 'LOCAL_DRY_RUN' : 'NEON',
    neon_verification: dryRun ? 'NOT_PERFORMED' : 'ATTEMPTED',
    neon_pooler_verified: false,
    status: 'RUNNING',
    at: d.clock(),
    branch: options.branch,
    target: check.target,
    pool_sizes: {
      business_per_instance: options.businessPerInstance,
      auth_per_instance: options.authPerInstance,
    },
    seconds: options.seconds,
    identity_status: 'NOT_RUN',
    load_status: 'NOT_RUN',
  };

  let stage = 'identity';
  const owner = new d.Pool({ connectionString: env.DATABASE_URL_MIGRATE, max: 1 });
  let localOk = false;
  try {
    result.identity = await identity(env, d.Pool);
    const identityOk = Object.values(result.identity).every((r) => r.ok);
    result.identity_status = identityOk ? 'PASS' : 'FAIL';
    if (!identityOk) {
      result.load_status = 'SKIPPED';
      result.status = 'IDENTITY_FAILED';
    } else {
      stage = 'ceiling';
      const r = await owner.query(CEILING_SQL);
      result.ceiling = r.rows[0];
      result.load = [];
      let baseline = null;
      for (const k of options.instances) {
        stage = `load:${k}`;
        const phase = await load(env, owner, k, options, result.ceiling, baseline, d);
        if (k === 1) baseline = phase.app_auth.p95_ms;
        result.load.push(phase);
      }
      result.load_status = result.load.every((p) => p.status === 'PASS') ? 'PASS' : 'FAIL';
      result.status = result.load_status === 'PASS' ? 'NEON_VERIFIED' : 'LOAD_FAILED';
      localOk = result.load_status === 'PASS';
    }
  } catch (e) {
    result.status = 'FAILED_MIDWAY';
    result.failed_stage = stage;
    result.error = errorCode(e);
    if (result.load_status === 'NOT_RUN' && result.identity_status === 'PASS') {
      result.load_status = 'INCOMPLETE';
    }
  } finally {
    await endQuietly(owner);
  }

  if (dryRun) {
    // A dry run never reports a Neon result: its own outcome is kept under local_result.
    result.local_result = result.status === 'NEON_VERIFIED' ? 'PASS' : result.status;
    result.status = 'LOCAL_DRY_RUN_ONLY';
    result.neon_pooler_verified = false;
    result.exit_code = localOk ? EXIT.LOCAL_DRY_RUN : EXIT.FAILED;
  } else {
    result.neon_verification = 'PERFORMED';
    result.neon_pooler_verified = result.status === 'NEON_VERIFIED';
    result.exit_code = result.neon_pooler_verified ? EXIT.VERIFIED : EXIT.FAILED;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────── entry point

export async function main(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => process.stderr.write(`${s}\n`));
  const { options, errors } = parseArgs(argv);
  const check = errors.length === 0 ? validateEnvironment(env, options) : null;
  if (!check || !check.ok) {
    const reasons = check ? check.reasons : errors;
    out(
      JSON.stringify(
        {
          probe: 'WP-A1 auth pool (design §6.2)',
          mode: options.localDryRun ? 'LOCAL_DRY_RUN' : 'NEON',
          neon_verification: 'NOT_PERFORMED',
          neon_pooler_verified: false,
          status: 'REFUSED',
          reasons,
          exit_code: EXIT.REFUSED,
        },
        null,
        2,
      ),
    );
    for (const r of reasons) err(`auth-pool-probe: ${r}`);
    return EXIT.REFUSED;
  }
  let Pool = deps.Pool;
  if (!Pool) {
    // The local proxy shim is loaded ONLY for a dry run; a Neon run never imports it.
    if (check.mode === 'local-dry-run') await import('../ci/neon-local.mjs');
    ({ Pool } = await import('@neondatabase/serverless'));
  }
  const result = await runProbe(env, options, check, { ...deps, Pool });
  out(JSON.stringify(result, null, 2));
  return result.exit_code;
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) {
  const code = await main(process.argv.slice(2), process.env);
  process.exit(code);
}
