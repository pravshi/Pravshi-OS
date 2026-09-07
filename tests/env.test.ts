import { describe, expect, it } from 'vitest';
import { parseRuntimeEnv, parseToolingEnv } from '@/env';

const POOLED = 'postgresql://u:p@ep-x-pooler.ap-southeast-1.aws.neon.tech/db';
const DIRECT = 'postgresql://u:p@ep-x.ap-southeast-1.aws.neon.tech/db';

describe('parseRuntimeEnv', () => {
  it('rejects a direct URL for the runtime connection', () => {
    expect(() =>
      parseRuntimeEnv({ DATABASE_URL: DIRECT, APP_URL: 'http://localhost:3000', NODE_ENV: 'test' }),
    ).toThrow(/DATABASE_URL must use the pooled/);
  });

  it('REFUSES TO BOOT if the migration credential is present in production', () => {
    expect(() =>
      parseRuntimeEnv({
        DATABASE_URL: POOLED,
        DATABASE_URL_MIGRATE: DIRECT,
        APP_URL: 'https://os.pravshi.com',
        NODE_ENV: 'production',
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
    });
    expect(env.APP_URL).toBe('https://os.pravshi.com');
  });

  it('accepts a correct runtime environment', () => {
    const env = parseRuntimeEnv({
      DATABASE_URL: POOLED,
      APP_URL: 'http://localhost:3000',
      NODE_ENV: 'test',
    });
    expect(env.APP_URL).toBe('http://localhost:3000');
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
