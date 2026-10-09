import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Invitation acceptance — the pre-auth half — with the database replaced.
 *
 * F-11-07: accept is the product's primary account-creation path, and until
 * Phase 11 it enforced password LENGTH only while reset/change also ran the
 * common-password list and the HIBP breach check (validateNewPasswordPolicy).
 * These cases prove the parity at the flow level: every weak-password reason
 * refuses BEFORE the token is previewed and before any scrypt hash is spent;
 * a strong password flows through preview → hash → accept_invitation exactly
 * as before. The database side of the accept contract is pinned separately
 * (tests/guards/invitation-accept-contract.test.ts, tests/integration).
 *
 * The breach check's fetch is stubbed — no network in tests (the Phase 9
 * adapter-test precedent). By default the range answer matches nothing; a
 * case names the one password the stub reports as breached.
 */

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  hash: vi.fn(async () => `${'a'.repeat(32)}:${'b'.repeat(128)}`),
  // Mutable so a case can lower the length floor: every entry in the curated
  // common-password list is shorter than the production minimum of 12, and
  // the shared policy checks length first, so the TOO_COMMON branch is
  // unreachable under the default config — here and in production alike.
  config: { minPasswordLength: 12, maxPasswordLength: 128 },
}));

vi.mock('@/env', () => ({ env: { APP_URL: 'https://os.pravshi.com', NODE_ENV: 'test' } }));
vi.mock('@/lib/auth/server', () => ({
  auth: {
    $context: Promise.resolve({
      password: { hash: mocks.hash, config: mocks.config },
    }),
  },
}));
vi.mock('@/lib/db/auth-client', () => ({ authDb: { execute: mocks.execute } }));
// acceptInvitation never reaches the authorised half of the invitations
// service (only its InvitationError type crosses), but the import must
// resolve without opening the real database path.
vi.mock('@/lib/db/authorized', () => ({ withAuthorizedDb: vi.fn() }));

const { acceptInvitation } = await import('@/lib/auth/invitations');
const { InvitationError } = await import('@/lib/invitations/service');

const TOKEN = 'invitation-token-plaintext';
const STRONG = 'a very strong passphrase 42';

const dialect = new PgDialect();
const rendered = () => mocks.execute.mock.calls.map(([query]) => dialect.sqlToQuery(query as SQL));

const livePreview = () =>
  mocks.execute.mockResolvedValueOnce({
    rows: [{ email: 'invitee@example.test', org_name: 'Acme', valid: true }],
  });
const accepted = () =>
  mocks.execute.mockResolvedValueOnce({
    rows: [{ person_id: 'person-1', auth_user_id: 'user-1', org_id: 'org-1' }],
  });

let breachedPassword: string | null = null;

const hibpBody = () => {
  if (!breachedPassword) return 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1\n';
  const sha1 = createHash('sha1').update(breachedPassword, 'utf8').digest('hex').toUpperCase();
  return `${sha1.slice(5)}:12345\n`;
};

beforeEach(() => {
  mocks.execute.mockReset();
  mocks.hash.mockClear();
  mocks.config.minPasswordLength = 12;
  mocks.config.maxPasswordLength = 128;
  breachedPassword = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(hibpBody(), { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const attempt = (password: string) =>
  acceptInvitation({ token: TOKEN, fullName: 'Invitee Person', password });

describe('acceptInvitation password policy (F-11-07)', () => {
  it('refuses a too-short password as PASSWORD_TOO_SHORT, without touching the token or the hasher', async () => {
    await expect(attempt('short')).rejects.toMatchObject({
      name: 'InvitationError',
      code: 'PASSWORD_TOO_SHORT',
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
  });

  it('refuses a too-long password as PASSWORD_TOO_LONG', async () => {
    await expect(attempt('x'.repeat(129))).rejects.toMatchObject({
      name: 'InvitationError',
      code: 'PASSWORD_TOO_LONG',
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
  });

  it('refuses a password on the common-password list as PASSWORD_TOO_COMMON', async () => {
    mocks.config.minPasswordLength = 8; // see the mocks.config note
    const error = await attempt('password123').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvitationError);
    expect(error).toMatchObject({ code: 'PASSWORD_TOO_COMMON' });
    // The refusal precedes the preview: the token was never consulted, so a
    // weak password leaks nothing about which invitations exist.
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
  });

  it('refuses a password the breach check reports as PASSWORD_BREACHED', async () => {
    breachedPassword = STRONG;
    await expect(attempt(STRONG)).rejects.toMatchObject({
      name: 'InvitationError',
      code: 'PASSWORD_BREACHED',
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.hash).not.toHaveBeenCalled();
  });

  it('accepts a strong password: preview, then the library hash, then accept_invitation', async () => {
    livePreview();
    accepted();
    await expect(attempt(STRONG)).resolves.toEqual({ personId: 'person-1', orgId: 'org-1' });
    expect(mocks.hash).toHaveBeenCalledWith(STRONG);

    const queries = rendered();
    expect(queries.length).toBe(2);
    expect(queries[0]!.sql).toContain('invitation_preview');
    expect(queries[1]!.sql).toContain('accept_invitation');
    // The plaintext token never reaches the database — only its digest does.
    expect(JSON.stringify(queries)).not.toContain(TOKEN);
  });

  it('a dead invitation still answers INVITATION_INVALID once the password passes policy', async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [{ email: 'invitee@example.test', org_name: 'Acme', valid: false }],
    });
    await expect(attempt(STRONG)).rejects.toMatchObject({
      name: 'InvitationError',
      code: 'INVITATION_INVALID',
    });
    expect(mocks.hash).not.toHaveBeenCalled();
  });
});
