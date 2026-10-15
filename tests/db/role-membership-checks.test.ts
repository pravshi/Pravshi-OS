import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';

/**
 * The role-membership rule for the worker and authentication logins, wherever it is written:
 * migrations 0070 and 0072 (preconditions), 0073 (verification) and the production migration
 * runbook (step 3).
 *
 *   - app_worker / app_auth is a member of NO role — it inherits nothing;
 *   - no role is a member of it — none can SET ROLE into it — EXCEPT the database owner, and
 *     only when the owner is not itself an application role.
 *
 * The exception exists because PostgreSQL 16+ automatically grants a non-superuser that creates
 * a role ADMIN on it, and Neon's branch owner — which runs scripts/db/roles.sql — is not a
 * superuser. That grant cannot be revoked by the owner (its grantor is the platform superuser),
 * so a rule that counted every membership made 0070 abort on every Neon branch. CI could not
 * show it: there a superuser creates the roles, and no membership row exists at all.
 *
 * CI still cannot create that grant (its roles are no superuser), so the live half below
 * evaluates the EXACT predicate text of each migration and runbook query against synthetic
 * membership rows — the real SQL, the real database owner — instead of against grants.
 */

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const withoutComments = (sql: string) => sql.replace(/--[^\n]*/g, '');

/** The canonical predicate for one role, as written in every place that checks it. */
const predicateFor = (role: string) =>
  new RegExp(
    `m\\.rolname = '${role}'\\s+or \\(r\\.rolname = '${role}'\\s+and \\(am\\.member <> \\(select datdba from pg_database\\s+where datname = current_database\\(\\)\\)\\s+or m\\.rolname like 'app\\\\_%'\\)\\)`,
  );

const MIGRATIONS = [
  { file: '0070_app_worker_role.sql', role: 'app_worker' },
  { file: '0072_auth_role_expand.sql', role: 'app_auth' },
  { file: '0073_auth_role_contract.sql', role: 'app_auth' },
];
const RUNBOOK = read('docs', 'runbooks', 'production-migration.md');
const RUNBOOK_QUERIES = [
  ...RUNBOOK.matchAll(/select count\(\*\) from pg_auth_members[\s\S]*?;/g),
].map((m) => withoutComments(m[0]));
const runbookRole = (q: string) => /where m\.rolname = '(app_[a-z]+)'/.exec(q)?.[1];

/** Every place the rule is written: its role and the predicate text found there. */
const SITES = [
  ...MIGRATIONS.map(({ file, role }) => ({
    site: `drizzle/${file}`,
    role,
    predicate: predicateFor(role).exec(withoutComments(read('drizzle', file)))?.[0],
  })),
  ...RUNBOOK_QUERIES.map((q) => {
    const role = runbookRole(q) ?? '(unknown)';
    return { site: `runbook step 3 (${role})`, role, predicate: predicateFor(role).exec(q)?.[0] };
  }),
];

describe('role-membership rule: the same predicate everywhere', () => {
  it('the runbook checks both app_worker and app_auth', () => {
    expect(RUNBOOK_QUERIES.map(runbookRole).sort()).toEqual(['app_auth', 'app_worker']);
  });

  for (const s of SITES) {
    it(`${s.site} uses the canonical predicate for ${s.role}`, () => {
      expect(s.predicate, `${s.site} must contain the canonical ${s.role} predicate`).toBeDefined();
    });
  }

  it('no migration, test or runbook keeps the two-direction form that rejects the Neon owner', () => {
    const texts = [
      ...MIGRATIONS.map(({ file }) => read('drizzle', file)),
      RUNBOOK,
      read('tests', 'db', 'app-worker-role.test.ts'),
      read('tests', 'db', 'app-auth-role.test.ts'),
    ];
    for (const t of texts) {
      expect(t).not.toMatch(/in \(m\.rolname, r\.rolname\)/);
      expect(t).not.toMatch(/or \(r\.rolname = 'app_(worker|auth)'\);/);
      expect(t).not.toMatch(/or r\.rolname = 'app_(worker|auth)'`/);
    }
  });
});

const HAS_DB = Boolean(process.env.DATABASE_URL_MIGRATE);

describe.skipIf(!HAS_DB)('role-membership rule: semantics, evaluated in Postgres', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  afterAll(() => pool.end());

  /** Which synthetic memberships a predicate rejects (case ids). */
  const rejected = async (predicate: string, role: string) => {
    const OWNER = '(select datdba from pg_database where datname = current_database())';
    const r = await pool.query<{ id: number }>(
      `with cases(id, member_oid, member_name, role_name) as (values
         (1, ${OWNER},  'neondb_owner', '${role}'),    -- the owner's automatic ADMIN grant
         (2, 0::oid,    'app_user',     '${role}'),    -- an application role could SET ROLE
         (3, 0::oid,    'someone_else', '${role}'),    -- any other role could SET ROLE
         (4, 0::oid,    '${role}',      'app_user'),   -- the role inherits an application role
         (5, 0::oid,    '${role}',      'neon_superuser'), -- the role inherits a platform role
         (6, ${OWNER},  'app_owner',    '${role}'),    -- an application role owning the database
         (7, 0::oid,    'unrelated_a',  'unrelated_b') -- nothing to do with the role
       )
       select c.id from cases c
       cross join lateral (select c.member_oid as member) am
       cross join lateral (select c.member_name::name as rolname) m
       cross join lateral (select c.role_name::name as rolname) r
       where ${predicate}
       order by c.id`,
    );
    return r.rows.map((x) => Number(x.id));
  };

  for (const s of SITES) {
    it(`${s.site}: accepts only the database owner's membership, rejects every other`, async () => {
      expect(s.predicate).toBeDefined();
      expect(await rejected(s.predicate!, s.role)).toEqual([2, 3, 4, 5, 6]);
    });
  }

  for (const q of RUNBOOK_QUERIES) {
    it(`runbook ${runbookRole(q)} query runs as written and answers 0 here`, async () => {
      const r = await pool.query<{ count: string }>(q);
      expect(Number(r.rows[0]!.count)).toBe(0);
    });
  }
});
