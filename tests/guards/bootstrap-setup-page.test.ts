import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * /setup page guards.
 *
 * The page is the frontend half of the 0015 bootstrap flow: it reads the #token=…
 * fragment the operator's script printed and posts the owner's first password to
 * /api/bootstrap/complete. These guards pin the security properties statically —
 * no database needed:
 *
 * - the server redirects to /login unless a live setup token exists (not a
 *   client-side check);
 * - the token travels in the URL fragment, never a query string;
 * - the token shape is validated before use, and nothing logs it;
 * - the migration function the guard calls is narrow (one bit, app_user only).
 */

const root = (...p: string[]) => join(process.cwd(), ...p);
const PAGE = readFileSync(root('src/app/setup/page.tsx'), 'utf8');
const FORM = readFileSync(root('src/app/setup/setup-form.tsx'), 'utf8');
const SERVICE = readFileSync(root('src/lib/auth/bootstrap-setup.ts'), 'utf8');
const MIGRATION = readFileSync(root('drizzle/0026_bootstrap_setup_pending.sql'), 'utf8');

describe('/setup server guard', () => {
  it('page checks setup-pending on the server and redirects to /login when false', () => {
    expect(PAGE).toMatch(/isBootstrapSetupPending\(\)/);
    expect(PAGE).toMatch(/redirect\(['"]\/login['"]\)/);
    // The redirect must happen before any rendering — guard first.
    const guardAt = PAGE.indexOf('isBootstrapSetupPending()');
    const returnAt = PAGE.indexOf('return (');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(returnAt);
  });

  it('page is dynamic (no static prerender of a one-time gate)', () => {
    expect(PAGE).toMatch(/export const dynamic = 'force-dynamic'/);
  });

  it('service helper queries only the narrow pending function', () => {
    expect(SERVICE).toMatch(/bootstrap_setup_pending\(\)/);
    // No direct table access: the tables stay reachable only through functions.
    const helper = SERVICE.slice(SERVICE.indexOf('isBootstrapSetupPending'));
    expect(helper).not.toMatch(/bootstrap_state/);
    expect(helper).not.toMatch(/bootstrap_setup_token[^_]/);
  });
});

describe('setup token handling', () => {
  it('form reads the token from the URL fragment, never the query string', () => {
    expect(FORM).toMatch(/window\.location\.hash/);
    expect(FORM).not.toMatch(/useSearchParams/);
    expect(FORM).not.toMatch(/searchParams\.get\(['"]token['"]\)/);
  });

  it('form validates the token shape before use', () => {
    expect(FORM).toMatch(/SETUP_TOKEN_PATTERN\.test\(token\)/);
  });

  it('form posts token and password in the body, then routes to /login on success', () => {
    expect(FORM).toMatch(/fetch\(['"]\/api\/bootstrap\/complete['"]/);
    expect(FORM).toMatch(/JSON\.stringify\(\{ token, password \}\)/);
    expect(FORM).toMatch(/router\.push\(['"]\/login['"]\)/);
  });

  it('form never logs the token', () => {
    expect(FORM).not.toMatch(/console\.(log|error|warn)/);
  });

  it('form applies the password policy client-side (length, common, breach)', () => {
    expect(FORM).toMatch(/minPasswordLength/);
    expect(FORM).toMatch(/maxPasswordLength/);
    expect(FORM).toMatch(/isCommonPassword\(/);
    expect(FORM).toMatch(/pwnedpasswords\.com\/range\//);
  });
});

describe('0026 migration: bootstrap_setup_pending()', () => {
  it('answers one bit: bootstrapped AND a live unconsumed token exists', () => {
    expect(MIGRATION).toMatch(/create function public\.bootstrap_setup_pending\(\)/);
    expect(MIGRATION).toMatch(/returns boolean/);
    expect(MIGRATION).toMatch(/from public\.bootstrap_state/);
    expect(MIGRATION).toMatch(/consumed_at is null/);
    expect(MIGRATION).toMatch(/expires_at > now\(\)/);
  });

  it('is SECURITY DEFINER with EXECUTE granted to app_user only', () => {
    expect(MIGRATION).toMatch(/security definer/);
    expect(MIGRATION).toMatch(
      /revoke all on function public\.bootstrap_setup_pending\(\) from public/,
    );
    expect(MIGRATION).toMatch(
      /grant execute on function public\.bootstrap_setup_pending\(\) to app_user/,
    );
  });
});
