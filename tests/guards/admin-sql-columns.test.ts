import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P0-2 regression guard: the admin services once shipped SQL against columns
 * that do not exist (people.full_name, roles.code) and compared the
 * audit_result enum to text without a cast, 500ing the entire admin UI.
 *
 * This is the static, DB-free half of the protection: it fails on the stale
 * identifiers even in suites that never connect. tests/db/admin-services.test.ts
 * is the dynamic half — it executes the queries against a real database.
 */

const read = (p: string) => readFileSync(join(process.cwd(), 'src/lib/admin', p), 'utf8');
const stripComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/--[^\n]*/g, '');

describe('admin SQL column guards (P0-2)', () => {
  it('never references people.full_name (the column is full_legal_name)', () => {
    for (const f of ['users.ts', 'roles.ts', 'permissions.ts', 'audit.ts', 'audit-export.ts']) {
      expect(read(f), `${f} must not reference the nonexistent people.full_name`).not.toMatch(
        /\bfull_name\b/,
      );
    }
  });

  it('never calls public.role_is_protected() — it is not executable by the app', () => {
    // Migration 0008 revokes EXECUTE from public and grants it to nobody: the
    // helper answers questions the triggers ask, it is not an API. Calling it
    // as app_user is a 500. The services must evaluate the flag-OR-capability
    // predicate inline over RLS-visible rows instead.
    for (const f of ['users.ts', 'roles.ts', 'permissions.ts', 'audit.ts', 'audit-export.ts']) {
      expect(stripComments(read(f)), `${f} must not call public.role_is_protected()`).not.toMatch(
        /role_is_protected\s*\(/,
      );
    }
    expect(read('roles.ts')).toMatch(/r\.is_protected/);
  });

  it('never references roles.code (the column is key)', () => {
    for (const f of ['users.ts', 'roles.ts', 'permissions.ts']) {
      expect(read(f), `${f} must not reference the nonexistent roles.code`).not.toMatch(
        /\br\.code\b/,
      );
    }
  });

  it('casts audit_result to text before comparing it to a text parameter', () => {
    for (const f of ['audit.ts', 'audit-export.ts']) {
      const src = read(f);
      expect(src, `${f} must cast a.result to text before comparing`).not.toMatch(
        /a\.result\s*=\s*\$\{/,
      );
      expect(src, `${f} must compare a.result::text`).toMatch(/a\.result::text\s*=/);
    }
  });

  it('roles.ts still exposes the key under the code property the UI expects', () => {
    const src = read('roles.ts');
    expect(src).toMatch(/r\.key\s+as\s+code/);
  });
});
