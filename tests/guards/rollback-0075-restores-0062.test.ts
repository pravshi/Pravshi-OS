import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * scripts/db/rollback/0075_audit_partition_lock_order.down.sql promises to restore
 * public.ensure_audit_log_partitions() exactly as migration 0062 defined it. Nothing runs
 * that script in CI (it is an operator's last resort), so this guard holds it to the
 * promise statically: the same signature and attributes, the same body, and the same
 * comment as 0062 — CREATE OR REPLACE keeps a function's existing comment, so a rollback
 * without its own COMMENT left 0075's description on 0062's body.
 *
 * The comparison is semantic where formatting is not: whitespace is normalised, and the
 * comment is compared as the string Postgres stores (adjacent literals concatenated,
 * doubled quotes undone), not as the lines that spell it.
 *
 * Static — no database needed.
 */

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');

const M0062 = read('drizzle', '0062_audit_partition_maintenance.sql');
const M0075 = read('drizzle', '0075_audit_partition_lock_order.sql');
const ROLLBACK = read('scripts', 'db', 'rollback', '0075_audit_partition_lock_order.down.sql');

/** The file's statements: drizzle's breakpoints, leading comment lines dropped. */
const statements = (sql: string): string[] =>
  sql
    .split('--> statement-breakpoint')
    .map((chunk) => {
      const lines = chunk.split('\n');
      while (lines.length && (lines[0]!.trim() === '' || lines[0]!.trim().startsWith('--'))) {
        lines.shift();
      }
      return lines.join('\n').trim();
    })
    .filter((s) => s.length > 0);

const FN = /^create\s+or\s+replace\s+function\s+public\.ensure_audit_log_partitions\s*\(/i;
const COMMENT =
  /^comment\s+on\s+function\s+public\.ensure_audit_log_partitions\s*\(\s*integer\s*\)\s+is\s+/i;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The function statement split at its dollar quotes: attributes (case-folded) and body. */
function functionOf(sql: string): { head: string; body: string } {
  const found = statements(sql).filter((s) => FN.test(s));
  expect(found, 'exactly one ensure_audit_log_partitions definition').toHaveLength(1);
  const m = /^([\s\S]*?)\$\$([\s\S]*)\$\$\s*;?\s*$/.exec(found[0]!);
  expect(m, 'a $$-quoted body').not.toBeNull();
  return { head: squash(m![1]!).toLowerCase(), body: squash(m![2]!) };
}

/** The comment as Postgres stores it. */
function commentOf(sql: string): string {
  const found = statements(sql).filter((s) => COMMENT.test(s));
  expect(found, 'exactly one comment on ensure_audit_log_partitions').toHaveLength(1);
  const literals = found[0]!.replace(COMMENT, '').replace(/;\s*$/, '');
  // Only string literals separated by whitespace may follow IS: anything else is not a
  // plain constant comment, and the comparison below would not mean what it says.
  expect(literals).toMatch(/^(?:'(?:[^']|'')*'\s*)+$/);
  return [...literals.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'")).join('');
}

describe('the 0075 rollback restores 0062 exactly', () => {
  it('restores 0062’s function: the same signature, attributes and body', () => {
    expect(functionOf(ROLLBACK)).toEqual(functionOf(M0062));
  });

  it('restores 0062’s comment, not 0075’s', () => {
    expect(commentOf(ROLLBACK)).toBe(commentOf(M0062));
  });

  it('can tell the two versions apart (the checks above are not vacuous)', () => {
    expect(functionOf(M0075).body).not.toBe(functionOf(M0062).body);
    expect(commentOf(M0075)).not.toBe(commentOf(M0062));
  });

  it('does nothing else: the function, its comment, and the owner-only ACL', () => {
    const kinds = statements(ROLLBACK).map((s) =>
      FN.test(s) ? 'function' : COMMENT.test(s) ? 'comment' : squash(s).toLowerCase(),
    );
    expect(kinds).toEqual([
      'function',
      'comment',
      'revoke all on function public.ensure_audit_log_partitions(integer) from public;',
    ]);
  });
});
