import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The prepared rollback for 0078 (MT-L3) promises to restore the 0077 state. Pinned statically,
 * as the 0075 and 0077 rollback guards do. Also executed on a disposable database, where rolling
 * 0078 back matched a fresh 0077 database on every order-stable schema fingerprint.
 */
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const M0075 = read('drizzle', '0075_audit_partition_lock_order.sql');
const M0078 = read('drizzle', '0078_audit_history_truncate_guard.sql');
const RB78 = read('scripts', 'db', 'rollback', '0078_audit_history_truncate_guard.down.sql');

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const fn = (sql: string, head: RegExp) => {
  const m = sql.match(new RegExp(`${head.source}[\\s\\S]*?\\$\\$;`));
  expect(m, head.source).not.toBeNull();
  return squash(m![0]);
};
const ENSURE = /create or replace function public\.ensure_audit_log_partitions/;
const ADDED =
  "-- 0078: no partition can be truncated directly (MT-L3). execute format( 'create trigger audit_history_no_truncate before truncate on public.%I ' 'for each statement execute function public.audit_history_no_truncate()', v_name);";

describe('0078 (MT-L3) and its rollback', () => {
  it("0078's ensure_audit_log_partitions is 0075's plus the marked self-repair and one statement", () => {
    const selfRepair = /\n\s*-- 0078 self-repair begin[\s\S]*?-- 0078 self-repair end\n/;
    expect(M0078).toMatch(selfRepair);
    const m78 = M0078.replace(selfRepair, '');
    expect(fn(m78, ENSURE)).toBe(
      fn(M0075, ENSURE).replace(
        "execute format('revoke all on public.%I from app_user, app_admin', v_name);",
        `execute format('revoke all on public.%I from app_user, app_admin', v_name); ${ADDED}`,
      ),
    );
  });

  it('0078 guards the parent, both other history tables and every existing partition', () => {
    for (const t of ['audit_logs', 'login_events', 'engagement_events']) {
      expect(M0078).toMatch(
        new RegExp(`create trigger audit_history_no_truncate before truncate on public\\.${t}\\b`),
      );
    }
    expect(M0078).toMatch(/where i\.inhparent = 'public\.audit_logs'::regclass/);
  });

  it("the rollback restores 0075's function verbatim, in one transaction", () => {
    expect(RB78).toMatch(/^begin;$/m);
    expect(RB78).toMatch(/^commit;$/m);
    expect(fn(RB78, ENSURE)).toBe(fn(M0075, ENSURE));
    expect(RB78).toMatch(/drop function if exists public\.audit_history_no_truncate\(\);/);
  });
});
