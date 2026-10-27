import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The platform operator's commands (scripts/bootstrap/platform.mjs), without a database: the
 * refusals, the token and link, and the operator-role check. The statements themselves run
 * against a real database in tests/serial/platform-console.test.ts.
 */
const cli = await import('../../scripts/bootstrap/platform.mjs');
const { SETUP_TOKEN_PATTERN } = await import('@/lib/auth/setup-token');

// Assembled at runtime: this file is itself scanned for credential-shaped literals.
const PASSWORD = 'fixture-only-password';
const DIRECT_ADMIN =
  ['postgresql://app_admin', `${PASSWORD}@ep-quiet-lab-123456.ap-southeast-1.aws.neon.tech`].join(
    ':',
  ) + '/neondb';
const SETTINGS = { DATABASE_URL_BOOTSTRAP: DIRECT_ADMIN, APP_URL: 'https://os.pravshi.com' };

const refusal = (argv: string[], settings = SETTINGS, env: Record<string, string> = {}) => {
  try {
    cli.readOperatorConfig(cli.parseArgs(argv), settings, env);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};

describe('arguments and configuration', () => {
  it('accepts each command with exactly its arguments', () => {
    expect(refusal(['first-admin', '--email', 'a@b.example', '--name', 'A B'])).toBeNull();
    expect(refusal(['reissue-setup', '--email', 'a@b.example'])).toBeNull();
    expect(
      refusal(['recover', '--email', 'a@b.example', '--reason', 'lost the authenticator']),
    ).toBeNull();
  });

  it('refuses unknown commands, unknown flags and misplaced arguments', () => {
    expect(refusal(['bootstrap', '--email', 'a@b.example'])).toMatch(/command must be one of/);
    expect(refusal(['first-admin', '--email', 'a@b.example', '--role', 'x'])).toMatch(
      /unexpected argument/,
    );
    expect(refusal(['first-admin', '--email', 'a@b.example'])).toMatch(/--name is required/);
    expect(refusal(['reissue-setup', '--email', 'a@b.example', '--name', 'A'])).toMatch(
      /--name is only for first-admin/,
    );
    expect(refusal(['recover', '--email', 'a@b.example', '--reason', 'short'])).toMatch(
      /--reason \(10-500/,
    );
    expect(refusal(['reissue-setup', '--email', 'not-an-address'])).toMatch(/--email/);
  });

  it('never runs in CI, and only as app_admin on a direct endpoint', () => {
    const ok = ['reissue-setup', '--email', 'a@b.example'];
    expect(refusal(ok, SETTINGS, { CI: 'true' })).toMatch(/never run in CI/);
    expect(
      refusal(ok, {
        ...SETTINGS,
        DATABASE_URL_BOOTSTRAP: DIRECT_ADMIN.replace('app_admin', 'app_owner'),
      }),
    ).toMatch(/operator role, app_admin/);
    expect(
      refusal(ok, {
        ...SETTINGS,
        DATABASE_URL_BOOTSTRAP: DIRECT_ADMIN.replace('-123456', '-123456-pooler'),
      }),
    ).toMatch(/direct endpoint/);
    expect(refusal(ok, { ...SETTINGS, APP_URL: 'http://os.pravshi.com' })).toMatch(/https/);
  });

  it('never echoes a credential while refusing', () => {
    const message = refusal(['nope'], { ...SETTINGS, APP_URL: '' }) ?? '';
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain('ep-quiet-lab');
  });
});

describe('runPlatformOperation()', () => {
  const config = () =>
    cli.readOperatorConfig(
      cli.parseArgs(['reissue-setup', '--email', 'a@b.example']),
      SETTINGS,
      {},
    );

  class FakeClient {
    static role = 'app_admin';
    static queries: { text: string; params?: unknown[] }[] = [];
    connect() {
      return Promise.resolve();
    }
    query(text: string, params?: unknown[]) {
      FakeClient.queries.push({ text, params });
      if (text.startsWith('select session_user')) {
        return Promise.resolve({ rows: [{ role: FakeClient.role }] });
      }
      return Promise.resolve({ rows: [{ expires_at: new Date(Date.now() + 3_600_000) }] });
    }
    end() {
      return Promise.resolve();
    }
  }

  it('sends only the digest, and delivers a fragment link once after COMMIT', async () => {
    FakeClient.role = 'app_admin';
    FakeClient.queries = [];
    const delivered: { link: string; committed: unknown }[] = [];
    await cli.runPlatformOperation(config(), {
      deliver: (d: { link: string; committed: unknown }) => delivered.push(d),
      Client: FakeClient as never,
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.committed).toBe(true);
    const url = new URL(delivered[0]!.link);
    expect(url.pathname).toBe('/platform/setup');
    expect(url.search).toBe('');
    const token = url.hash.replace('#token=', '');
    expect(token).toMatch(SETUP_TOKEN_PATTERN);
    const digest = createHash('sha256').update(token, 'utf8').digest('hex');
    const statement = FakeClient.queries.find((q) => q.text.includes('platform.reissue_setup'))!;
    expect(statement.params).toEqual(['a@b.example', digest]);
    expect(JSON.stringify(FakeClient.queries)).not.toContain(token);
    expect(FakeClient.queries.map((q) => q.text)).toContain('commit');
  });

  it('refuses before starting a transaction when the session is not app_admin', async () => {
    FakeClient.role = 'app_owner';
    FakeClient.queries = [];
    let delivered = 0;
    await expect(
      cli.runPlatformOperation(config(), {
        deliver: () => (delivered += 1),
        Client: FakeClient as never,
      }),
    ).rejects.toThrow(/not authenticated as app_admin/);
    expect(delivered).toBe(0);
    expect(FakeClient.queries.map((q) => q.text)).not.toContain('begin');
  });

  it('the script refuses a non-interactive stdout and writes no files', () => {
    const source = readFileSync('scripts/bootstrap/platform.mjs', 'utf8');
    expect(source).toMatch(/if \(!process\.stdout\.isTTY\)/);
    expect(source).not.toMatch(/writeFile|appendFile|GITHUB_OUTPUT|GITHUB_ENV/);
  });
});
