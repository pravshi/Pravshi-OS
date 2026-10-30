import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from '@neondatabase/serverless';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ISOLATION_TEST_GAPS, POLICY_SCOPE_EXCEPTIONS, TABLES } from './table-classification';

/**
 * Schema-driven security inventory (target-architecture.md Step 3; blueprint §15).
 *
 * Reads the live catalog of a migrated database and compares it with the reviewed classification
 * in ./table-classification.ts. Fails when:
 *
 *   - a table in public, auth, platform or drizzle is unclassified, or a classified table is gone;
 *   - a partition's parent is unclassified, or a partition lacks its parent's enabled and forced
 *     RLS, or a runtime login holds a privilege on a partition directly;
 *   - a tenant table lacks its owner column (org_id, its own id, or the declared foreign key to a
 *     tenant parent), lacks enabled and forced RLS, has a runtime login holding a privilege with no
 *     policy that applies to it, or has a runtime-login policy not scoped by authz.org_id() that is
 *     not a reviewed exception;
 *   - a tenant table has no two-organization isolation test — the named it()/test() block must
 *     exist and name the table — and is not in ISOLATION_TEST_GAPS (shrink-only);
 *   - a global table has an org_id column or lacks enabled and forced RLS, or a runtime login holds
 *     a privilege on it with no applicable policy;
 *   - a platform table lacks enabled and forced RLS, or any runtime login holds a privilege on it;
 *   - an operational table is reachable by a runtime login not named in its `access`.
 *
 * Like rls-enabled.test.ts it runs as the schema owner (DATABASE_URL_MIGRATE) and never skips: a
 * security inventory that silently skips is a pass nobody earned. It changes nothing.
 */

const SCHEMAS = ['public', 'auth', 'platform', 'drizzle'];
/** Every login a running process uses. app_owner (migrations) is not one. */
const RUNTIME_LOGINS = ['app_user', 'app_auth', 'app_worker', 'app_platform', 'app_admin'];

interface TableRow {
  name: string;
  partition_of: string | null;
  rls: boolean;
  forced: boolean;
  columns: string[];
  logins: string[];
}
interface PolicyRow {
  table: string;
  policy: string;
  roles: string[];
  qual: string | null;
  check: string | null;
}
interface ForeignKeyRow {
  table: string;
  columns: string[];
  parent: string;
}

/** The it()/test() block carrying `title` in `text`, from its call to the next sibling call. */
export function testBlock(text: string, title: string): string | null {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.includes(title));
  if (at === -1) return null;
  let start = -1;
  for (let i = at; i >= Math.max(0, at - 3); i--) {
    if (/^\s*(it|test)(\.each\(.*\))?\(/.test(lines[i] ?? '')) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const indent = (lines[start] ?? '').search(/\S/);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const ind = line.search(/\S/);
    if (ind !== -1 && ind <= indent && /^\s*(it|test|describe)(\.each\(.*\))?\(/.test(line)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

const has = (row: TableRow, column: string) => row.columns.includes(column);

describe('security inventory (target-architecture.md Step 3)', () => {
  let pool: Pool;
  let tables: TableRow[] = [];
  let policies: PolicyRow[] = [];
  let foreignKeys: ForeignKeyRow[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
    const logins = RUNTIME_LOGINS;
    tables = (
      await pool.query<TableRow>(
        `select n.nspname || '.' || c.relname as name,
                (select pn.nspname || '.' || p.relname
                   from pg_inherits i join pg_class p on p.oid = i.inhparent
                   join pg_namespace pn on pn.oid = p.relnamespace
                  where i.inhrelid = c.oid) as partition_of,
                c.relrowsecurity as rls, c.relforcerowsecurity as forced,
                array(select a.attname::text from pg_attribute a
                       where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns,
                array(select l from unnest($2::text[]) l
                       where has_table_privilege(l, c.oid, 'select,insert,update,delete,truncate,references,trigger')
                          or has_any_column_privilege(l, c.oid, 'select,insert,update,references')) as logins
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = any($1::text[]) and c.relkind in ('r', 'p')
          order by 1`,
        [SCHEMAS, logins],
      )
    ).rows;
    policies = (
      await pool.query<PolicyRow>(
        `select n.nspname || '.' || c.relname as table, p.polname as policy,
                case when 0 = any(p.polroles) then array['public']
                     else array(select r.rolname::text from pg_roles r where r.oid = any(p.polroles)) end as roles,
                pg_get_expr(p.polqual, p.polrelid) as qual,
                pg_get_expr(p.polwithcheck, p.polrelid) as check
           from pg_policy p join pg_class c on c.oid = p.polrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = any($1::text[])`,
        [SCHEMAS],
      )
    ).rows;
    foreignKeys = (
      await pool.query<ForeignKeyRow>(
        `select n.nspname || '.' || c.relname as table,
                array(select a.attname::text from unnest(con.conkey) k(attnum)
                        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as columns,
                pn.nspname || '.' || p.relname as parent
           from pg_constraint con
           join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
           join pg_class p on p.oid = con.confrelid join pg_namespace pn on pn.oid = p.relnamespace
          where con.contype = 'f' and n.nspname = any($1::text[])`,
        [SCHEMAS],
      )
    ).rows;
  });

  afterAll(async () => {
    await pool?.end();
  });

  const parents = () => tables.filter((t) => t.partition_of === null);
  /** Policies of `table` that apply to `login`. */
  const applicable = (table: string, login: string) =>
    policies.filter(
      (p) => p.table === table && (p.roles.includes(login) || p.roles.includes('public')),
    );

  it('reads a migrated schema', () => {
    expect(parents().length).toBeGreaterThan(70);
    expect(policies.length).toBeGreaterThan(100);
  });

  it('classifies every table, and lists no table that is gone', () => {
    const live = new Set(parents().map((t) => t.name));
    const unclassified = [...live].filter((t) => !(t in TABLES));
    const gone = Object.keys(TABLES).filter((t) => !live.has(t));
    expect(unclassified, 'Classify these tables in tests/guards/table-classification.ts').toEqual(
      [],
    );
    expect(gone, 'These classified tables no longer exist: remove them').toEqual([]);
  });

  it('protects every partition like its parent and grants no login a partition directly', () => {
    const problems: string[] = [];
    for (const t of tables.filter((x) => x.partition_of !== null)) {
      const parent = tables.find((x) => x.name === t.partition_of);
      if (!parent || !(parent.name in TABLES)) problems.push(`${t.name}: parent unclassified`);
      if (parent && parent.rls && !(t.rls && t.forced))
        problems.push(`${t.name}: RLS not enabled and forced`);
      if (t.logins.length > 0)
        problems.push(`${t.name}: direct privilege for ${t.logins.join(', ')}`);
    }
    expect(problems).toEqual([]);
  });

  it('gives every tenant table its owner column, forced RLS and a policy for every login that can reach it', () => {
    const problems: string[] = [];
    for (const t of parents()) {
      const c = TABLES[t.name];
      if (c?.class !== 'tenant') continue;
      if (c.org === 'org_id' && !has(t, 'org_id')) problems.push(`${t.name}: no org_id column`);
      if (c.org === 'id' && !has(t, 'id')) problems.push(`${t.name}: no id column`);
      if (typeof c.org === 'object') {
        const { via, parent } = c.org;
        const fk = foreignKeys.some(
          (f) =>
            f.table === t.name &&
            f.parent === parent &&
            f.columns.length === 1 &&
            f.columns[0] === via,
        );
        if (!fk) problems.push(`${t.name}: no foreign key ${via} -> ${parent}`);
        if (TABLES[parent]?.class !== 'tenant')
          problems.push(`${t.name}: parent ${parent} is not a tenant table`);
      }
      if (!(t.rls && t.forced)) problems.push(`${t.name}: RLS not enabled and forced`);
      for (const login of t.logins) {
        if (applicable(t.name, login).length === 0)
          problems.push(`${t.name}: ${login} has a privilege but no policy`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('scopes every runtime-login policy on a tenant table by authz.org_id(), or lists it as a reviewed exception', () => {
    const problems: string[] = [];
    const used = new Set<string>();
    for (const p of policies) {
      if (TABLES[p.table]?.class !== 'tenant') continue;
      if (!p.roles.some((r) => r === 'public' || RUNTIME_LOGINS.includes(r))) continue;
      const scoped = [p.qual, p.check].every(
        (e) => e === null || e.trim() === 'false' || /authz\.org_id\(\)/.test(e),
      );
      const key = `${p.table}/${p.policy}`;
      if (key in POLICY_SCOPE_EXCEPTIONS) {
        used.add(key);
        continue;
      }
      if (!scoped) problems.push(`${key} (${p.roles.join(',')}) is not scoped by authz.org_id()`);
    }
    const stale = Object.keys(POLICY_SCOPE_EXCEPTIONS).filter((k) => !used.has(k));
    expect(problems).toEqual([]);
    expect(
      stale,
      'These exceptions name no runtime-login policy on a tenant table: remove them',
    ).toEqual([]);
  });

  it('names a two-organization isolation test for every tenant table, outside the shrink-only gap list', () => {
    const problems: string[] = [];
    for (const [table, c] of Object.entries(TABLES)) {
      if (c.class !== 'tenant') continue;
      const gap = ISOLATION_TEST_GAPS.includes(table);
      if (!c.isolationTest) {
        if (!gap) problems.push(`${table}: no isolation test and not in ISOLATION_TEST_GAPS`);
        continue;
      }
      if (gap)
        problems.push(`${table}: has an isolation test — remove it from ISOLATION_TEST_GAPS`);
      const { file, title } = c.isolationTest;
      const path = join(process.cwd(), file);
      if (!existsSync(path)) {
        problems.push(`${table}: ${file} does not exist`);
        continue;
      }
      const block = testBlock(readFileSync(path, 'utf8'), title);
      const bare = table.split('.')[1] ?? table;
      if (block === null) problems.push(`${table}: no it()/test() titled «${title}» in ${file}`);
      else if (!new RegExp(`\\b${bare}\\b`).test(block)) {
        problems.push(`${table}: the test «${title}» does not name ${bare}`);
      }
    }
    for (const g of ISOLATION_TEST_GAPS) {
      if (TABLES[g]?.class !== 'tenant')
        problems.push(`${g}: listed as a gap but not a tenant table`);
    }
    expect(new Set(ISOLATION_TEST_GAPS).size).toBe(ISOLATION_TEST_GAPS.length);
    expect(problems).toEqual([]);
  });

  it('keeps global reference data shared and policy-covered', () => {
    const problems: string[] = [];
    for (const t of parents()) {
      if (TABLES[t.name]?.class !== 'global') continue;
      if (has(t, 'org_id')) problems.push(`${t.name}: global table with an org_id column`);
      if (!(t.rls && t.forced)) problems.push(`${t.name}: RLS not enabled and forced`);
      for (const login of t.logins) {
        if (applicable(t.name, login).length === 0)
          problems.push(`${t.name}: ${login} has a privilege but no policy`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps platform tables out of every runtime login’s reach', () => {
    const problems: string[] = [];
    for (const t of parents()) {
      if (TABLES[t.name]?.class !== 'platform') continue;
      if (!(t.rls && t.forced)) problems.push(`${t.name}: RLS not enabled and forced`);
      if (t.logins.length > 0) problems.push(`${t.name}: privilege for ${t.logins.join(', ')}`);
    }
    expect(problems).toEqual([]);
  });

  it('lets only the declared logins reach operational tables', () => {
    const problems: string[] = [];
    for (const t of parents()) {
      const c = TABLES[t.name];
      if (c?.class !== 'operational') continue;
      const allowed = c.access ?? [];
      const outside = t.logins.filter((l) => !allowed.includes(l));
      if (outside.length > 0) problems.push(`${t.name}: privilege for ${outside.join(', ')}`);
    }
    expect(problems).toEqual([]);
  });

  it('uses each data class at least once except public-projection (none exist yet)', () => {
    const used = new Set(Object.values(TABLES).map((c) => c.class));
    expect([...used].sort()).toEqual(['global', 'operational', 'platform', 'tenant']);
  });
});

describe('testBlock', () => {
  const src = [
    "describe('x', () => {",
    "  it('alpha crosses orgs', async () => {",
    '    await q(`select * from public.deals`);',
    '  });',
    '',
    "  it('beta', async () => {",
    '    await q(`select * from public.contacts`);',
    '  });',
    '});',
  ].join('\n');

  it('returns only the titled block', () => {
    const b = testBlock(src, 'alpha crosses orgs');
    expect(b).toContain('public.deals');
    expect(b).not.toContain('public.contacts');
  });

  it('returns null for an unknown title or a describe title', () => {
    expect(testBlock(src, 'gamma')).toBeNull();
    expect(testBlock(src, "'x'")).toBeNull();
  });
});
