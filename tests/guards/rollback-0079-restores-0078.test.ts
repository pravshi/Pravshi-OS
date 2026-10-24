import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The prepared rollback for 0079 (FU-3) promises to restore the 0078 state. Pinned statically,
 * as the 0075, 0077 and 0078 rollback guards do. Also executed on a disposable database, where
 * rolling 0079 back matched a fresh 0078 database on every order-stable schema fingerprint and
 * the first-use race reappeared.
 */
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const M0024 = read('drizzle', '0024_password_reset.sql');
const M0079 = read('drizzle', '0079_rate_limit_first_use.sql');
const RB79 = read('scripts', 'db', 'rollback', '0079_rate_limit_first_use.down.sql');

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const fn = (sql: string, head: RegExp) => {
  const m = sql.match(new RegExp(`${head.source}[\\s\\S]*?\\$\\$;`));
  expect(m, head.source).not.toBeNull();
  return squash(m![0]);
};

describe('0079 (FU-3) and its rollback', () => {
  it('0079 is the single-statement upsert, keeping signature and SECURITY DEFINER', () => {
    const f = fn(M0079, /create or replace function authz\.check_rate_limit/);
    expect(f).toMatch(/on conflict \(key\) do update/);
    expect(f).toMatch(/security definer/);
    expect(f).toMatch(/\(p_key text, p_max integer, p_window_seconds integer\)/);
    expect(f).not.toMatch(/for update/);
  });

  it("the rollback restores 0024's body verbatim, in one transaction", () => {
    expect(RB79).toMatch(/^begin;$/m);
    expect(RB79).toMatch(/^commit;$/m);
    const original = fn(M0024, /create function authz\.check_rate_limit/).replace(
      'create function',
      'create or replace function',
    );
    expect(fn(RB79, /create or replace function authz\.check_rate_limit/)).toBe(original);
  });
});
