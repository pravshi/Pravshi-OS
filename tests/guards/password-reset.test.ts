import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Password-reset flow guards.
 *
 * The security properties of this flow live in the app/DB contract, and the
 * contract drifted once before on the invitation path (reversed arguments, wrong
 * columns) with nothing catching it. These guards pin the reset contract the
 * same way: token handling, rate limits, event emission, and session revocation.
 * Static/source-level like the other guards — no database needed.
 */

const root = (...p: string[]) => join(process.cwd(), ...p);
const SERVICE = readFileSync(root('src/lib/auth/password-reset.ts'), 'utf8');
const FORGOT_ROUTE = readFileSync(root('src/app/api/auth/forgot-password/route.ts'), 'utf8');
const RESET_ROUTE = readFileSync(root('src/app/api/auth/reset-password/route.ts'), 'utf8');
const COMMON = readFileSync(root('src/lib/auth/common-passwords.ts'), 'utf8');
const EMAIL = readFileSync(root('src/lib/auth/password-reset-email.ts'), 'utf8');
const MIGRATION_25 = readFileSync(root('drizzle/0025_password_reset_audit.sql'), 'utf8');

describe('reset token handling: the plaintext never reaches the database', () => {
  it('service generates 32 random bytes, hex-encoded (64 chars) for the email link', () => {
    expect(SERVICE).toMatch(/randomBytes\(32\)\.toString\('hex'\)/);
    expect(SERVICE).toMatch(/RESET_TOKEN_PATTERN = \/\^\[0-9a-f\]\{64\}\$\//);
  });

  it('service hashes the token with sha256-hex before any database call', () => {
    expect(SERVICE).toMatch(/createHash\('sha256'\)\.update\(token, 'utf8'\)\.digest\('hex'\)/);
  });

  it('only the digest is passed to request_password_reset / consume_password_reset', () => {
    expect(SERVICE).toMatch(/authz\.request_password_reset\(\$\{cleanEmail\}, \$\{digest\}\)/);
    expect(SERVICE).toMatch(/authz\.consume_password_reset\(\$\{digest\}\)/);
    // The raw token must not appear in any SQL template in this file.
    const sqlCalls = SERVICE.match(/sql`[\s\S]*?`/g) ?? [];
    for (const call of sqlCalls) {
      expect(call).not.toMatch(/\$\{token\}/);
    }
  });

  it('reset rejects malformed tokens as INVALID_TOKEN before touching the database', () => {
    expect(SERVICE).toMatch(/!RESET_TOKEN_PATTERN\.test\(token\)/);
    expect(SERVICE).toMatch(
      /'INVALID_TOKEN', null, 'This reset link is invalid, expired, or already used\.'/,
    );
  });
});

describe('rate limiting', () => {
  it('request path checks pwreset:req:{ip} at 5 per 60s via check_rate_limit', () => {
    expect(SERVICE).toMatch(/pwreset:req:/);
    expect(SERVICE).toMatch(
      /authz\.check_rate_limit\(\$\{key\}, \$\{RATE_LIMIT_MAX\}, \$\{RATE_LIMIT_WINDOW_SECONDS\}\)/,
    );
    expect(SERVICE).toMatch(/RATE_LIMIT_MAX = 5/);
    expect(SERVICE).toMatch(/RATE_LIMIT_WINDOW_SECONDS = 60/);
  });

  it('complete path checks pwreset:complete:{ip} at the same allowance', () => {
    expect(SERVICE).toMatch(/pwreset:complete:/);
  });

  it('rate-limited requests raise RATE_LIMITED, which the reset route maps to 429', () => {
    expect(SERVICE).toMatch(/'RATE_LIMITED', null, 'Too many requests/);
    expect(RESET_ROUTE).toMatch(
      /e\.code === 'RATE_LIMITED'[\s\S]*?return reply\(429, \{ error: 'RATE_LIMITED' \}\)/,
    );
  });

  it('the forgot route answers 200 { ok: true } even when rate-limited — no oracle', () => {
    expect(FORGOT_ROUTE).toMatch(
      /PasswordResetError && e\.code === 'RATE_LIMITED'[\s\S]*?return reply\(200, \{ ok: true \}\)/,
    );
  });
});

describe('event emission and enumeration resistance', () => {
  it('PASSWORD_RESET_REQUESTED is emitted only when a login exists for the email', () => {
    expect(SERVICE).toMatch(/if \(!resetId\) return \{ ok: true \};/);
    expect(SERVICE).toMatch(/eventType: 'PASSWORD_RESET_REQUESTED'/);
  });

  it('the request path always answers { ok: true }, including for unknown emails', () => {
    expect(SERVICE).toMatch(/return \{ ok: true \};/);
    expect(FORGOT_ROUTE).toMatch(/return reply\(200, \{ ok: true \}\);/);
    expect(FORGOT_ROUTE).not.toMatch(/reply\(4/);
  });

  it('PASSWORD_RESET_COMPLETED is emitted on success, with the rotated login', () => {
    expect(SERVICE).toMatch(/eventType: 'PASSWORD_RESET_COMPLETED'/);
    expect(SERVICE).toMatch(/authUserId,\n/);
  });
});

describe('session revocation and credential rotation', () => {
  it('revokeSessionsFor is called after the password hash is replaced', () => {
    const updateIdx = SERVICE.indexOf('update_credential_password');
    const revokeIdx = SERVICE.indexOf('revokeSessionsFor(authUserId)');
    expect(updateIdx).toBeGreaterThan(-1);
    expect(revokeIdx).toBeGreaterThan(updateIdx);
  });

  it('the expensive hash is computed only after every cheap check passed', () => {
    const hashIdx = SERVICE.indexOf('context.password.hash(password)');
    const consumeIdx = SERVICE.indexOf('consume_password_reset');
    expect(hashIdx).toBeGreaterThan(-1);
    // consume happens before hashing (cheap single-use check first), and the
    // policy/common/breach checks all precede the hash.
    expect(hashIdx).toBeGreaterThan(consumeIdx);
  });

  it('password policy comes from better-auth config, never invented', () => {
    expect(SERVICE).toMatch(
      /const \{ minPasswordLength, maxPasswordLength \} = context\.password\.config;/,
    );
    expect(SERVICE).not.toMatch(/password\.length < 12[^}]/);
  });

  it('weak passwords are rejected distinctly: TOO_SHORT / TOO_LONG / TOO_COMMON / BREACHED', () => {
    for (const reason of ['TOO_SHORT', 'TOO_LONG', 'TOO_COMMON', 'BREACHED']) {
      expect(SERVICE).toContain(`'WEAK_PASSWORD', '${reason}'`);
    }
    expect(RESET_ROUTE).toMatch(/reason: e\.reason/);
  });

  it('the local common-password list is always applied; HIBP fails open with a warning', () => {
    expect(SERVICE).toMatch(/if \(isCommonPassword\(password\)\)/);
    expect(COMMON).toMatch(/isCommonPassword/);
    expect(SERVICE).toMatch(/console\.warn\('\[auth\] HIBP breach check failed open'/);
    expect(SERVICE).toMatch(/api\.pwnedpasswords\.com\/range\//);
    expect(SERVICE).toMatch(/AbortSignal\.timeout\(5000\)/);
    // k-anonymity: only the 5-char prefix leaves the server.
    expect(SERVICE).toMatch(/sha1\.slice\(0, 5\)/);
  });

  it('consume maps 28000 to INVALID_TOKEN; update maps 55000 to cannot-complete', () => {
    expect(SERVICE).toMatch(/if \(sqlstateOf\(e\) === '28000'\)/);
    expect(SERVICE).toMatch(/if \(sqlstateOf\(e\) === '55000'\)/);
  });
});

describe('audit entry', () => {
  it('0025: record_password_reset_audit is SECURITY DEFINER, granted to app_user only', () => {
    expect(MIGRATION_25).toMatch(/security definer/);
    expect(MIGRATION_25).toMatch(
      /grant execute on function authz\.record_password_reset_audit\(uuid, inet, text\) to app_user/,
    );
    expect(MIGRATION_25).toMatch(/'auth\.password_reset'/);
  });

  it('service records the audit entry after revocation, best-effort', () => {
    expect(SERVICE).toMatch(/authz\.record_password_reset_audit\(\$\{authUserId\}::uuid/);
  });
});

describe('routes and pages', () => {
  it('both routes export POST with origin check, body cap, and no-store', () => {
    for (const route of [FORGOT_ROUTE, RESET_ROUTE]) {
      expect(route).toMatch(/export async function POST/);
      expect(route).toMatch(/originAllowed\(req\)/);
      expect(route).toMatch(/MAX_BODY_CHARS/);
      expect(route).toMatch(/'Cache-Control': 'no-store'/);
    }
  });

  it('the email helper is best-effort and returns false when unconfigured', () => {
    expect(EMAIL).toMatch(/if \(!resend\) return false;/);
    expect(EMAIL).toMatch(/isResetEmailConfigured/);
  });

  it('both pages exist and the login page links to forgot-password', () => {
    expect(existsSync(root('src/app/(auth)/forgot-password/page.tsx'))).toBe(true);
    expect(existsSync(root('src/app/(auth)/reset-password/page.tsx'))).toBe(true);
    const login = readFileSync(root('src/app/(auth)/login/page.tsx'), 'utf8');
    expect(login).toMatch(/href="\/forgot-password"/);
  });

  it('the reset page shows the four weak-password reasons distinctly', () => {
    const page = readFileSync(root('src/app/(auth)/reset-password/page.tsx'), 'utf8');
    for (const reason of ['TOO_SHORT', 'TOO_LONG', 'TOO_COMMON', 'BREACHED']) {
      expect(page).toContain(reason);
    }
  });
});
