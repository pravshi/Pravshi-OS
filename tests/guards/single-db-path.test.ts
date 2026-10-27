import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const grep = (args: string) => execSync(`git grep ${args} || true`, { encoding: 'utf8' }).trim();

describe('there is exactly one path to Postgres', () => {
  it('nothing calls pool.connect() outside src/lib/db/pool.ts', () => {
    const hits = grep(`-l "pool.connect(" -- src ":!src/lib/db/pool.ts"`);
    expect(hits, `Direct pool.connect() bypasses cold-start retry, in:\n${hits}`).toBe('');
  });

  it('nothing outside the db module imports the pool', () => {
    const hits = grep(
      `-lE "from '@/lib/db/pool'" -- src ":!src/lib/db/*" ":!src/app/health/db/route.ts"`,
    );
    expect(hits, `Unexpected pool import — use withAuthorizedDb(), in:\n${hits}`).toBe('');
  });

  it('only the auth module uses the auth client, which is the one sanctioned exception', () => {
    // authDb reaches the `auth` schema without an identity in the transaction, because a
    // request cannot present an identity while it is being established. That exception is
    // for authentication and nothing else: business data still goes through
    // withAuthorizedDb(), where RLS meets it.
    const hits = grep(
      `-lE "from '@/lib/db/auth-client'" -- src ":!src/lib/auth/*" ":!src/lib/db/*"`,
    );
    expect(
      hits,
      `authDb bypasses withAuthorizedDb() and belongs to the auth module only, in:\n${hits}`,
    ).toBe('');
  });

  it('only the worker plane (src/lib/jobs) uses the app_worker pool', () => {
    // worker-pool.ts connects as app_worker (migration 0070): the role that can claim every
    // organization's jobs. Only the job runtime may reach it — never a route, a page or
    // feature code — and the web app does not even hold its credential (src/env.ts).
    const hits = grep(`-lE "db/worker-pool'" -- src ":!src/lib/jobs/*" ":!src/lib/db/*"`);
    expect(hits, `app_worker pool imported outside the worker plane, in:\n${hits}`).toBe('');
  });

  it('no feature code queries the credential tables by hand', () => {
    const hits = grep(
      `-lE "auth[.]auth_(users|sessions|accounts|verifications|two_factors|rate_limits)" -- src ":!src/lib/auth/*"`,
    );
    expect(hits, `Direct auth-table access outside the auth layer, in:\n${hits}`).toBe('');
  });

  // ── the authentication plane's own login (app_auth, migrations 0072/0073) ──────────────────

  it('only the auth client (and the health check of its login) imports the app_auth pool', () => {
    const hits = grep(
      `-lE "db/auth-pool'" -- src ":!src/lib/db/auth-client.ts" ":!src/app/health/db/route.ts"`,
    );
    expect(hits, `app_auth pool imported outside the auth client, in:\n${hits}`).toBe('');
  });

  it('the auth client runs on the app_auth pool, never the business pool', () => {
    const client = readFileSync(join(process.cwd(), 'src/lib/db/auth-client.ts'), 'utf8');
    expect(client).toMatch(/import \{ authPool \} from '\.\/auth-pool';/);
    expect(client).toMatch(/drizzle\(authPool, /);
    expect(client).not.toMatch(/from '\.\/pool'/);
  });

  it('the app_auth pool has no fallback to DATABASE_URL or the business pool', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/db/auth-pool.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    // The connection string is DATABASE_URL_AUTH and nothing else.
    expect(src).toMatch(/connectionString: env\.DATABASE_URL_AUTH,/);
    expect(src).not.toMatch(/env\.DATABASE_URL\b(?!_AUTH)/);
    // No "url ?? fallback" / "url || fallback" anywhere the URL is named.
    for (const line of src.split('\n').filter((l) => l.includes('DATABASE_URL'))) {
      expect(line).not.toMatch(/\?\?|\|\|/);
    }
    // From the business pool module it borrows only the retry classifier, never the pool.
    expect(src).toMatch(/import \{ isRetryableConnectError \} from '\.\/pool';/);
    // It refuses to load without the variable, and proves the login on every new connection.
    expect(src).toMatch(/if \(!env\.DATABASE_URL_AUTH\) \{\s*throw new Error/);
    expect(src).toMatch(/verify: verifyAuthLogin/);
  });

  // ── the platform plane's login (app_platform, migrations 0083-0086, ADR-008) ──────────────

  it('only the platform module (src/lib/platform) uses the app_platform pool', () => {
    // platform-pool.ts connects as app_platform: the login that provisions, suspends and
    // reactivates organizations. Only the platform module, behind its gate, may reach it.
    const hits = grep(
      `-lE "db/platform-pool'" -- src ":!src/lib/platform/*" ":!src/lib/db/platform-pool.ts"`,
    );
    expect(hits, `app_platform pool imported outside src/lib/platform, in:\n${hits}`).toBe('');
  });

  it('the app_platform pool has no fallback and proves its login', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/db/platform-pool.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');
    expect(src).toMatch(/connectionString: env\.DATABASE_URL_PLATFORM,/);
    expect(src).not.toMatch(/env\.DATABASE_URL(_AUTH)?\b(?!_PLATFORM)/);
    for (const line of src.split('\n').filter((l) => l.includes('DATABASE_URL'))) {
      expect(line).not.toMatch(/\?\?|\|\|/);
    }
    expect(src).toMatch(
      /if \(!env\.DATABASE_URL_PLATFORM\) \{\s*throw new PlatformUnavailableError/,
    );
    expect(src).toMatch(/verify: verifyPlatformLogin/);
    // The administrator is set transaction-locally, never for the session.
    expect(src).toMatch(/set_config\('app\.platform_admin_id', [^)]+, true\)/);
    expect(src).toMatch(/set_config\('app\.platform_aal', [^)]+, true\)/);
    // And the session the database binds the actor to (0086): its id and its token's hash.
    expect(src).toMatch(/set_config\('app\.platform_session_id', [^)]+, true\)/);
    expect(src).toMatch(/set_config\('app\.platform_session_token_sha256', [^)]+, true\)/);
  });

  it('the worker plane imports nothing from the authentication plane directly', () => {
    // The worker host must not hold DATABASE_URL_AUTH (runner.ts refuses it); no worker-plane
    // file may import the auth module, the auth client or the auth pool. This is a DIRECT-import
    // check only: shared code the worker loads (the workflow engine's integrations fan-out uses
    // the authorization helpers) does reach the auth client transitively. That is safe only
    // because the auth pool is created on first use and needs no configuration to load — pinned
    // by tests/db/auth-pool-config.test.ts and by the worker E2E starting without the variable.
    const hits = grep(
      `-lE "from '(@/lib/auth/|\\.\\./auth/|@/lib/db/auth-client|@/lib/db/auth-pool|\\.\\./db/auth-client|\\.\\./db/auth-pool)" -- src/lib/jobs src/lib/workflows`,
    );
    expect(hits, `worker-plane code imports the authentication plane, in:\n${hits}`).toBe('');
  });
});
