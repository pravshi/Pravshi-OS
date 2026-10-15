import { describe, expect, it } from 'vitest';

import {
  EXIT,
  describeUrl,
  errorCode,
  main,
  maskEndpoint,
  normalizeEndpointId,
  parseArgs,
  validateEnvironment,
} from '../../scripts/ops/auth-pool-probe.mjs';

/**
 * The WP-A1 Neon pooler probe (scripts/ops/auth-pool-probe.mjs) decides whether an operator's run
 * counts as evidence. These tests pin every guard with fake connection strings and an in-memory
 * Pool double: nothing here opens a socket, and no real credential or endpoint exists in this file.
 *
 * Fake URLs are BUILT with template interpolation, never written out, so the secret-shape guard
 * (which ignores `${…}`) does not mistake them for leaked credentials. Every value that must never
 * be printed — the password, the query parameters, the full endpoint ID — is a distinctive canary.
 */

const EP = 'ep-fake-fixture-a1b2c3d4';
const DOMAIN = 'us-east-2.aws.neon.tech';
const PASSWORD = 'canaryPw-zq9x-never-printed';
const QUERY = 'sslmode=require&channel_binding=require&options=canary-option-zq9x';

type UrlOpts = { pooled?: boolean; ep?: string; domain?: string; db?: string };
const url = (role: string, o: UrlOpts = {}) => {
  const label = `${o.ep ?? EP}${o.pooled === false ? '' : '-pooler'}`;
  return `postgresql://${role}:${PASSWORD}@${label}.${o.domain ?? DOMAIN}/${o.db ?? 'neondb'}?${QUERY}`;
};

type Env = Record<string, string | undefined>;
const neonEnv = (over: Env = {}): Env => ({
  DATABASE_URL: url('app_user'),
  DATABASE_URL_AUTH: url('app_auth'),
  DATABASE_URL_WORKER: url('app_worker'),
  DATABASE_URL_MIGRATE: url('app_owner', { pooled: false }),
  ...over,
});
const ARGS = ['--non-production-branch', 'dev-probe', '--expect-endpoint', EP];
const FAST = ['--instances', '1,3', '--seconds', '1'];

const opts = (argv: string[]) => {
  const { options, errors } = parseArgs(argv);
  expect(errors).toEqual([]);
  return options;
};

// ── the in-memory Pool double ─────────────────────────────────────────────────────

type RoleRow = {
  role: string;
  superuser: boolean;
  bypass_rls: boolean;
  create_role: boolean;
  create_db: boolean;
  member_of: number;
};
type Behaviour = {
  /** The role a connection string authenticates as (default: its username). */
  loginAs?: (connectionString: string) => string;
  roleRow?: (role: string) => Partial<RoleRow>;
  failAcquire?: (role: string) => Error | null;
  failCeiling?: Error;
  failIdentity?: (role: string) => Error | null;
  activity?: { u: string; n: number }[];
  ceiling?: { max_connections: number; reserved: number };
};

const userOf = (cs: string) => decodeURIComponent(new URL(cs).username);

function fakePool(b: Behaviour = {}) {
  const created: { role: string; max: number }[] = [];
  class FakePool {
    role: string;
    constructor(cfg: { connectionString: string; max: number }) {
      this.role = (b.loginAs ?? userOf)(cfg.connectionString);
      created.push({ role: userOf(cfg.connectionString), max: cfg.max });
    }
    async query(sql: string) {
      if (sql.includes('from pg_roles r where r.rolname = session_user')) {
        const e = b.failIdentity?.(this.role);
        if (e) throw e;
        const row: RoleRow = {
          role: this.role,
          superuser: false,
          bypass_rls: false,
          create_role: false,
          create_db: false,
          member_of: 0,
          ...b.roleRow?.(this.role),
        };
        return { rows: [row] };
      }
      if (sql.includes("current_setting('max_connections')")) {
        if (b.failCeiling) throw b.failCeiling;
        return {
          rows: [
            {
              ...(b.ceiling ?? { max_connections: 104, reserved: 3 }),
              sampler_reads_all_stats: false,
            },
          ],
        };
      }
      if (sql.includes('from pg_stat_activity')) {
        return {
          rows: b.activity ?? [
            { u: 'app_user', n: 5 },
            { u: 'app_auth', n: 3 },
            { u: 'app_owner', n: 1 },
          ],
        };
      }
      if (sql.includes('pg_sleep')) await new Promise((r) => setTimeout(r, 2));
      return { rows: [] };
    }
    async connect() {
      const e = b.failAcquire?.(this.role);
      if (e) throw e;
      return { query: (sql: string) => this.query(sql), release() {} };
    }
    async end() {}
  }
  return { Pool: FakePool, created };
}

/** Runs main() with the double, short phases and captured output. */
async function run(argv: string[], env: Env, b: Behaviour = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const { Pool, created } = fakePool(b);
  const code = await main(argv, env, {
    Pool,
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    phaseMs: 60,
    sampleIntervalMs: 5,
    clock: () => '2026-10-15T00:00:00.000Z',
  });
  const text = out.join('\n');
  return { code, json: JSON.parse(text), text, stderr: err.join('\n'), created };
}

const neverLeaks = (text: string) => {
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain('canary-option-zq9x');
  expect(text).not.toContain('sslmode');
  expect(text).not.toContain(EP); // the full endpoint ID — only its masked form may appear
  expect(text).not.toContain('postgresql://');
  expect(text).not.toMatch(/\bat .+:\d+:\d+\)?$/m); // no stack frames
};

// ── 1. local proxies cannot fake a Neon verification ─────────────────────────────

describe('local proxies cannot stand in for Neon', () => {
  for (const v of ['NEON_LOCAL_WSPROXY', 'NEON_LOCAL_PG_ADDRESS']) {
    it(`refuses a Neon run when ${v} alone is set — before any connection`, async () => {
      const r = await run([...ARGS, ...FAST], neonEnv({ [v]: 'localhost:18081' }));
      expect(r.code).toBe(EXIT.REFUSED);
      expect(r.json.status).toBe('REFUSED');
      expect(r.json.neon_pooler_verified).toBe(false);
      expect(r.json.reasons.join(' ')).toContain(`${v} is set`);
      expect(r.created).toEqual([]);
    });
  }

  it('refuses when a proxy variable is set even to an empty string (fail closed)', () => {
    const c = validateEnvironment(neonEnv({ NEON_LOCAL_PG_ADDRESS: '' }), opts(ARGS));
    expect(c.ok).toBe(false);
    expect(c.reasons.join(' ')).toContain('NEON_LOCAL_PG_ADDRESS is set');
  });

  it('proceeds when both are unset', () => {
    const c = validateEnvironment(neonEnv(), opts(ARGS));
    expect(c.reasons).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.mode).toBe('neon');
  });

  it('a local dry run requires NEON_LOCAL_WSPROXY, so it can never reach Neon', async () => {
    const r = await run([...ARGS, '--local-dry-run', ...FAST], neonEnv());
    expect(r.code).toBe(EXIT.REFUSED);
    expect(r.json.reasons.join(' ')).toContain('--local-dry-run requires NEON_LOCAL_WSPROXY');
    expect(r.created).toEqual([]);
  });

  it('a successful local dry run says no Neon verification happened and never exits 0', async () => {
    const r = await run(
      [...ARGS, '--local-dry-run', ...FAST],
      neonEnv({ NEON_LOCAL_WSPROXY: 'localhost:18081', NEON_LOCAL_PG_ADDRESS: 'postgres:5432' }),
    );
    expect(r.code).toBe(EXIT.LOCAL_DRY_RUN);
    expect(r.code).not.toBe(EXIT.VERIFIED);
    expect(r.json.mode).toBe('LOCAL_DRY_RUN');
    expect(r.json.status).toBe('LOCAL_DRY_RUN_ONLY');
    expect(r.json.neon_verification).toBe('NOT_PERFORMED');
    expect(r.json.neon_pooler_verified).toBe(false);
    expect(r.json.local_result).toBe('PASS');
    expect(r.json.exit_code).toBe(EXIT.LOCAL_DRY_RUN);
    expect(r.text).not.toContain('NEON_VERIFIED');
  });

  it('a failing local dry run exits 1, and is still never a Neon result', async () => {
    const r = await run(
      [...ARGS, '--local-dry-run', ...FAST],
      neonEnv({ NEON_LOCAL_WSPROXY: 'localhost:18081' }),
      { loginAs: () => 'app_user' },
    );
    expect(r.code).toBe(EXIT.FAILED);
    expect(r.json.status).toBe('LOCAL_DRY_RUN_ONLY');
    expect(r.json.local_result).toBe('IDENTITY_FAILED');
    expect(r.json.neon_pooler_verified).toBe(false);
  });
});

// ── 2. one endpoint, the one the operator confirmed ──────────────────────────────

describe('endpoint consistency', () => {
  it('normalizes the pooled and direct hostnames of one endpoint to the same ID', () => {
    expect(describeUrl(url('app_user'))?.endpointId).toBe(EP);
    expect(describeUrl(url('app_owner', { pooled: false }))?.endpointId).toBe(EP);
    expect(describeUrl(url('app_user'))?.pooled).toBe(true);
    expect(describeUrl(url('app_owner', { pooled: false }))?.pooled).toBe(false);
    expect(normalizeEndpointId(`${EP}-pooler`)).toBe(EP);
    expect(normalizeEndpointId(EP.toUpperCase())).toBe(EP);
  });

  it('refuses when one URL names a different endpoint', () => {
    const c = validateEnvironment(
      neonEnv({ DATABASE_URL_WORKER: url('app_worker', { ep: 'ep-fake-other-e5f6a7b8' }) }),
      opts(ARGS),
    );
    expect(c.ok).toBe(false);
    expect(c.reasons.join(' ')).toContain('do not name the same endpoint');
  });

  it('refuses when one URL names a different region domain', () => {
    const c = validateEnvironment(
      neonEnv({ DATABASE_URL_AUTH: url('app_auth', { domain: 'eu-central-1.aws.neon.tech' }) }),
      opts(ARGS),
    );
    expect(c.reasons.join(' ')).toContain('do not name the same endpoint');
  });

  it('refuses when one URL names a different database', () => {
    const c = validateEnvironment(
      neonEnv({ DATABASE_URL: url('app_user', { db: 'other' }) }),
      opts(ARGS),
    );
    expect(c.reasons.join(' ')).toContain('do not name the same database');
  });

  it('refuses a Neon run without --expect-endpoint', () => {
    const c = validateEnvironment(neonEnv(), opts(['--non-production-branch', 'dev-probe']));
    expect(c.ok).toBe(false);
    expect(c.reasons.join(' ')).toContain('refusing without --expect-endpoint');
  });

  it('refuses when --expect-endpoint does not match, showing only masked IDs', () => {
    const c = validateEnvironment(
      neonEnv(),
      opts(['--non-production-branch', 'dev-probe', '--expect-endpoint', 'ep-fake-other-e5f6a7b8']),
    );
    expect(c.ok).toBe(false);
    const text = c.reasons.join(' ');
    expect(text).toContain('does not match');
    expect(text).toContain(maskEndpoint(EP));
    expect(text).not.toContain(EP);
    expect(text).not.toContain('ep-fake-other-e5f6a7b8');
  });

  it('accepts --expect-endpoint in its pooled form', () => {
    const c = validateEnvironment(
      neonEnv(),
      opts(['--non-production-branch', 'dev-probe', '--expect-endpoint', `${EP}-pooler`]),
    );
    expect(c.ok).toBe(true);
    expect(c.target.endpoint_matches_expected).toBe(true);
  });

  it('refuses a Neon run against a host outside *.neon.tech', () => {
    const local = (role: string, pooled = true) => url(role, { domain: 'example.test', pooled });
    const c = validateEnvironment(
      {
        DATABASE_URL: local('app_user'),
        DATABASE_URL_AUTH: local('app_auth'),
        DATABASE_URL_WORKER: local('app_worker'),
        DATABASE_URL_MIGRATE: local('app_owner', false),
      },
      opts(ARGS),
    );
    expect(c.reasons.join(' ')).toContain('do not name a Neon host');
  });

  it('masks endpoint IDs to a prefix and the last four characters', () => {
    expect(maskEndpoint(EP)).toBe('ep-…c3d4');
    expect(maskEndpoint(null)).toBeNull();
    expect(maskEndpoint('ep-ab')).toBe('…');
  });
});

// ── URL type and login expectations, without printing values ────────────────────

describe('URL type and login expectations', () => {
  it('refuses a pooled URL where the direct one belongs, and the reverse', () => {
    const c = validateEnvironment(
      neonEnv({
        DATABASE_URL_MIGRATE: url('app_owner'),
        DATABASE_URL_AUTH: url('app_auth', { pooled: false }),
      }),
      opts(ARGS),
    );
    const text = c.reasons.join(' ');
    expect(text).toContain('DATABASE_URL_MIGRATE must be the DIRECT endpoint');
    expect(text).toContain('DATABASE_URL_AUTH must be the POOLED endpoint');
  });

  it('refuses a URL that logs in as the wrong role, naming only the expected role', () => {
    const c = validateEnvironment(neonEnv({ DATABASE_URL_AUTH: url('app_user') }), opts(ARGS));
    const text = c.reasons.join(' ');
    expect(text).toContain('DATABASE_URL_AUTH must log in as app_auth');
    expect(text).toContain('DATABASE_URL_AUTH equals DATABASE_URL');
  });

  it('refuses missing and unparseable URLs', () => {
    const c = validateEnvironment(
      neonEnv({ DATABASE_URL_WORKER: undefined, DATABASE_URL: 'not a url' }),
      opts(ARGS),
    );
    const text = c.reasons.join(' ');
    expect(text).toContain('DATABASE_URL_WORKER is not set');
    expect(text).toContain('DATABASE_URL is not a postgres:// connection string');
  });

  it('refuses a missing or production-looking branch label', () => {
    expect(
      validateEnvironment(neonEnv(), opts(['--expect-endpoint', EP])).reasons.join(' '),
    ).toContain('refusing to run without --non-production-branch');
    for (const b of ['main', 'Production', 'prod']) {
      const c = validateEnvironment(
        neonEnv(),
        opts(['--non-production-branch', b, '--expect-endpoint', EP]),
      );
      expect(c.reasons.join(' ')).toContain('looks like production');
    }
  });

  it('a refusal prints no password, query parameter, username or full endpoint', async () => {
    const r = await run(
      ['--non-production-branch', 'dev-probe', '--expect-endpoint', 'ep-fake-other-e5f6a7b8'],
      neonEnv({ DATABASE_URL_WORKER: url('someone_else'), NEON_LOCAL_WSPROXY: 'x' }),
    );
    expect(r.code).toBe(EXIT.REFUSED);
    neverLeaks(r.text);
    neverLeaks(r.stderr);
    expect(r.text).not.toContain('someone_else');
    expect(r.stderr).not.toContain('someone_else');
  });
});

// ── arguments ─────────────────────────────────────────────────────────────────────

describe('arguments', () => {
  it('parses the pool-size options used for the reduced-capacity retry', () => {
    const o = opts([
      ...ARGS,
      '--auth-per-instance',
      '2',
      '--business-per-instance',
      '4',
      '--instances',
      '3',
    ]);
    expect(o.authPerInstance).toBe(2);
    expect(o.businessPerInstance).toBe(4);
    expect(o.instances).toEqual([3]);
  });

  it('defaults to the application pool sizes (business 5, auth 3)', () => {
    const o = opts(ARGS);
    expect(o.authPerInstance).toBe(3);
    expect(o.businessPerInstance).toBe(5);
    expect(o.instances).toEqual([1, 3, 10]);
    expect(o.seconds).toBe(60);
  });

  it('rejects unknown flags, missing values and out-of-range numbers', async () => {
    for (const bad of [
      ['--expect', EP],
      ['--seconds'],
      ['--seconds', '0'],
      ['--auth-per-instance', 'two'],
      ['--instances', '1,,3'],
      ['stray'],
    ]) {
      expect(parseArgs([...ARGS, ...bad]).errors.length, bad.join(' ')).toBeGreaterThan(0);
    }
    const r = await run([...ARGS, '--seconds', '0'], neonEnv());
    expect(r.code).toBe(EXIT.REFUSED);
    expect(r.created).toEqual([]);
  });
});

// ── 3. role verification ──────────────────────────────────────────────────────────

describe('role verification (read-only)', () => {
  it('a real run whose every login and phase checks out is the only NEON_VERIFIED result', async () => {
    const r = await run([...ARGS, ...FAST], neonEnv());
    expect(r.code).toBe(EXIT.VERIFIED);
    expect(r.json.status).toBe('NEON_VERIFIED');
    expect(r.json.neon_pooler_verified).toBe(true);
    expect(r.json.neon_verification).toBe('PERFORMED');
    expect(r.json.identity_status).toBe('PASS');
    expect(r.json.load_status).toBe('PASS');
    for (const name of [
      'DATABASE_URL',
      'DATABASE_URL_AUTH',
      'DATABASE_URL_WORKER',
      'DATABASE_URL_MIGRATE',
    ]) {
      expect(r.json.identity[name].ok, name).toBe(true);
    }
    expect(r.json.target.endpoint).toBe('ep-…c3d4');
    expect(r.json.target.endpoint_matches_expected).toBe(true);
    neverLeaks(r.text);
  });

  it('a pooled URL that authenticates as another role fails identity and skips load', async () => {
    const r = await run([...ARGS, ...FAST], neonEnv(), {
      loginAs: (cs) => (userOf(cs) === 'app_auth' ? 'app_user' : userOf(cs)),
    });
    expect(r.code).toBe(EXIT.FAILED);
    expect(r.json.status).toBe('IDENTITY_FAILED');
    expect(r.json.identity_status).toBe('FAIL');
    expect(r.json.load_status).toBe('SKIPPED');
    expect(r.json.identity.DATABASE_URL_AUTH).toMatchObject({
      expected: 'app_auth',
      got: 'app_user',
      ok: false,
    });
    expect(r.json.load).toBeUndefined();
    expect(r.json.neon_pooler_verified).toBe(false);
  });

  it('the direct URL must authenticate as app_owner; a foreign role is not named', async () => {
    const r = await run([...ARGS, ...FAST], neonEnv(), {
      loginAs: (cs) => (userOf(cs) === 'app_owner' ? 'neondb_owner' : userOf(cs)),
    });
    expect(r.json.status).toBe('IDENTITY_FAILED');
    expect(r.json.identity.DATABASE_URL_MIGRATE).toMatchObject({
      got: '(another role)',
      ok: false,
    });
    expect(r.text).not.toContain('neondb_owner');
  });

  for (const [attr, label] of [
    ['superuser', 'SUPERUSER'],
    ['bypass_rls', 'BYPASSRLS'],
    ['create_role', 'CREATEROLE'],
    ['create_db', 'CREATEDB'],
  ] as const) {
    it(`a runtime role with ${label} fails identity`, async () => {
      const r = await run([...ARGS, ...FAST], neonEnv(), {
        roleRow: (role) => (role === 'app_worker' ? { [attr]: true } : {}),
      });
      expect(r.json.status).toBe('IDENTITY_FAILED');
      expect(r.json.identity.DATABASE_URL_WORKER.attributes_ok).toBe(false);
    });
  }

  it('app_owner with BYPASSRLS fails identity too', async () => {
    const r = await run([...ARGS, ...FAST], neonEnv(), {
      roleRow: (role) => (role === 'app_owner' ? { bypass_rls: true } : {}),
    });
    expect(r.json.status).toBe('IDENTITY_FAILED');
  });

  it('a runtime role that is a member of another role fails identity', async () => {
    const r = await run([...ARGS, ...FAST], neonEnv(), {
      roleRow: (role) => (role === 'app_auth' ? { member_of: 1 } : {}),
    });
    expect(r.json.status).toBe('IDENTITY_FAILED');
    expect(r.json.identity.DATABASE_URL_AUTH).toMatchObject({
      member_of_other_roles: 1,
      membership_ok: false,
    });
  });

  it('a login that cannot connect fails identity with a sanitized code only', async () => {
    const leaky = Object.assign(new Error(`password authentication failed: ${PASSWORD}`), {
      code: '28P01',
    });
    const r = await run([...ARGS, ...FAST], neonEnv(), {
      failIdentity: (role) => (role === 'app_worker' ? leaky : null),
    });
    expect(r.json.identity.DATABASE_URL_WORKER).toMatchObject({ ok: false, error: '28P01' });
    expect(r.json.status).toBe('IDENTITY_FAILED');
    neverLeaks(r.text);
  });
});

// ── 4. load results are unambiguous ───────────────────────────────────────────────

describe('load results', () => {
  it('every phase reports its own status and checks; identity and load are reported separately', async () => {
    const r = await run([...ARGS, ...FAST], neonEnv());
    expect(r.json.load).toHaveLength(2);
    for (const phase of r.json.load) {
      expect(phase.status).toBe('PASS');
      expect(phase.checks.no_client_errors).toBe('PASS');
      expect(phase.checks.sampled).toBe('PASS');
      expect(phase.checks.peak_total_below_max_minus_reserved).toBe('PASS');
      expect(phase.checks.app_auth_peak_within_documented_pool_size).toBe('MANUAL');
    }
    expect(r.json.load[0].checks.app_auth_p95_within_single_instance_plus_200ms).toBe('BASELINE');
    expect(['PASS', 'FAIL']).toContain(
      r.json.load[1].checks.app_auth_p95_within_single_instance_plus_200ms,
    );
  });

  it('acquisition errors fail the phase, the run and the exit code — identity still shows PASS', async () => {
    const tooMany = Object.assign(new Error(`too many connections for ${PASSWORD}`), {
      code: '53300',
    });
    const r = await run([...ARGS, ...FAST], neonEnv(), {
      failAcquire: (role) => (role === 'app_auth' ? tooMany : null),
    });
    expect(r.code).toBe(EXIT.FAILED);
    expect(r.json.status).toBe('LOAD_FAILED');
    expect(r.json.identity_status).toBe('PASS');
    expect(r.json.load_status).toBe('FAIL');
    expect(r.json.load[0].status).toBe('FAIL');
    expect(r.json.load[0].app_auth.errors['acquire:53300']).toBeGreaterThan(0);
    expect(r.json.neon_pooler_verified).toBe(false);
    neverLeaks(r.text);
  });

  it('an acquisition timeout is classified without printing its message', () => {
    expect(errorCode(new Error('timeout exceeded when trying to connect'))).toBe('TIMEOUT');
    expect(errorCode(Object.assign(new Error(PASSWORD), { code: 'ECONNRESET' }))).toBe(
      'ECONNRESET',
    );
    expect(errorCode({ code: 'not a code!', name: 'Weird Name 1' })).toBe('error');
  });

  it('a peak at or above max_connections − reserved fails the phase', async () => {
    const r = await run([...ARGS, ...FAST], neonEnv(), {
      ceiling: { max_connections: 10, reserved: 3 },
    });
    expect(r.json.status).toBe('LOAD_FAILED');
    expect(r.json.load[0].checks.peak_total_below_max_minus_reserved).toBe('FAIL');
  });

  it('a run that stops midway still prints safe partial JSON with the failed stage', async () => {
    const boom = Object.assign(new Error(`connect failed ${PASSWORD} at host ${EP}`), {
      code: 'ECONNREFUSED',
    });
    const r = await run([...ARGS, ...FAST], neonEnv(), { failCeiling: boom });
    expect(r.code).toBe(EXIT.FAILED);
    expect(r.json.status).toBe('FAILED_MIDWAY');
    expect(r.json.failed_stage).toBe('ceiling');
    expect(r.json.error).toBe('ECONNREFUSED');
    expect(r.json.identity_status).toBe('PASS');
    expect(r.json.load_status).toBe('INCOMPLETE');
    expect(r.json.neon_pooler_verified).toBe(false);
    neverLeaks(r.text);
  });

  it('--auth-per-instance and --business-per-instance size the simulated pools', async () => {
    const r = await run(
      [
        ...ARGS,
        '--instances',
        '3',
        '--seconds',
        '1',
        '--auth-per-instance',
        '2',
        '--business-per-instance',
        '4',
      ],
      neonEnv(),
    );
    expect(r.json.pool_sizes).toEqual({ business_per_instance: 4, auth_per_instance: 2 });
    expect(r.json.load[0].clients).toEqual({ app_user: 12, app_auth: 6 });
    const loadPools = r.created.filter((p) => p.max > 1);
    expect(loadPools.filter((p) => p.role === 'app_auth').map((p) => p.max)).toEqual([2, 2, 2]);
    expect(loadPools.filter((p) => p.role === 'app_user').map((p) => p.max)).toEqual([4, 4, 4]);
  });
});
