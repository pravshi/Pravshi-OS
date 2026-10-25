import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The prepared rollback for 0081 (the Sales Sheet import) promises to restore the 0080 state.
 * Pinned statically, as the earlier rollback guards do. Also executed on a disposable database,
 * twice: rolling 0081 back matched a fresh 0080 database on every order-stable schema
 * fingerprint, and rolling forward again matched a fresh 0081.
 */
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const M0045 = read('drizzle', '0045_automation_jobs.sql');
const M0057 = read('drizzle', '0057_integrations_permissions.sql');
const M0081 = read('drizzle', '0081_crm_imports.sql');
const RB81 = read('scripts', 'db', 'rollback', '0081_crm_imports.down.sql');

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const fn = (sql: string, head: RegExp) => {
  const m = sql.match(new RegExp(`${head.source}[\\s\\S]*?\\$\\$;`));
  expect(m, head.source).not.toBeNull();
  return squash(m![0]);
};
const SEED = /create or replace function public\.seed_system_roles/;
const jobTypes = (sql: string) => {
  const m = sql.match(/check \(type in \(([^)]*)\)\)/);
  expect(m).not.toBeNull();
  return squash(m![1]!);
};

describe('0081 (Sales Sheet import) and its rollback', () => {
  it("0081's seed_system_roles is 0057's plus the two crm.import grants and their comment", () => {
    const added =
      "('ADMIN','integrations.manage','GLOBAL'), -- Sales Sheet import (0081, BP-06): SUPER_ADMIN and ADMIN at GLOBAL only (AC-S4, -- proposed; founder Q8). SUPER_ADMIN's row also arrives via the cross join above. ('SUPER_ADMIN','crm.import','GLOBAL'), ('ADMIN','crm.import','GLOBAL')";
    expect(fn(M0081, SEED)).toBe(
      fn(M0057, SEED).replace("('ADMIN','integrations.manage','GLOBAL')", added),
    );
  });

  it("0081 widens the job types by crm_import only, and the rollback restores 0045's list", () => {
    expect(jobTypes(M0081)).toBe(`${jobTypes(M0045)}, 'crm_import'`);
    expect(jobTypes(RB81)).toBe(jobTypes(M0045));
  });

  it("the rollback restores 0057's seed_system_roles verbatim, in one transaction", () => {
    expect(RB81).toMatch(/^begin;$/m);
    expect(RB81).toMatch(/^commit;$/m);
    expect(fn(RB81, SEED)).toBe(fn(M0057, SEED));
  });

  it('the rollback refuses while import records or crm_import jobs exist, and removes the rest', () => {
    expect(RB81).toMatch(/if exists \(select 1 from public\.crm_imports\) then\s+raise exception/);
    expect(RB81).toMatch(
      /if exists \(select 1 from public\.jobs where type = 'crm_import'\) then\s+raise exception/,
    );
    // The tables are locked before the check, so nothing can be added between check and drop.
    expect(RB81.indexOf('lock table public.crm_imports')).toBeLessThan(RB81.indexOf('do $$'));
    expect(RB81).toMatch(/where p\.key = 'crm\.import'\) then\s+raise exception/); // record grants
    for (const s of [
      /drop function if exists public\.crm_import_execute_as_job\(uuid, text\);/,
      /drop function if exists public\.crm_import_record_job_failure\(uuid, text, text\);/,
      /drop function if exists public\.crm_import_fail_abandoned\(integer\);/,
      /drop function if exists public\.crm_import_audit_failure\(/,
      /drop trigger if exists crm_import_jobs_guard on public\.jobs;/,
      /drop function if exists public\.crm_import_jobs_guard\(\);/,
      /drop table public\.crm_import_rows;/,
      /drop table public\.crm_imports;/,
      /delete from public\.permissions where key = 'crm\.import';/,
    ]) {
      expect(RB81).toMatch(s);
    }
  });

  it('the failure audit helper fails closed when it writes no entry', () => {
    const helper = fn(M0081, /create function public\.crm_import_audit_failure/);
    expect(helper).toMatch(/get diagnostics v_n = row_count;/);
    expect(helper).toMatch(/if v_n <> 1 then raise exception/);
  });

  it('the worker-plane definers are the worker’s alone; the audit helper is nobody’s', () => {
    for (const f of [
      'crm_import_execute_as_job\\(uuid, text\\)',
      'crm_import_record_job_failure\\(uuid, text, text\\)',
      'crm_import_fail_abandoned\\(integer\\)',
    ]) {
      expect(M0081).toMatch(
        new RegExp(
          `revoke all on function public\\.${f} from public;\\s+grant execute on function public\\.${f} to app_worker;`,
        ),
      );
    }
    expect(M0081.match(/if not \(select authz\.is_worker\(\)\) then/g)).toHaveLength(3);
    expect(M0081).not.toMatch(/grant execute on function public\.crm_import_audit_failure/);
  });
});
