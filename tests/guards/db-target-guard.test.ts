import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertTestDatabaseTargets,
  checkTestDatabaseTargets,
  endpointFingerprint,
  nextProductionEnv,
  PROTECTED_ENDPOINT_FINGERPRINTS,
} from '../db-target-guard';

/**
 * The database-test target guard (tests/db-target-guard.ts). Every case is a mocked
 * environment: nothing here opens a connection. Fake DSNs use the secret scanner's allowed
 * placeholder shape (user u, password p, host ep-x…) or carry no credentials at all.
 */
const NEON = (suffix: string, db: string, pooled = false) =>
  `postgresql://u:p@ep-x${suffix}${pooled ? '-pooler' : ''}.ap-southeast-1.aws.neon.tech/${db}`;
const PROTECTED = { [endpointFingerprint('ep-x-protected')]: 'test primary' };
const verdict = (env: Record<string, string | undefined>, protectedMap = PROTECTED) =>
  checkTestDatabaseTargets(env, protectedMap).map((v) => `${v.variable}: ${v.reason}`);

describe('db-target guard: what passes', () => {
  it('an environment with no database variables (DB-free runs)', () => {
    expect(verdict({})).toEqual([]);
    expect(verdict({ DATABASE_URL_TEST: '', DATABASE_URL: '   ' })).toEqual([]);
  });

  it('placeholders on the reserved .invalid TLD', () => {
    expect(verdict({ DATABASE_URL: 'postgresql://u:p@ep-x-pooler.invalid/db' })).toEqual([]);
  });

  it('local servers', () => {
    expect(
      verdict({
        DATABASE_URL_TEST: 'postgresql://localhost:5432/neondb',
        DATABASE_URL_MIGRATE: 'postgres://127.0.0.1/pravshi',
        DATABASE_URL_WORKER: 'postgresql://[::1]:5432/anything',
      }),
    ).toEqual([]);
  });

  it("CI's .local names while CI's proxy is active", () => {
    expect(
      verdict({
        NEON_LOCAL_WSPROXY: 'localhost:8080',
        DATABASE_URL: 'postgresql://ci-pooler.local/neondb',
        DATABASE_URL_MIGRATE: 'postgresql://ci.local/neondb',
        DATABASE_URL_MIGRATION_TEST_A: 'postgresql://ci.local/pravshi_runner_a',
      }),
    ).toEqual([]);
  });

  it('a hosted database named as a test database, on a non-protected endpoint', () => {
    for (const db of ['pravshi_test', 'test', 'test_runner_a', 'pravshi_test_b']) {
      expect(verdict({ DATABASE_URL_TEST: NEON('-dev', db, true) })).toEqual([]);
    }
  });
});

describe('db-target guard: what is refused', () => {
  it('a hosted database not named as a test database — neondb and pravshi among them', () => {
    for (const db of [
      'neondb',
      'pravshi',
      'contest',
      'testing',
      'pravshi-test',
      'PRAVSHI_TEST',
      '',
    ]) {
      expect(verdict({ DATABASE_URL_TEST: NEON('-dev', db) })).toEqual([
        'DATABASE_URL_TEST: a hosted database whose name does not mark it as a test database',
      ]);
    }
  });

  it('a protected endpoint, even for a test-named database, pooled or direct', () => {
    expect(
      verdict({
        DATABASE_URL_TEST: NEON('-protected', 'pravshi_test', true),
        DATABASE_URL_MIGRATE: NEON('-protected', 'neondb'),
      }),
    ).toEqual([
      'DATABASE_URL_MIGRATE: a protected endpoint (test primary)',
      'DATABASE_URL_TEST: a protected endpoint (test primary)',
    ]);
  });

  it('every DATABASE_URL* variable is checked — app, auth, worker, bootstrap, runner tests', () => {
    const hosted = NEON('-dev', 'neondb', true);
    const names = [
      'DATABASE_URL',
      'DATABASE_URL_AUTH',
      'DATABASE_URL_BOOTSTRAP',
      'DATABASE_URL_MIGRATE',
      'DATABASE_URL_MIGRATION_TEST_A',
      'DATABASE_URL_TEST',
      'DATABASE_URL_WORKER',
    ];
    const env = Object.fromEntries(names.map((n) => [n, hosted]));
    expect(checkTestDatabaseTargets(env, PROTECTED).map((v) => v.variable)).toEqual(names);
  });

  it('.local names outside CI, and non-.local hosts inside CI', () => {
    expect(verdict({ DATABASE_URL: 'postgresql://ci.local/neondb' })).toEqual([
      'DATABASE_URL: a .local host outside CI (NEON_LOCAL_WSPROXY is not set)',
    ]);
    expect(
      verdict({ NEON_LOCAL_WSPROXY: 'localhost:8080', DATABASE_URL: NEON('-dev', 'pravshi_test') }),
    ).toEqual(['DATABASE_URL: in CI only .local hosts reach the job’s own Postgres']);
  });

  it('anything that is not a host-addressed postgres URL', () => {
    expect(
      verdict({
        DATABASE_URL_A: 'not a url',
        DATABASE_URL_B: 'mysql://localhost/test',
        DATABASE_URL_C: 'postgresql:///pravshi_test?host=/var/run/postgresql',
      }),
    ).toEqual([
      'DATABASE_URL_A: not a parseable URL',
      'DATABASE_URL_B: not a postgres:// or postgresql:// URL',
      'DATABASE_URL_C: no host (socket paths are not allowed for tests)',
    ]);
  });

  it('variables outside DATABASE_URL* are not its concern', () => {
    expect(verdict({ NEON_OWNER_URL: NEON('-protected', 'neondb') })).toEqual([]);
  });
});

describe('db-target guard: the refusal', () => {
  it('throws naming each variable and reason — and never a value, host, user or password', () => {
    const env = {
      DATABASE_URL_TEST: NEON('-secretish', 'neondb', true),
      DATABASE_URL_MIGRATE: 'postgresql://ci.local/neondb',
    };
    let message = '';
    try {
      assertTestDatabaseTargets(env);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/^Refusing to run tests/);
    expect(message).toContain('DATABASE_URL_TEST: a hosted database whose name');
    expect(message).toContain('DATABASE_URL_MIGRATE: a .local host outside CI');
    for (const leaked of [
      'ep-x-secretish',
      'neon.tech',
      'ci.local',
      'u:p',
      'postgresql://',
      'neondb',
    ]) {
      expect(message).not.toContain(leaked);
    }
  });

  it('does not throw for an approved environment', () => {
    expect(() =>
      assertTestDatabaseTargets({ DATABASE_URL: 'postgresql://u:p@ep-x-pooler.invalid/db' }),
    ).not.toThrow();
  });
});

describe('db-target guard: wiring and protected list', () => {
  it('runs in the vitest setup file, after .env is loaded and before any suite', () => {
    const setup = readFileSync('tests/setup.ts', 'utf8');
    const config = readFileSync('vitest.config.mts', 'utf8');
    expect(config).toMatch(/setupFiles: \['tests\/setup\.ts'\]/);
    const dotenvAt = setup.indexOf("import 'dotenv/config';");
    const callAt = setup.indexOf('assertTestDatabaseTargets(process.env);');
    expect(dotenvAt).toBe(0);
    expect(callAt).toBeGreaterThan(dotenvAt);
  });

  it('lists the protected endpoints by 16-hex fingerprint only, never by id', () => {
    const source = readFileSync('tests/db-target-guard.ts', 'utf8');
    expect(Object.keys(PROTECTED_ENDPOINT_FINGERPRINTS)).toHaveLength(2);
    for (const fp of Object.keys(PROTECTED_ENDPOINT_FINGERPRINTS))
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(source).not.toMatch(/\bep-[a-z]+-[a-z]+-[a-z0-9]{8}\b/);
  });
});

describe('db-target guard: Playwright (E2E) entry point', () => {
  it('checks the environment the next start web server will load, files and process alike', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-guard-'));
    try {
      writeFileSync(
        join(dir, '.env'),
        [
          'DATABASE_URL_MIGRATE=postgresql://u:p@ep-x-dev.ap-southeast-1.aws.neon.tech/neondb',
          'KEEP=from-env',
        ].join('\n'),
      );
      writeFileSync(
        join(dir, '.env.production'),
        'DATABASE_URL=postgresql://u:p@ep-x-pooler.invalid/db',
      );
      writeFileSync(join(dir, '.env.local'), 'KEEP=from-local');
      const before = { ...process.env };
      const env = nextProductionEnv(dir, { DATABASE_URL_TEST: 'postgresql://localhost/x' });
      expect(process.env).toEqual(before); // parsed only, never loaded
      expect(env.KEEP).toBe('from-local'); // later file in Next's order wins over .env
      expect(checkTestDatabaseTargets(env).map((v) => v.variable)).toEqual([
        'DATABASE_URL_MIGRATE',
      ]);
      // A variable set in the process wins over every file, as Next does.
      const overridden = nextProductionEnv(dir, {
        DATABASE_URL_MIGRATE: 'postgresql://localhost/x',
      });
      expect(checkTestDatabaseTargets(overridden)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs at the top of playwright.config.ts, before defineConfig', () => {
    const config = readFileSync('playwright.config.ts', 'utf8');
    const callAt = config.indexOf(
      'assertTestDatabaseTargets(nextProductionEnv(process.cwd(), process.env));',
    );
    expect(callAt).toBeGreaterThan(0);
    expect(callAt).toBeLessThan(config.indexOf('export default defineConfig('));
  });
});
