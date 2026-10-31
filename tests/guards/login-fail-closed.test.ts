import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Phase 3 guards for S-6 and A1, in the style of the other auth guards: they pin
 * the shape that makes the behaviour hold, so a later edit cannot quietly turn
 * the lockout check back into fail-open or move the login route's rate limit
 * behind the credential check. The behaviour itself is tested in tests/auth.
 */
// Redesign Step 7: the app's folders live in apps/web/src; everything else is shared src/.
const read = (p: string) =>
  readFileSync(/^(app|components|hooks)\//.test(p) ? `apps/web/src/${p}` : `src/${p}`, 'utf8');
const LOCKOUT = read('lib/auth/login-lockout.ts');
const ROUTE = read('app/api/auth/login/route.ts');
const SERVER = read('lib/auth/server.ts');
const EVENTS = read('lib/auth/login-events.ts');
const ADDRESS = read('lib/observability/client-address.ts');
const BETTER_AUTH_IP = read('lib/auth/better-auth-ip.ts');

describe('A1 review: every client address the auth plane uses is validated', () => {
  it('clientIp and the hooks read the trusted header (D1) through forwardedIp', () => {
    // One validator, in the D1 module; the trusted header's value always passes through it.
    expect(ADDRESS).toMatch(/export function forwardedIp[\s\S]*?isIP\(first\) !== 0/);
    expect(ADDRESS).toMatch(/return name \? forwardedIp\(headers\?\.get\(name\)\) : null;/);
    expect(EVENTS).toMatch(/return clientAddressFromHeaders\(req\.headers\);/);
    const ipOfHeaders = SERVER.slice(SERVER.indexOf('function ipOfHeaders'));
    expect(ipOfHeaders.slice(0, 200)).toMatch(/return clientAddressFromHeaders\(headers\);/);
  });

  it("Better Auth's own limiter resolves the address from the same trusted header", () => {
    // Without this line Better Auth falls back to its default x-forwarded-for (D1-3).
    // Inside Better Auth's `advanced` block — elsewhere it would be ignored.
    const start = SERVER.indexOf('\n  advanced: {');
    expect(start).toBeGreaterThan(0);
    const advanced = SERVER.slice(start, SERVER.indexOf('\n  },', start));
    expect(advanced).toContain('ipAddress: betterAuthIpAddressOptions(),');
    expect(SERVER).not.toMatch(/disableIpTracking/);
    // Step 4 split the option into its own file: the server must take it from there, and the
    // option must build its list from the D1 module's header table, never switch tracking off.
    expect(SERVER).toMatch(/import \{ betterAuthIpAddressOptions \} from '\.\/better-auth-ip';/);
    expect(BETTER_AUTH_IP).toMatch(/from '@\/lib\/observability\/client-address'/);
    expect(BETTER_AUTH_IP).toMatch(/const name = CLIENT_ADDRESS_HEADER\[source\];/);
    // Code only: the option's doc comment names disableIpTracking to explain why it is never set.
    const betterAuthIpCode = BETTER_AUTH_IP.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/[^\n]*/gm, '');
    expect(betterAuthIpCode).not.toMatch(/disableIpTracking/);
  });

  it('no code outside the D1 module names a client-address header (review F-D1-3)', () => {
    // Every file under src/, however it spells the name: a route or helper that read one of
    // these directly would bypass the deployment's trusted-header choice.
    const ADDRESS_HEADER = /x-(vercel-)?forwarded-for|x-real-ip|cf-connecting-ip|true-client-ip/i;
    const files = ['src', 'apps/web/src', 'apps/worker/src']
      .flatMap((dir) =>
        (readdirSync(dir, { recursive: true }) as string[]).map(
          (f) => `${dir}/${f.replace(/\\/g, '/')}`,
        ),
      )
      .filter(
        (f) => /\.(ts|tsx|js|mjs)$/.test(f) && f !== 'src/lib/observability/client-address.ts',
      );
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((f) =>
      // Comments may name a header; code may not. Only comments that START a line are dropped
      // (a block comment, or a whole-line //): a '//' inside a string, such as a URL, never
      // hides the rest of its line. A trailing comment on a code line still counts — stricter.
      ADDRESS_HEADER.test(
        readFileSync(f, 'utf8').replace(/^\s*\/\*[\s\S]*?\*\/|^\s*\/\/[^\n]*/gm, ''),
      ),
    );
    expect(offenders).toEqual([]);
  });
});

/** The body of one exported async function, up to the next top-level declaration. */
function fnBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('S-6: the lockout check fails closed', () => {
  it('a failed or empty check answers locked, never unlocked', () => {
    const body = fnBody(LOCKOUT, 'isLockedOut');
    const catchBlock = body.slice(body.indexOf('} catch'));
    expect(catchBlock).toMatch(/return true;/);
    expect(catchBlock).not.toMatch(/return false/);
    expect(body).not.toMatch(/\?\? false/);
  });

  it('every lockout helper alerts through reportAuthFailure, not a bare console line', () => {
    for (const name of ['isLockedOut', 'noteLoginFailure', 'clearLoginLockout']) {
      const body = fnBody(LOCKOUT, name);
      expect(body, name).toMatch(/reportAuthFailure\('auth\.login\.[a-z_]+'/);
      expect(body, name).not.toMatch(/console\.error/);
    }
  });
});

describe('A1: the browser login route throttles before the credential check', () => {
  it('limits ten attempts a minute per client address', () => {
    expect(ROUTE).toMatch(/LOGIN_RATE_LIMIT = \{ max: 10, windowSeconds: 60 \}/);
    expect(ROUTE).toMatch(/checkRequestRateLimit\(\s*req,\s*'login',/);
    expect(ROUTE).toMatch(/reply\(429, \{ error: 'RATE_LIMITED' \}\)/);
  });

  // Anchored on the awaited call sites: the header comment names both functions too.
  const LIMIT_CALL = 'await checkRequestRateLimit(';
  const SIGN_IN_CALL = 'await auth.api.signInEmail(';

  it('consults the limiter before delegating the credential check', () => {
    const limitAt = ROUTE.indexOf(LIMIT_CALL);
    const signInAt = ROUTE.indexOf(SIGN_IN_CALL);
    expect(limitAt).toBeGreaterThan(0);
    expect(signInAt).toBeGreaterThan(limitAt);
  });

  it('a limiter failure is refused with the generic credentials error and alerts', () => {
    const block = ROUTE.slice(ROUTE.indexOf(LIMIT_CALL), ROUTE.indexOf(SIGN_IN_CALL));
    expect(block).toMatch(/reportAuthFailure\('auth\.login\.rate_limit_check_failed'/);
    expect(block).toMatch(/reply\(401, \{ error: 'INVALID_CREDENTIALS' \}\)/);
  });
});
