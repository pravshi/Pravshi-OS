/**
 * Phase 8 — global search integration tests (Workstream F, §41 + §35).
 *
 * Calls the REAL searchGlobal() against a live test database under fabricated
 * session identities (the Phase-7 harness pattern: owner seeds fixtures,
 * every service call runs through withAuthorizedDb() so RLS evaluates under
 * the caller's real identity). Nothing is mocked.
 *
 * Fixtures: two tenants (Org A / Org B) with deliberately asymmetric,
 * run-unique search tokens. Any cross-tenant row in a result is an instant,
 * obvious leak.
 *
 * On a plain `pnpm test` without credentials the suite collects and skips:
 * the service import chain validates env at import time, so service modules
 * are imported dynamically behind the HAS_DB gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import type { AuthContext } from '@/lib/db/context';
import type { Authorization } from '@/lib/authz/require-permission';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);

/** Owner connection: seeds fixtures, bypasses RLS. */
const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });

/** Unique per run: every seeded row is namespaced so other suites' data can't match. */
const RUN = Math.random()
  .toString(36)
  .slice(2, 8)
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, 'X');
const TOK_A = `S8QA${RUN}`;
const TOK_B = `S8QB${RUN}`;

const tryImport = async <T>(path: string): Promise<T | null> => {
  try {
    return (await import(path)) as T;
  } catch {
    return null;
  }
};

type SearchModule = typeof import('@/lib/search/query');

/* ── fixtures (owner connection) ─────────────────────────────────────────── */

const mkOrg = async (slug: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.organizations (name, slug) values ($1,$2) returning id`,
      [`SEARCH ${slug}`, `search-${slug.toLowerCase()}-${RUN.toLowerCase()}`],
    )
  ).rows[0]!.id;

const mkPerson = async (org: string, name: string, workEmail: string | null = null) => {
  const code = (
    await owner.query<{ c: string }>(`select authz.next_identity_code($1::uuid,'EMP','2026') c`, [
      org,
    ])
  ).rows[0]!.c;
  return (
    await owner.query<{ id: string }>(
      `insert into public.people
         (org_id, code, full_legal_name, person_status, date_of_birth, personal_email, phone, work_email)
       values ($1,$2,$3,'ACTIVE'::public.person_status,'1990-01-01',$4,'+91-00000-00000',$5)
       returning id`,
      [
        org,
        code,
        name,
        `${name.toLowerCase().replace(/[^a-z]/g, '')}.${RUN}@example.test`,
        workEmail,
      ],
    )
  ).rows[0]!.id;
};

const mkRoleFor = async (
  org: string,
  person: string,
  key: string,
  permissions: readonly string[],
) => {
  const role = (
    await owner.query<{ id: string }>(
      `insert into public.roles (org_id, key, name) values ($1,$2,$3) returning id`,
      [org, key.toUpperCase().replace(/[^A-Z0-9_]/g, '_'), `SEARCH ${key}`],
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

const mkPipeline = async (org: string, name: string) =>
  (
    await owner.query<{ id: string }>(
      `insert into public.pipelines (org_id, name) values ($1,$2) returning id`,
      [org, name],
    )
  ).rows[0]!.id;

const ALL_VIEW_PERMS = [
  'contacts.view',
  'companies.view',
  'deals.view',
  'activities.view',
  'projects.view',
  'tasks.view',
  'workflows.view',
  'people.view',
] as const;

const makeAuth = (personId: string, orgId: string, permission: string): Authorization => ({
  ctx: { personId, orgId, aal: 'aal1' } as AuthContext,
  permission,
  scope: 'GLOBAL',
  aal: 'aal1',
  requestId: randomUUID(),
  meta: { requestId: randomUUID(), ip: null, userAgent: null },
});

describe.skipIf(!HAS_DB)('search integration (§41)', () => {
  let search: SearchModule | null = null;

  let orgA = '';
  let orgB = '';
  let alice = '';
  let bob = '';
  let charlie = ''; // org A, no view permissions at all
  let selfScoped = ''; // org A, SELF-scoped contacts.view only

  beforeAll(async () => {
    search = await tryImport<SearchModule>('@/lib/search/query');
    if (!search) return;

    orgA = await mkOrg('A');
    orgB = await mkOrg('B');
    alice = await mkPerson(orgA, `Alice ${TOK_A}`, `alice.${RUN}@example.test`);
    bob = await mkPerson(orgB, `Bob ${TOK_B}`, `bob.${RUN}@example.test`);
    charlie = await mkPerson(orgA, `Charlie ${TOK_A}`);
    selfScoped = await mkPerson(orgA, `Selfy ${TOK_A}`);

    await mkRoleFor(orgA, alice, `s8a_${RUN}`, ALL_VIEW_PERMS);
    await mkRoleFor(orgB, bob, `s8b_${RUN}`, ALL_VIEW_PERMS);
    await mkRoleFor(orgA, selfScoped, `s8s_${RUN}`, ['contacts.view']);

    // SELF scope for the self-scoped user: downgrade their single grant.
    await owner.query(
      `update public.role_permissions rp set scope='SELF'::public.access_scope
       from public.roles r, public.permissions p
       where rp.role_id = r.id and rp.permission_id = p.id
         and r.org_id = $1 and r.key = $2 and p.key = 'contacts.view'`,
      [orgA, `S8S_${RUN}`],
    );

    const pipeA = await mkPipeline(orgA, `Pipeline ${TOK_A}`);
    const pipeB = await mkPipeline(orgB, `Pipeline ${TOK_B}`);

    // ── Org A searchable rows ──────────────────────────────────────────────
    await owner.query(
      `insert into public.contacts (org_id, first_name, last_name, owner_person_id)
       values ($1,$2,$3,$4)`,
      [orgA, `Alicia`, `${TOK_A}`, alice],
    );
    await owner.query(
      `insert into public.companies (org_id, name, owner_person_id) values ($1,$2,$3)`,
      [orgA, `Acme ${TOK_A}`, alice],
    );
    await owner.query(
      `insert into public.deals (org_id, title, owner_person_id, pipeline_id)
       values ($1,$2,$3,$4)`,
      [orgA, `Deal ${TOK_A}`, alice, pipeA],
    );
    await owner.query(
      `insert into public.activities (org_id, entity_type, entity_id, type, subject, notes, owner_person_id)
       values ($1,'deal',gen_random_uuid(),'NOTE',$2,$3,$4)`,
      [orgA, `Note ${TOK_A}`, `notes ${TOK_A}`, alice],
    );
    await owner.query(`insert into public.work_projects (org_id, name) values ($1,$2)`, [
      orgA,
      `Project ${TOK_A}`,
    ]);
    await owner.query(
      `insert into public.work_tasks (org_id, title, status, priority) values ($1,$2,'todo','medium')`,
      [orgA, `Task ${TOK_A}`],
    );
    // A second + third task for pagination tests.
    await owner.query(
      `insert into public.work_tasks (org_id, title, status, priority) values ($1,$2,'in_progress','high')`,
      [orgA, `Task ${TOK_A} second`],
    );
    await owner.query(
      `insert into public.work_tasks (org_id, title, status, priority) values ($1,$2,'done','low')`,
      [orgA, `Task ${TOK_A} third`],
    );
    await owner.query(
      `insert into public.workflows (org_id, name, trigger) values ($1,$2,'{"type":"manual"}'::jsonb)`,
      [orgA, `Workflow ${TOK_A}`],
    );
    // Soft-deleted deal: must NEVER appear.
    await owner.query(
      `insert into public.deals (org_id, title, owner_person_id, pipeline_id, deleted_at)
       values ($1,$2,$3,$4,now())`,
      [orgA, `Deleted ${TOK_A}`, alice, pipeA],
    );
    // XSS probe row: the title round-trips raw (output encoding is the renderer's job).
    await owner.query(
      `insert into public.work_tasks (org_id, title, status, priority) values ($1,$2,'todo','medium')`,
      [orgA, `<script>alert('xss-${RUN}')</script> ${TOK_A}`],
    );

    // ── Org B searchable rows (asymmetric tokens) ──────────────────────────
    await owner.query(
      `insert into public.contacts (org_id, first_name, last_name, owner_person_id)
       values ($1,$2,$3,$4)`,
      [orgB, `Brenda`, `${TOK_B}`, bob],
    );
    await owner.query(
      `insert into public.deals (org_id, title, owner_person_id, pipeline_id)
       values ($1,$2,$3,$4)`,
      [orgB, `Deal ${TOK_B}`, bob, pipeB],
    );
    await owner.query(
      `insert into public.work_tasks (org_id, title, status, priority) values ($1,$2,'todo','medium')`,
      [orgB, `Task ${TOK_B}`],
    );

    // ── SELF-scope ownership fixtures ──────────────────────────────────────
    await owner.query(
      `insert into public.contacts (org_id, first_name, last_name, owner_person_id)
       values ($1,$2,$3,$4)`,
      [orgA, `OwnedBySelfy`, `${TOK_A}`, selfScoped],
    );
    await owner.query(
      `insert into public.contacts (org_id, first_name, last_name, owner_person_id)
       values ($1,$2,$3,$4)`,
      [orgA, `OwnedByAlice`, `${TOK_A}`, alice],
    );
  }, 60_000);

  afterAll(async () => {
    await owner.end().catch(() => undefined);
  });

  const run = (auth: Authorization, input: unknown) => search!.searchGlobal(auth, input);

  it('finds an exact title match (relevance 1.0)', async () => {
    const auth = makeAuth(alice, orgA, 'deals.view');
    const res = await run(auth, { query: `Deal ${TOK_A}`, entityTypes: ['deal'] });
    const hit = res.results.find((r) => r.entityType === 'deal');
    expect(hit).toBeDefined();
    expect(hit!.title).toBe(`Deal ${TOK_A}`);
    expect(hit!.relevance).toBe(1);
  });

  it('matches partial (prefix/substring) queries', async () => {
    const auth = makeAuth(alice, orgA, 'contacts.view');
    const prefix = await run(auth, { query: TOK_A.slice(0, 6), entityTypes: ['contact'] });
    expect(prefix.results.length).toBeGreaterThan(0);
    const sub = await run(auth, { query: RUN.slice(2, 7), entityTypes: ['contact'] });
    expect(sub.results.length).toBeGreaterThan(0);
  });

  it('is case-insensitive', async () => {
    const auth = makeAuth(alice, orgA, 'companies.view');
    const lower = await run(auth, {
      query: `acme ${TOK_A}`.toLowerCase(),
      entityTypes: ['company'],
    });
    const upper = await run(auth, { query: `ACME ${TOK_A}`, entityTypes: ['company'] });
    expect(lower.results.length).toBeGreaterThan(0);
    expect(upper.results.length).toBeGreaterThan(0);
    expect(lower.results[0]!.entityId).toBe(upper.results[0]!.entityId);
  });

  it('returns multiple entity types for one query', async () => {
    const auth = makeAuth(alice, orgA, 'people.view');
    const res = await run(auth, { query: TOK_A });
    const types = new Set(res.results.map((r) => r.entityType));
    expect(types.has('contact')).toBe(true);
    expect(types.has('deal')).toBe(true);
    expect(types.has('task')).toBe(true);
    expect(types.has('company')).toBe(true);
  });

  it('honours the entityTypes filter', async () => {
    const auth = makeAuth(alice, orgA, 'people.view');
    const res = await run(auth, { query: TOK_A, entityTypes: ['task'] });
    expect(res.results.length).toBeGreaterThan(0);
    for (const r of res.results) expect(r.entityType).toBe('task');
  });

  it('honours the status filter and rejects an invalid status', async () => {
    const auth = makeAuth(alice, orgA, 'tasks.view');
    const todo = await run(auth, { query: TOK_A, entityTypes: ['task'], status: 'todo' });
    expect(todo.results.length).toBeGreaterThan(0);
    for (const r of todo.results) expect(r.entityType).toBe('task');
    await expect(
      run(auth, { query: TOK_A, entityTypes: ['task'], status: 'BOGUS' }),
    ).rejects.toThrow(/INVALID_REQUEST/);
  });

  it('honours the ownerId filter and rejects cross-tenant ownerIds', async () => {
    const auth = makeAuth(alice, orgA, 'deals.view');
    const mine = await run(auth, { query: TOK_A, entityTypes: ['deal'], ownerId: alice });
    expect(mine.results.length).toBeGreaterThan(0);
    // bob is a live person but in the WRONG tenant → 400, not silent acceptance.
    await expect(run(auth, { query: TOK_A, entityTypes: ['deal'], ownerId: bob })).rejects.toThrow(
      /INVALID_REQUEST/,
    );
    await expect(
      run(auth, { query: TOK_A, entityTypes: ['deal'], ownerId: 'not-a-uuid' }),
    ).rejects.toThrow();
  });

  it('paginates deterministically', async () => {
    const auth = makeAuth(alice, orgA, 'tasks.view');
    const p1 = await run(auth, { query: TOK_A, entityTypes: ['task'], limit: 2, offset: 0 });
    const p2 = await run(auth, { query: TOK_A, entityTypes: ['task'], limit: 2, offset: 2 });
    expect(p1.results).toHaveLength(2);
    expect(p1.total).toBeGreaterThanOrEqual(4);
    const ids1 = new Set(p1.results.map((r) => r.entityId));
    for (const r of p2.results) expect(ids1.has(r.entityId)).toBe(false);
  });

  it('returns an empty page for a query that matches nothing', async () => {
    const auth = makeAuth(alice, orgA, 'people.view');
    const res = await run(auth, { query: `ZZZNOPE${RUN}` });
    expect(res.results).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('rejects invalid inputs (empty, too long, bad entity, bad limit)', async () => {
    const auth = makeAuth(alice, orgA, 'people.view');
    await expect(run(auth, { query: '   ' })).rejects.toThrow();
    await expect(run(auth, { query: 'x'.repeat(201) })).rejects.toThrow(/too long/);
    await expect(run(auth, { query: TOK_A, entityTypes: ['lead'] })).rejects.toThrow();
    await expect(run(auth, { query: TOK_A, limit: 999 })).rejects.toThrow();
    await expect(run(auth, { query: TOK_A, limit: 0 })).rejects.toThrow();
  });

  it('accepts boundary inputs (200-char query, limit 50)', async () => {
    const auth = makeAuth(alice, orgA, 'people.view');
    const res = await run(auth, {
      query: `${TOK_A} ${'x'.repeat(200 - TOK_A.length - 1)}`,
      limit: 50,
    });
    expect(res.limit).toBe(50);
    expect(res.results).toEqual([]);
  });

  it('never returns soft-deleted records', async () => {
    const auth = makeAuth(alice, orgA, 'deals.view');
    const res = await run(auth, { query: `Deleted ${TOK_A}` });
    expect(res.results).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('never leaks another tenant (§35: cross-tenant search)', async () => {
    const authA = makeAuth(alice, orgA, 'people.view');
    const resA = await run(authA, { query: TOK_B });
    expect(resA.results).toEqual([]);
    expect(resA.total).toBe(0);

    const authB = makeAuth(bob, orgB, 'people.view');
    const resB = await run(authB, { query: TOK_A });
    expect(resB.results).toEqual([]);
    expect(resB.total).toBe(0);
  });

  it('excludes entities the caller may not view (no permission → no rows, no counts)', async () => {
    const auth = makeAuth(charlie, orgA, 'people.view');
    const res = await run(auth, { query: TOK_A });
    expect(res.results).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('enforces record-level SELF scope (unauthorized records invisible)', async () => {
    const auth = makeAuth(selfScoped, orgA, 'contacts.view');
    const res = await run(auth, { query: TOK_A, entityTypes: ['contact'] });
    const titles = res.results.map((r) => r.title);
    expect(titles.some((t) => t.includes('OwnedBySelfy'))).toBe(true);
    expect(titles.some((t) => t.includes('OwnedByAlice'))).toBe(false);
  });

  it('treats SQL injection attempts as literal text (§35)', async () => {
    const auth = makeAuth(alice, orgA, 'people.view');
    for (const q of [`' OR '1'='1`, `'; DROP TABLE public.contacts; --`, `%${TOK_A}%`]) {
      // Each probe is literal text: it matches nothing (no wildcard / quote
      // semantics) and never errors the query.
      const res = await run(auth, { query: q });
      expect(res.results).toEqual([]);
      expect(res.total).toBe(0);
    }
    // The table the injection tried to drop is intact.
    const intact = await owner.query(`select count(*) c from public.contacts`);
    expect(Number(intact.rows[0]!.c)).toBeGreaterThan(0);
    // A tautology probe matches nothing (no wildcard semantics from quotes).
    const taut = await run(auth, { query: `' OR '1'='1` });
    expect(taut.results).toEqual([]);
  });

  it('round-trips stored markup without executing it (§35 XSS)', async () => {
    const auth = makeAuth(alice, orgA, 'tasks.view');
    const res = await run(auth, { query: `xss-${RUN}`, entityTypes: ['task'] });
    const hit = res.results.find((r) => r.title.includes('<script>'));
    expect(hit).toBeDefined();
    // Search returns the stored title verbatim; escaping happens at render time.
    expect(hit!.title).toContain(`<script>alert('xss-${RUN}')</script>`);
  });

  it('exposes no PII beyond the 0017 rule in person results', async () => {
    const auth = makeAuth(alice, orgA, 'people.view');
    const res = await run(auth, {
      query: `Alice ${TOK_A}`,
      entityTypes: ['person'],
    });
    for (const r of res.results) {
      const blob = JSON.stringify(r);
      expect(blob).not.toContain('personal_email');
      expect(blob).not.toContain('+91-00000-00000');
      expect(blob).not.toContain('1990-01-01');
    }
  });
});
