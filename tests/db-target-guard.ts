import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';

/**
 * Where database-backed tests may write — checked before any test file runs.
 *
 * The suites write: fixtures are seeded as app_owner through DATABASE_URL_MIGRATE and the
 * application paths run through DATABASE_URL_TEST, DATABASE_URL, DATABASE_URL_AUTH and
 * DATABASE_URL_WORKER. tests/setup.ts loads .env, so a developer whose .env names a real
 * database would run every suite against it. This guard refuses that before a connection or
 * a fixture exists, and it does not depend on anyone remembering an opt-in variable: a
 * target passes only by what it is.
 *
 * Every DATABASE_URL* value must be one of:
 *   - a placeholder on the reserved `.invalid` TLD, which can never resolve (DB-free runs);
 *   - a local server (localhost, 127.0.0.1, ::1) — a disposable database by definition;
 *   - in CI (NEON_LOCAL_WSPROXY set) a `*.local` name, which neon-local sends to CI's own
 *     Postgres. Without the proxy a `.local` name could resolve on a LAN, so it is refused;
 *   - a hosted database whose NAME marks it as a test database (`test` as a whole
 *     underscore-separated word: pravshi_test, test_runner_a) and whose Neon endpoint is
 *     not a protected one. `neondb` and `pravshi` never pass.
 * Anything else — unparseable, another scheme, a socket path, a protected endpoint — fails.
 *
 * PROTECTED endpoints are listed by fingerprint (first 16 hex of sha256 of the endpoint
 * id), not by id: the repository is public. A protected endpoint is refused even for a
 * test-named database, because databases on one Neon branch share its roles — and so the
 * role passwords — with the primary.
 *
 * Error messages name the variable and the reason. They never contain a value, a host,
 * a user or a password.
 */
export const PROTECTED_ENDPOINT_FINGERPRINTS: Readonly<Record<string, string>> = {
  // Pravshi-OS-New (sparkling-water-53449782), branch `production` — the intended primary.
  '8fe576111c5ec162': 'Pravshi-OS-New production branch',
  // floral-base-77155861, branch `production` — the recorded production project (runbook).
  a5a05c0273552f5e: 'floral-base production branch',
};

export interface TargetViolation {
  variable: string;
  reason: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const TEST_DATABASE_NAME = /^(?:[a-z0-9]+_)*test(?:_[a-z0-9]+)*$/;

export const endpointFingerprint = (endpointId: string): string =>
  createHash('sha256').update(endpointId).digest('hex').slice(0, 16);

function violationFor(
  value: string,
  ciProxy: boolean,
  protectedEndpoints: Readonly<Record<string, string>>,
): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'not a parseable URL';
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return 'not a postgres:// or postgresql:// URL';
  }
  const host = url.hostname.toLowerCase();
  if (host === '') return 'no host (socket paths are not allowed for tests)';
  if (host.endsWith('.invalid')) return null;
  if (LOCAL_HOSTS.has(host)) return null;
  if (host.endsWith('.local')) {
    return ciProxy ? null : 'a .local host outside CI (NEON_LOCAL_WSPROXY is not set)';
  }
  if (ciProxy) return 'in CI only .local hosts reach the job’s own Postgres';

  const endpoint = host.match(/^(ep-[a-z0-9-]+?)(?:-pooler)?\./)?.[1];
  if (endpoint) {
    const label = protectedEndpoints[endpointFingerprint(endpoint)];
    if (label) return `a protected endpoint (${label})`;
  }
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return 'an unreadable database name';
  }
  if (!TEST_DATABASE_NAME.test(database)) {
    return 'a hosted database whose name does not mark it as a test database';
  }
  return null;
}

/** Every DATABASE_URL* value that is not an approved test target, by variable name. */
export function checkTestDatabaseTargets(
  env: Readonly<Record<string, string | undefined>>,
  protectedEndpoints: Readonly<Record<string, string>> = PROTECTED_ENDPOINT_FINGERPRINTS,
): TargetViolation[] {
  const ciProxy = Boolean(env.NEON_LOCAL_WSPROXY);
  const out: TargetViolation[] = [];
  for (const variable of Object.keys(env).sort()) {
    if (!variable.startsWith('DATABASE_URL')) continue;
    const value = env[variable];
    if (value === undefined || value.trim() === '') continue;
    const reason = violationFor(value.trim(), ciProxy, protectedEndpoints);
    if (reason) out.push({ variable, reason });
  }
  return out;
}

/**
 * The environment a `next start` web server will see: for production mode Next loads
 * .env.production.local, .env.local, .env.production and .env (earlier files win), and a
 * variable already in the process environment wins over every file. Parsed only — this never
 * writes to process.env. Used by playwright.config.ts: its webServer reads .env on its own
 * and the specs seed through DATABASE_URL_MIGRATE, so neither passes through tests/setup.ts.
 */
export function nextProductionEnv(
  cwd: string,
  processEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {};
  for (const file of ['.env', '.env.production', '.env.local', '.env.production.local']) {
    const path = join(cwd, file);
    if (existsSync(path)) Object.assign(merged, parse(readFileSync(path)));
  }
  return { ...merged, ...processEnv };
}

/** Throws before any suite runs when a DATABASE_URL* value is not an approved test target. */
export function assertTestDatabaseTargets(env: Readonly<Record<string, string | undefined>>): void {
  const violations = checkTestDatabaseTargets(env);
  if (violations.length === 0) return;
  throw new Error(
    'Refusing to run tests: these database variables do not name an approved test target ' +
      '(see tests/db-target-guard.ts):\n' +
      violations.map((v) => `  - ${v.variable}: ${v.reason}`).join('\n') +
      '\nPoint every DATABASE_URL* at a disposable test database (a local server, CI, or a ' +
      'hosted database named *_test on a non-protected endpoint), or unset it for DB-free runs.',
  );
}
