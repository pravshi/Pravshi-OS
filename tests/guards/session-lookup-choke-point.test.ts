import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every server-side session lookup goes through getSessionSafely (src/lib/auth/safe-session.ts).
 *
 * From better-auth 1.7.7 on, a failed lookup throws an error whose `cause` is the database
 * driver's error, and that error's message carries the query's parameters — the session token.
 * The wrapper turns any failure into a fixed error with no cause. A direct call anywhere else
 * would silently reopen the leak, so this guard refuses one: `auth.api.getSession` (or any
 * `.api.getSession`) may appear in src/ only inside the wrapper itself.
 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry))
      out.push(relative(process.cwd(), path).split('\\').join('/'));
  }
  return out;
}

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('server-side session lookups', () => {
  it('call the library only inside getSessionSafely', () => {
    const offenders = walk('src')
      .filter((f) => f !== 'src/lib/auth/safe-session.ts')
      .filter((f) => /\.api\s*\.\s*getSession\b/.test(stripComments(readFileSync(f, 'utf8'))));
    expect(
      offenders,
      `call getSessionSafely instead of auth.api.getSession in:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the wrapper itself still calls the library, and drops the cause', () => {
    const src = stripComments(readFileSync('src/lib/auth/safe-session.ts', 'utf8'));
    expect(src).toMatch(/auth\.api\.getSession\(\{ headers \}\)/);
    expect(src).toMatch(/catch \{\s*throw new SessionUnavailableError\(\);\s*\}/);
    expect(src).not.toMatch(/cause/);
  });
});
