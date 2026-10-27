import { describe, expect, it } from 'vitest';
import { parseRuntimeEnv, parseToolingEnv } from '@/env';

const POOLED = 'postgresql://u:p@ep-x-pooler.ap-southeast-1.aws.neon.tech/db';
const DIRECT = 'postgresql://u:p@ep-x.ap-southeast-1.aws.neon.tech/db';
/** Long enough to satisfy the 32-character floor; a fixture, not a real secret. */
const SECRET = 'x'.repeat(32);

describe('parseRuntimeEnv', () => {
  it('rejects a direct URL for the runtime connection', () => {
    expect(() =>
      parseRuntimeEnv({
        DATABASE_URL: DIRECT,
        APP_URL: 'http://localhost:3000',
        NODE_ENV: 'test',
        BETTER_AUTH_SECRET: SECRET,
      }),
    ).toThrow(/DATABASE_URL must use the pooled/);
  });

  it('REFUSES TO BOOT if the migration credential is present in production', () => {
    expect(() =>
      parseRuntimeEnv({
        DATABASE_URL: POOLED,
        DATABASE_URL_MIGRATE: DIRECT,
        APP_URL: 'https://os.pravshi.com',
        NODE_ENV: 'production',
        BETTER_AUTH_SECRET: SECRET,
      }),
    ).toThrow(/DATABASE_URL_MIGRATE must never be present in the runtime environment/);
  });

  it('still refuses the migration credential in a production RUNTIME, not just in theory', () => {
    // No NEXT_PHASE — this is the serving runtime, where the rule is absolute.
    expect(() =>
      parseRuntimeEnv({
        DATABASE_URL: POOLED,
        DATABASE_URL_MIGRATE: DIRECT,
        APP_URL: 'https://os.pravshi.com',
        NODE_ENV: 'production',
        NEXT_PHASE: 'phase-production-server',
        BETTER_AUTH_SECRET: SECRET,
      }),
    ).toThrow(/DATABASE_URL_MIGRATE must never be present in the runtime environment/);
  });

  it('allows it during `next build`, which collects page data and serves nothing', () => {
    // CI runs migrations and the build in the same environment, so the build
    // phase legitimately sees app_owner. Narrow, deliberate, and tested.
    const env = parseRuntimeEnv({
      DATABASE_URL: POOLED,
      DATABASE_URL_MIGRATE: DIRECT,
      APP_URL: 'https://os.pravshi.com',
      NODE_ENV: 'production',
      NEXT_PHASE: 'phase-production-build',
      BETTER_AUTH_SECRET: SECRET,
    });
    expect(env.APP_URL).toBe('https://os.pravshi.com');
  });

  it('REFUSES TO BOOT if the bootstrap credential is present in a production runtime', () => {
    // Task 1.14. app_admin can bootstrap the first SUPER_ADMIN; its custody is the operator's
    // machine, and the serving runtime must fail closed if it ever appears there.
    expect(() =>
      parseRuntimeEnv({
        DATABASE_URL: POOLED,
        DATABASE_URL_BOOTSTRAP: DIRECT,
        APP_URL: 'https://os.pravshi.com',
        NODE_ENV: 'production',
        NEXT_PHASE: 'phase-production-server',
        BETTER_AUTH_SECRET: SECRET,
      }),
    ).toThrow(/DATABASE_URL_BOOTSTRAP must never be present in the runtime environment/);
  });

  it('allows the bootstrap credential during `next build`, exactly as it does the migration one', () => {
    const env = parseRuntimeEnv({
      DATABASE_URL: POOLED,
      DATABASE_URL_BOOTSTRAP: DIRECT,
      APP_URL: 'https://os.pravshi.com',
      NODE_ENV: 'production',
      NEXT_PHASE: 'phase-production-build',
      BETTER_AUTH_SECRET: SECRET,
    });
    expect(env.APP_URL).toBe('https://os.pravshi.com');
  });

  it('accepts a correct runtime environment', () => {
    const env = parseRuntimeEnv({
      DATABASE_URL: POOLED,
      APP_URL: 'http://localhost:3000',
      NODE_ENV: 'test',
      BETTER_AUTH_SECRET: SECRET,
    });
    expect(env.APP_URL).toBe('http://localhost:3000');
  });

  it('refuses to boot without a session signing secret', () => {
    // Not optional: without it Better Auth would generate one per serverless instance, and
    // a session issued by one instance would be rejected by the next.
    expect(() =>
      parseRuntimeEnv({
        DATABASE_URL: POOLED,
        APP_URL: 'http://localhost:3000',
        NODE_ENV: 'test',
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it('refuses a session signing secret that is too short to be one', () => {
    expect(() =>
      parseRuntimeEnv({
        DATABASE_URL: POOLED,
        APP_URL: 'http://localhost:3000',
        NODE_ENV: 'test',
        BETTER_AUTH_SECRET: 'short',
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });
});

describe('DATABASE_URL_AUTH — the authentication plane’s own login (0072/0073)', () => {
  const AUTH = 'postgresql://u:p@ep-x-auth-pooler.ap-southeast-1.aws.neon.tech/db';
  const base = {
    DATABASE_URL: POOLED,
    APP_URL: 'https://os.pravshi.com',
    NODE_ENV: 'production',
    BETTER_AUTH_SECRET: SECRET,
  };

  it('is required on Vercel — a deployment without it is refused, a blank value counts as missing', () => {
    expect(() => parseRuntimeEnv({ ...base, VERCEL: '1' })).toThrow(
      /DATABASE_URL_AUTH must be set on Vercel/,
    );
    expect(() => parseRuntimeEnv({ ...base, VERCEL: '1', DATABASE_URL_AUTH: '' })).toThrow(
      /DATABASE_URL_AUTH must be set on Vercel/,
    );
    expect(
      parseRuntimeEnv({ ...base, VERCEL: '1', DATABASE_URL_AUTH: AUTH }).DATABASE_URL_AUTH,
    ).toBe(AUTH);
  });

  it('never falls back to the business connection: the same URL as DATABASE_URL is refused', () => {
    expect(() => parseRuntimeEnv({ ...base, DATABASE_URL_AUTH: POOLED })).toThrow(
      /must not be the same connection string as DATABASE_URL/,
    );
  });

  it('must use the pooled endpoint', () => {
    expect(() => parseRuntimeEnv({ ...base, DATABASE_URL_AUTH: DIRECT })).toThrow(
      /DATABASE_URL_AUTH must use the pooled/,
    );
  });

  it('is absent on the worker host, which parses without it (runner.ts refuses its presence)', () => {
    const parsed = parseRuntimeEnv({
      ...base,
      DATABASE_URL_WORKER: POOLED.replace('ep-x', 'ep-w'),
    });
    expect(parsed.DATABASE_URL_AUTH).toBeUndefined();
  });
});

describe('DATABASE_URL_PLATFORM — the platform console’s own login (0083–0086, ADR-008)', () => {
  const AUTH = 'postgresql://u:p@ep-x-auth-pooler.ap-southeast-1.aws.neon.tech/db';
  const PLATFORM = 'postgresql://u:p@ep-x-platform-pooler.ap-southeast-1.aws.neon.tech/db';
  const base = {
    DATABASE_URL: POOLED,
    DATABASE_URL_AUTH: AUTH,
    APP_URL: 'https://os.pravshi.com',
    NODE_ENV: 'production',
    BETTER_AUTH_SECRET: SECRET,
  };

  it('is optional: without it the console is unavailable, and nothing else changes', () => {
    expect(parseRuntimeEnv(base).DATABASE_URL_PLATFORM).toBeUndefined();
    expect(
      parseRuntimeEnv({ ...base, DATABASE_URL_PLATFORM: PLATFORM }).DATABASE_URL_PLATFORM,
    ).toBe(PLATFORM);
  });

  it('never borrows another login: the business or the authentication URL is refused', () => {
    for (const same of [POOLED, AUTH]) {
      expect(() => parseRuntimeEnv({ ...base, DATABASE_URL_PLATFORM: same })).toThrow(
        /DATABASE_URL_PLATFORM must not be the same connection string/,
      );
    }
  });

  it('must use the pooled endpoint', () => {
    expect(() => parseRuntimeEnv({ ...base, DATABASE_URL_PLATFORM: DIRECT })).toThrow(
      /DATABASE_URL_PLATFORM must use the pooled/,
    );
  });
});

describe('parseToolingEnv', () => {
  it('rejects a pooled URL for migrations', () => {
    expect(() => parseToolingEnv({ DATABASE_URL_MIGRATE: POOLED })).toThrow(
      /DATABASE_URL_MIGRATE must use the direct/,
    );
  });

  it('accepts a direct URL for migrations', () => {
    expect(parseToolingEnv({ DATABASE_URL_MIGRATE: DIRECT }).DATABASE_URL_MIGRATE).toBe(DIRECT);
  });
});
