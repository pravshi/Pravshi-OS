import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * Task 1.14 — the operator's bootstrap script, without a database.
 *
 * What is proven here is everything about the setup token that happens before and around the
 * database call: how it is made, that only its digest is ever sent, that the link carries it
 * in a fragment, that it is delivered only once the bootstrap is known (or possibly) committed,
 * and that the script refuses the environments it must never run in.
 */

vi.mock('@/lib/auth/server', () => ({ auth: {} }));
vi.mock('@/lib/db/auth-client', () => ({ authDb: {} }));

const cli = await import('../../scripts/bootstrap/run.mjs');
const runtime = await import('@/lib/auth/bootstrap-setup');
const { SETUP_TOKEN_PATTERN } = await import('@/lib/auth/setup-token');

// Assembled at runtime: this file is itself scanned for credential-shaped literals.
const PASSWORD = 'fixture-only-password';
const DIRECT_ADMIN =
  ['postgresql://app_admin', `${PASSWORD}@ep-quiet-lab-123456.ap-southeast-1.aws.neon.tech`].join(
    ':',
  ) + '/neondb';

const settings = (overrides: Record<string, string> = {}) => ({
  DATABASE_URL_BOOTSTRAP: DIRECT_ADMIN,
  APP_URL: 'https://os.pravshi.com',
  BOOTSTRAP_ORG_NAME: 'PRAVSHI',
  BOOTSTRAP_ORG_SLUG: 'pravshi',
  BOOTSTRAP_OWNER_NAME: 'Founder Person',
  BOOTSTRAP_OWNER_EMAIL: 'founder@example.test',
  ...overrides,
});

const refusal = (s: Record<string, string>, env: Record<string, string> = {}) => {
  try {
    cli.readBootstrapConfig(s, env);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};

describe('the setup token', () => {
  it('is 32 CSPRNG bytes, base64url, in exactly the shape the runtime accepts', () => {
    const token = cli.generateSetupToken();
    expect(cli.SETUP_TOKEN_BYTES).toBe(32);
    expect(token).toMatch(SETUP_TOKEN_PATTERN);
    expect(Buffer.from(token, 'base64url').length).toBe(32);
  });

  it('is never repeated', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => cli.generateSetupToken()));
    expect(seen.size).toBe(2000);
  });

  it('is hashed identically by the script and by the runtime, as SHA-256', () => {
    const token = cli.generateSetupToken();
    const expected = createHash('sha256').update(token, 'utf8').digest('hex');
    expect(cli.hashSetupToken(token)).toBe(expected);
    expect(runtime.hashSetupToken(token)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('travels in a URL fragment, which no server or Referer ever receives', () => {
    const token = cli.generateSetupToken();
    const link = new URL(cli.setupLinkFor('https://os.pravshi.com', token));
    expect(link.origin).toBe('https://os.pravshi.com');
    expect(link.pathname).toBe('/setup');
    expect(link.search).toBe('');
    expect(link.hash).toBe(`#token=${token}`);
  });
});

describe('configuration', () => {
  it('accepts a complete, well-formed configuration', () => {
    const config = cli.readBootstrapConfig(settings(), {});
    expect(config.appOrigin).toBe('https://os.pravshi.com');
    expect(config.orgSlug).toBe('pravshi');
    expect(config.ownerEmail).toBe('founder@example.test');
  });

  it('refuses to run in CI at all', () => {
    expect(refusal(settings(), { CI: 'true' })).toMatch(/never runs in CI/);
    expect(refusal(settings(), { GITHUB_ACTIONS: 'true' })).toMatch(/never runs in CI/);
  });

  it('refuses a pooled endpoint, and any role but app_admin', () => {
    const pooled = DIRECT_ADMIN.replace('ep-quiet-lab-123456', 'ep-quiet-lab-123456-pooler');
    expect(refusal(settings({ DATABASE_URL_BOOTSTRAP: pooled }))).toMatch(/direct endpoint/);

    const owner = DIRECT_ADMIN.replace('app_admin', 'app_owner');
    expect(refusal(settings({ DATABASE_URL_BOOTSTRAP: owner }))).toMatch(/app_admin/);
    const user = DIRECT_ADMIN.replace('app_admin', 'app_user');
    expect(refusal(settings({ DATABASE_URL_BOOTSTRAP: user }))).toMatch(/app_admin/);
  });

  it('refuses a link that would carry the token over plain http, except to localhost', () => {
    expect(refusal(settings({ APP_URL: 'http://os.pravshi.com' }))).toMatch(/https/);
    expect(refusal(settings({ APP_URL: 'http://localhost:3000' }))).toBeNull();
  });

  it('refuses a missing or malformed owner, organization or slug', () => {
    expect(refusal(settings({ BOOTSTRAP_OWNER_EMAIL: 'not-an-email' }))).toMatch(/OWNER_EMAIL/);
    expect(refusal(settings({ BOOTSTRAP_ORG_SLUG: 'Not A Slug' }))).toMatch(/ORG_SLUG/);
    expect(refusal(settings({ BOOTSTRAP_OWNER_NAME: '' }))).toMatch(/OWNER_NAME/);
    expect(refusal(settings({ BOOTSTRAP_ORG_NAME: '' }))).toMatch(/ORG_NAME/);
  });

  it('never echoes a credential while refusing', () => {
    const message = refusal(settings({ BOOTSTRAP_ORG_SLUG: 'BAD' }), { CI: 'true' });
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain('ep-quiet-lab-123456');
  });

  it('takes the process environment over .env, and treats a blank value as unset', () => {
    const file = new Map([
      ['APP_URL', 'https://from-file.example'],
      ['BOOTSTRAP_ORG_NAME', 'From File'],
    ]);
    const merged = cli.settingsFrom(
      { APP_URL: 'https://from-process.example', BOOTSTRAP_ORG_NAME: '' },
      file,
    );
    expect(merged.APP_URL).toBe('https://from-process.example');
    expect(merged.BOOTSTRAP_ORG_NAME).toBe('From File');
  });

  it('redacts the password, host and endpoint label from anything printed', () => {
    const redact = cli.redactorFor(DIRECT_ADMIN);
    const out = redact(
      `connect to ${DIRECT_ADMIN} failed: host ep-quiet-lab-123456.ap-southeast-1.aws.neon.tech ${PASSWORD}`,
    );
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain('ep-quiet-lab-123456');
    expect(out).not.toMatch(/postgres(ql)?:\/\//);
  });
});

// ── delivery ─────────────────────────────────────────────────────────────────────

type Call = { text: string; params?: unknown[] };

/** A stand-in for pg.Client that records every query and fails where it is told to. */
function fakeClient(opts: { role?: string; bootstrapError?: unknown; commitError?: unknown }) {
  const calls: Call[] = [];
  class FakeClient {
    async connect() {}
    async end() {}
    async query(text: string, params?: unknown[]) {
      calls.push({ text, params });
      if (text.includes('session_user')) return { rows: [{ role: opts.role ?? 'app_admin' }] };
      if (text.includes('bootstrap_organization')) {
        if (opts.bootstrapError) throw opts.bootstrapError;
        return {
          rows: [
            {
              organization_id: 'org',
              owner_person_id: 'person',
              owner_engagement_id: 'engagement',
              setup_token_expires_at: new Date(Date.now() + 3_600_000),
            },
          ],
        };
      }
      if (text === 'commit' && opts.commitError) throw opts.commitError;
      return { rows: [] };
    }
  }
  return { calls, Client: FakeClient };
}

const config = () => cli.readBootstrapConfig(settings(), {});

describe('runBootstrap()', () => {
  it('sends the database the digest and never the token, then delivers the link once', async () => {
    const { calls, Client } = fakeClient({});
    const delivered: { link: string; committed: unknown }[] = [];
    await cli.runBootstrap(config(), { Client, deliver: (d: never) => delivered.push(d) });

    expect(delivered.length).toBe(1);
    expect(delivered[0]!.committed).toBe(true);
    const token = new URL(delivered[0]!.link).hash.replace('#token=', '');
    expect(token).toMatch(SETUP_TOKEN_PATTERN);

    const everythingSent = JSON.stringify(calls);
    expect(everythingSent).not.toContain(token);
    const call = calls.find((c) => c.text.includes('bootstrap_organization'))!;
    expect(call.params).toContain(runtime.hashSetupToken(token));
    expect(calls.map((c) => c.text)).toContain('commit');
  });

  it('refuses before starting a transaction when the session is not app_admin', async () => {
    const { calls, Client } = fakeClient({ role: 'app_owner' });
    const deliver = vi.fn();
    await expect(cli.runBootstrap(config(), { Client, deliver })).rejects.toThrow(/app_admin/);
    expect(calls.map((c) => c.text)).not.toContain('begin');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('delivers nothing and rolls back when the database refuses the bootstrap', async () => {
    const refused = Object.assign(new Error('already bootstrapped'), { code: '55000' });
    const { calls, Client } = fakeClient({ bootstrapError: refused });
    const deliver = vi.fn();
    await expect(cli.runBootstrap(config(), { Client, deliver })).rejects.toThrow(/already/);
    expect(calls.map((c) => c.text)).toContain('rollback');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('delivers nothing when the COMMIT is definitively refused by the server', async () => {
    const refused = Object.assign(new Error('deferred constraint'), { code: '23503' });
    const { Client } = fakeClient({ commitError: refused });
    const deliver = vi.fn();
    await expect(cli.runBootstrap(config(), { Client, deliver })).rejects.toThrow();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('delivers the link marked UNKNOWN when the COMMIT goes unanswered', async () => {
    const lost = Object.assign(new Error('Connection terminated unexpectedly'), {});
    const { Client } = fakeClient({ commitError: lost });
    const deliver = vi.fn();
    await expect(cli.runBootstrap(config(), { Client, deliver })).rejects.toThrow();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![0].committed).toBe('unknown');
  });
});

describe('the script as a file', () => {
  const source = readFileSync('scripts/bootstrap/run.mjs', 'utf8');

  it('writes no files and no CI outputs', () => {
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream|GITHUB_OUTPUT/);
  });

  it('refuses a non-interactive stdout, and checks it before bootstrapping', () => {
    const main = source.slice(source.indexOf('async function main'));
    expect(main.indexOf('process.stdout.isTTY')).toBeGreaterThan(-1);
    expect(main.indexOf('process.stdout.isTTY')).toBeLessThan(main.indexOf('runBootstrap('));
  });
});
