/**
 * AUD-18 — enqueueJob dedup contract against the REAL database.
 *
 * The contract (src/lib/jobs/queue.ts): a second enqueue with the same
 * (org_id, dedup_key) is an idempotent no-op that RESOLVES with the existing
 * job; the partial unique index jobs_org_dedup_uidx (0045) arbitrates races.
 * Webhook fan-out (integrations/fanout.ts) and notification enqueue
 * (notifications/service.ts) rely on that graceful return.
 *
 * Until now the only dedup coverage mocked enqueueJob in memory
 * (tests/jobs/failure-resilience.test.ts) — it proved the mock, not the SQL
 * path. This suite calls the REAL enqueueJob through withAuthorizedDb() under
 * fabricated session identities (the Phase-7/8 harness pattern: owner seeds
 * fixtures, service calls run under the caller's real RLS identity). Nothing
 * is mocked.
 *
 * Reading the result:
 *  - GREEN  → the graceful-return contract holds against real PostgreSQL;
 *             AUD-18 is disproved as written.
 *  - RED on the duplicate cases with a DrizzleQueryError whose cause is
 *    SQLSTATE 23505 (jobs_org_dedup_uidx) → the defect is CONFIRMED:
 *    queue.ts's isPgCode() reads only the outer error, but drizzle wraps the
 *    driver error (the sqlstate lives on `cause`) — the repository
 *    convention documented in src/lib/jobs/handlers.ts (sqlstateOf) exists
 *    for exactly this reason — so the dedup fallback never fires and
 *    duplicate enqueues throw instead of returning the existing job.
 *
 * On a plain `pnpm test` without credentials the suite collects and skips:
 * the service import chain validates env at import time, so the queue module
 * is imported dynamically behind the HAS_DB gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '@/lib/db/context';
import type { Authorization } from '@/lib/authz/require-permission';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

/** Owner connection: seeds fixtures, verifies row counts, bypasses RLS. */
const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

/** Unique per run: every seeded value is namespaced so other suites can't collide. */
const RUN = Math.random()
  .toString(36)
  .slice(2, 8)
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, 'X');

const tryImport = async <T>(path: string): Promise<T | null> => {
  try {
    return (await import(path)) as T;
  } catch {
    return null;
  }
};

type QueueModule = typeof import('@/lib/jobs/queue');
type Job = import('@/lib/jobs/types').Job;
type EnqueueJobInput = import('@/lib/jobs/types').EnqueueJobInput;

/* ── fixtures (owner connection) ─────────────────────────────────────────── */

const mkOrg = async (slug: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1,$2) returning id`,
      [`DEDUP ${slug}`, `dedup-${slug.toLowerCase()}-${RUN.toLowerCase()}`],
    )
  ).rows[0]!.id;

const mkPerson = async (org: string, name: string) => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  return (
    await owner.query<{ id: string }>(
      `insert into public.people
         (org_id, code, full_legal_name, person_status, date_of_birth, personal_email, phone)
       values ($1,$2,$3,'ACTIVE'::public.person_status,'1990-01-01',$4,'+91-00000-00000')
       returning id`,
      [org, code, name, `${name.toLowerCase().replace(/[^a-z]/g, '')}.${RUN}@example.test`],
    )
  ).rows[0]!.id;
};

const mkDept = async (org: string, code: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.departments (org_id, code, name) values ($1,$2,$3) returning id`,
      [org, code, `Dept ${code}`],
    )
  ).rows[0]!.id;

const mkEngagement = async (org: string, person: string, dept: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.engagements
         (org_id, person_id, department_id, engagement_type, status, start_date)
       values ($1,$2,$3,'EMPLOYEE','ACTIVE'::public.engagement_status, current_date)
       returning id`,
      [org, person, dept],
    )
  ).rows[0]!.id;

const mkRoleFor = async (
  org: string,
  person: string,
  key: string,
  permissions: readonly string[],
) => {
  const role = (
    await owner.query<{ id: string }>(
      `insert into public.roles (org_id, key, name) values ($1,$2,$3) returning id`,
      [org, key.toUpperCase().replace(/[^A-Z0-9_]/g, '_'), `DEDUP ${key}`],
    )
  ).rows[0]!.id;
  for (const permission of permissions) {
    const { rowCount } = await owner.query(
      `insert into public.role_permissions (role_id, permission_id, scope)
       select $1, p.id, 'GLOBAL'::public.access_scope from public.permissions p where p.key = $2`,
      [role, permission],
    );
    if (rowCount !== 1) {
      throw new Error(`permission key ${permission} is not in the catalogue — cannot grant it`);
    }
  }
  await owner.query(
    `insert into public.person_roles (person_id, role_id, org_id) values ($1,$2,$3)`,
    [person, role, org],
  );
};

const makeAuth = (personId: string, orgId: string, permission: string): Authorization => ({
  ctx: { personId, orgId, aal: 'aal1' } as AuthContext,
  permission,
  scope: 'GLOBAL',
  aal: 'aal1',
  requestId: randomUUID(),
  meta: { requestId: randomUUID(), ip: null, userAgent: null },
});

/* ── suite ───────────────────────────────────────────────────────────────── */

describe.skipIf(!HAS_DB)('enqueueJob dedup contract (AUD-18, real DB)', () => {
  let queue: QueueModule | null = null;

  let orgA = '';
  let orgB = '';
  let alice = '';
  let carol = '';
  let authAlice!: Authorization;
  let authCarol!: Authorization;

  // Dedup keys are RUN-namespaced: the CI database is shared with other suites.
  const KEY_SEQ = `dedup-db-${RUN}-seq`;
  const KEY_CONC = `dedup-db-${RUN}-conc`;
  const KEY_ALT = `dedup-db-${RUN}-alt`;

  /** A payload that validates trivially against CleanupPayloadSchema; the
   *  `case` marker lets owner-side counts isolate this suite's rows. */
  const inputFor = (kase: string, dedupKey?: string): EnqueueJobInput => ({
    type: 'cleanup',
    payload: { target: `dedup-probe-${RUN}`, params: { suite: 'enqueue-dedup-db', case: kase } },
    ...(dedupKey !== undefined ? { dedupKey } : {}),
  });

  /** Owner-side truth: rows the index allowed to exist for (org, dedup_key). */
  const countByDedupKey = async (orgId: string, dedupKey: string): Promise<number> =>
    (
      await owner.query<{ n: number }>(
        `select count(*)::int as n from public.jobs where org_id = $1 and dedup_key = $2`,
        [orgId, dedupKey],
      )
    ).rows[0]!.n;

  const countNullDedupCase = async (orgId: string, kase: string): Promise<number> =>
    (
      await owner.query<{ n: number }>(
        `select count(*)::int as n from public.jobs
          where org_id = $1 and dedup_key is null and payload->'params'->>'case' = $2`,
        [orgId, kase],
      )
    ).rows[0]!.n;

  let firstSeqJob: Job;

  beforeAll(async () => {
    queue = await tryImport<QueueModule>('@/lib/jobs/queue');
    if (!queue) return;

    orgA = await mkOrg('A');
    orgB = await mkOrg('B');
    alice = await mkPerson(orgA, `Alice ${RUN}`);
    carol = await mkPerson(orgB, `Carol ${RUN}`);

    // authz.has()/is_active() resolve nothing without a live engagement —
    // every other suite's fixtures create one per person; these must too.
    const deptA = await mkDept(orgA, 'DDA');
    const deptB = await mkDept(orgB, 'DDB');
    await mkEngagement(orgA, alice, deptA);
    await mkEngagement(orgB, carol, deptB);

    // jobs.view accompanies jobs.create (0045 matrix): enqueueJob's
    // INSERT ... RETURNING is only visible under the jobs SELECT policy,
    // which keys on jobs.view.
    await mkRoleFor(orgA, alice, `d_a_${RUN}`, ['jobs.view', 'jobs.create']);
    await mkRoleFor(orgB, carol, `d_c_${RUN}`, ['jobs.view', 'jobs.create']);

    authAlice = makeAuth(alice, orgA, 'jobs.create');
    authCarol = makeAuth(carol, orgB, 'jobs.create');
  }, 120_000);

  afterAll(async () => {
    // Scoped cleanup: ONLY this suite's rows, always filtered by its own org
    // ids — never an unscoped delete. Best-effort: fixtures are RUN-namespaced,
    // so any residue is inert and identifiable.
    try {
      if (orgA && orgB) {
        const orgs = [orgA, orgB];
        await owner.query(`delete from public.jobs where org_id = any($1::uuid[])`, [orgs]);
        await owner.query(`delete from public.person_roles where org_id = any($1::uuid[])`, [orgs]);
        await owner.query(
          `delete from public.role_permissions
            where role_id in (select id from public.roles where org_id = any($1::uuid[]))`,
          [orgs],
        );
        await owner.query(`delete from public.roles where org_id = any($1::uuid[])`, [orgs]);
        await owner.query(`delete from public.engagements where org_id = any($1::uuid[])`, [orgs]);
        await owner.query(`delete from public.people where org_id = any($1::uuid[])`, [orgs]);
        await owner.query(`delete from public.departments where org_id = any($1::uuid[])`, [orgs]);
        await owner.query(`delete from public.organizations where id = any($1::uuid[])`, [orgs]);
      }
    } catch (e) {
      console.warn(`[enqueue-dedup-db] scoped cleanup incomplete for run ${RUN}:`, e);
    }
    await owner.end().catch(() => undefined);
  }, 120_000);

  it('(a) sequential duplicate enqueue resolves with the SAME job; exactly one row exists', async () => {
    firstSeqJob = await queue!.enqueueJob(authAlice, inputFor('seq', KEY_SEQ));
    expect(firstSeqJob.orgId).toBe(orgA);
    expect(firstSeqJob.dedupKey).toBe(KEY_SEQ);
    expect(firstSeqJob.status).toBe('pending');

    // The contract under test: this must RESOLVE (not reject) with the
    // existing job — an idempotent no-op.
    const again = await queue!.enqueueJob(authAlice, inputFor('seq', KEY_SEQ));
    expect(again.id).toBe(firstSeqJob.id);
    expect(again.orgId).toBe(orgA);
    expect(again.dedupKey).toBe(KEY_SEQ);

    expect(await countByDedupKey(orgA, KEY_SEQ)).toBe(1);
  }, 120_000);

  it('(b) concurrent duplicate enqueues: exactly one row, every caller resolves to it', async () => {
    const N = 6;
    const settled = await Promise.allSettled(
      Array.from({ length: N }, () => queue!.enqueueJob(authAlice, inputFor('conc', KEY_CONC))),
    );
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    // On failure this diff prints the rejection reasons (the real driver
    // error, wrapped) — that output IS the AUD-18 evidence.
    expect(rejected.map((r) => String(r.reason))).toEqual([]);

    const jobs = settled.map((r) => (r as PromiseFulfilledResult<Job>).value);
    const ids = new Set(jobs.map((j) => j.id));
    expect(ids.size).toBe(1);
    for (const job of jobs) {
      expect(job.orgId).toBe(orgA);
      expect(job.dedupKey).toBe(KEY_CONC);
    }
    expect(await countByDedupKey(orgA, KEY_CONC)).toBe(1);
  }, 120_000);

  it('(c) a different dedup key still creates a new job', async () => {
    const other = await queue!.enqueueJob(authAlice, inputFor('alt', KEY_ALT));
    expect(other.id).not.toBe(firstSeqJob.id);
    expect(other.dedupKey).toBe(KEY_ALT);
    expect(await countByDedupKey(orgA, KEY_ALT)).toBe(1);
    // The original key's row is untouched.
    expect(await countByDedupKey(orgA, KEY_SEQ)).toBe(1);
  }, 120_000);

  it('(d) the same dedup key in a DIFFERENT org creates its own job (tenant separation)', async () => {
    const carols = await queue!.enqueueJob(authCarol, inputFor('seq', KEY_SEQ));
    expect(carols.orgId).toBe(orgB);
    expect(carols.id).not.toBe(firstSeqJob.id);
    expect(await countByDedupKey(orgB, KEY_SEQ)).toBe(1);
    expect(await countByDedupKey(orgA, KEY_SEQ)).toBe(1);

    // Alice's duplicate still returns ALICE's job — the fallback lookup is
    // org-scoped and can never hand her Carol's row.
    const again = await queue!.enqueueJob(authAlice, inputFor('seq', KEY_SEQ));
    expect(again.id).toBe(firstSeqJob.id);
    expect(again.orgId).toBe(orgA);
  }, 120_000);

  it('(e) enqueues without a dedup key always insert a new job', async () => {
    const one = await queue!.enqueueJob(authAlice, inputFor('nodup'));
    const two = await queue!.enqueueJob(authAlice, inputFor('nodup'));
    expect(one.dedupKey).toBeNull();
    expect(two.dedupKey).toBeNull();
    expect(two.id).not.toBe(one.id);
    expect(await countNullDedupCase(orgA, 'nodup')).toBe(2);
  }, 120_000);
});
