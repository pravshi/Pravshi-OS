/**
 * 0088 — /api/crm/imports/:id/decisions through the real route handlers, real Better Auth
 * sessions and real TOTP (tests/authz/fixtures), as crm-imports-routes.test.ts does for 0081.
 * Proves the route's refusals: crm.import for GET; crm.import plus the create permissions and
 * MFA for PUT; the importer only; another organization's import answers 404; malformed and
 * oversized bodies are refused before anything is recorded; a refusal never echoes an entity key
 * or a database error; repeated and concurrent PUTs; no decision after confirmation. Nothing
 * stubs an authorization decision.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Account } from '../authz/fixtures';
import { companyKeyOf } from '@/lib/import/sales-sheet/preview';

const HAS_DB = Boolean(process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_MIGRATE);
const ALL: [string, string][] = [
  'crm.import',
  'companies.view',
  'companies.create',
  'companies.edit',
  'contacts.view',
  'contacts.create',
  'contacts.edit',
  'deals.view',
  'deals.create',
  'deals.edit',
  'people.view',
  'jobs.create',
].map((k): [string, string] => [k, 'GLOBAL']);
const without = (key: string) => ALL.filter(([k]) => k !== key);

type Handler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

describe.skipIf(!HAS_DB)('/api/crm/imports/:id/decisions routes (0088)', () => {
  let fx: typeof import('../authz/fixtures');
  let owner: ReturnType<typeof import('../authz/fixtures').ownerPool>;
  let upload: Handler;
  let confirm: Handler;
  let getDecisions: Handler;
  let putDecision: Handler;
  const acct: Record<string, Account> = {};
  const roles: Record<string, string> = {};
  const run = Math.random().toString(36).slice(2, 8);
  const ownerEmail = `dec-owner.${run}@example.test`;
  let orgA = '';

  const call = (
    handler: Handler,
    who: string,
    path: string,
    init: { method?: string; body?: BodyInit; params?: Record<string, string> } = {},
  ) =>
    handler(
      new Request(`http://localhost:3000${path}`, {
        method: init.method ?? 'POST',
        headers: fx.headersFor(acct[who]!.cookie),
        body: init.body,
      }),
      { params: Promise.resolve(init.params ?? {}) },
    );
  const get = (who: string, id: string) =>
    call(getDecisions, who, `/api/crm/imports/${id}/decisions`, {
      method: 'GET',
      params: { id },
    });
  const put = (who: string, id: string, body: BodyInit) =>
    call(putDecision, who, `/api/crm/imports/${id}/decisions`, {
      method: 'PUT',
      body,
      params: { id },
    });
  const decision = (key: string, d: string | null) =>
    JSON.stringify({ kind: 'COMPANY', key, decision: d });

  /** A fresh import with one possible duplicate company; returns its id, hash and key. */
  const importWithDuplicate = async (label: string, who = 'full') => {
    const company = `Dec ${label} ${run}`;
    await owner.query(
      `insert into public.companies (org_id, owner_person_id, name, country_code)
       values ($1, $2, $3, 'IN')`,
      [orgA, acct.full!.personId, company],
    );
    const res = await call(
      upload,
      who,
      `/api/crm/imports?fileName=${encodeURIComponent(`${label}.csv`)}`,
      { body: new TextEncoder().encode(`Company,Owner Email\n${company},${ownerEmail}\n`) },
    );
    expect(res.status).toBe(201);
    const view = (await res.json()) as { id: string; fileSha256: string };
    return {
      id: view.id,
      sha: view.fileSha256,
      key: companyKeyOf(null, company),
    };
  };
  const storedDecisions = async (id: string) =>
    (
      await owner.query<{ n: number }>(
        `select count(*)::int n from public.crm_import_decisions where import_id = $1`,
        [id],
      )
    ).rows[0]!.n;

  beforeAll(async () => {
    fx = await import('../authz/fixtures');
    owner = fx.ownerPool();
    upload = (await import('@/app/api/crm/imports/route')).POST as unknown as Handler;
    confirm = (await import('@/app/api/crm/imports/[id]/confirm/route')).POST as unknown as Handler;
    const route = await import('@/app/api/crm/imports/[id]/decisions/route');
    getDecisions = route.GET as unknown as Handler;
    putDecision = route.PUT as unknown as Handler;

    orgA = await fx.mkOrg(owner, `dec-routes-a-${run}`);
    const orgB = await fx.mkOrg(owner, `dec-routes-b-${run}`);
    const tagged = run.toUpperCase().replace(/[^A-Z0-9]/g, 'X');
    const deptA = await fx.mkDept(owner, orgA, `DR${tagged}`);
    const deptB = await fx.mkDept(owner, orgB, `DR${tagged}`);
    const specs: [string, string, string, [string, string][], boolean][] = [
      ['full', orgA, deptA, ALL, true],
      ['colleague', orgA, deptA, ALL, true],
      ['noMfa', orgA, deptA, ALL, false],
      ['noImport', orgA, deptA, without('crm.import'), true],
      ['noDeals', orgA, deptA, without('deals.create'), true],
      ['otherOrg', orgB, deptB, ALL, true],
      // Uploads with every permission; loses deals.create afterwards (the importer's own PUT).
      ['shrink', orgA, deptA, ALL, true],
    ];
    for (const [label, org, dept, grants, mfa] of specs) {
      const r = await fx.mkCustomRole(owner, org, `DR_${label.toUpperCase()}_${tagged}`, grants);
      roles[label] = r;
      acct[label] = await fx.mkAccount(owner, {
        org,
        dept,
        run,
        label: `dr-${label.toLowerCase()}`,
        customRoles: [r],
        mfa,
      });
    }
    await owner.query(`update public.people set work_email = $2 where id = $1`, [
      acct.full!.personId,
      ownerEmail,
    ]);
  }, 180_000);

  afterAll(async () => {
    await owner?.end();
  });

  it('refuses callers without the permissions, without MFA, or not the importer — and records nothing', async () => {
    const imp = await importWithDuplicate('authz');
    const body = decision(imp.key, 'SKIP');
    expect((await get('noImport', imp.id)).status).toBe(403);
    expect((await put('noImport', imp.id, body)).status).toBe(403);
    // GET needs only crm.import; PUT also needs every create permission the file writes — even
    // for the importer: one who loses deals.create after uploading can read, not decide.
    expect((await get('noDeals', imp.id)).status).toBe(200);
    expect((await put('noDeals', imp.id, body)).status).toBe(403);
    const own = await importWithDuplicate('shrink', 'shrink');
    await owner.query(
      `delete from public.role_permissions rp using public.permissions p
       where rp.role_id = $1 and rp.permission_id = p.id and p.key = 'deals.create'`,
      [roles.shrink],
    );
    expect((await get('shrink', own.id)).status).toBe(200);
    const lost = await put('shrink', own.id, decision(own.key, 'SKIP'));
    expect(lost.status).toBe(403);
    expect(((await lost.json()) as { error: unknown }).error).not.toBe('NOT_IMPORTER');
    expect(await storedDecisions(own.id)).toBe(0);
    const stepUp = await put('noMfa', imp.id, body);
    expect(stepUp.status).toBe(403);
    expect(((await stepUp.json()) as { error: { code: string } }).error.code).toBe(
      'STEP_UP_REQUIRED',
    );
    // A GLOBAL holder of crm.import who is not the importer may read, never decide.
    expect((await get('colleague', imp.id)).status).toBe(200);
    const notImporter = await put('colleague', imp.id, body);
    expect(notImporter.status).toBe(403);
    expect(((await notImporter.json()) as { error: string }).error).toBe('NOT_IMPORTER');
    expect(await storedDecisions(imp.id)).toBe(0);
  });

  it('another organization’s import, and an id that is not a uuid, answer 404', async () => {
    const imp = await importWithDuplicate('scope');
    for (const res of [
      await get('otherOrg', imp.id),
      await put('otherOrg', imp.id, decision(imp.key, 'SKIP')),
      await get('full', 'not-a-uuid'),
      await put('full', 'not-a-uuid', decision(imp.key, 'SKIP')),
      await get('full', crypto.randomUUID()),
    ]) {
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).not.toContain(imp.key);
    }
    expect(await storedDecisions(imp.id)).toBe(0);
  });

  it('refuses malformed and oversized bodies before recording anything, without echoing keys or SQL', async () => {
    const imp = await importWithDuplicate('malformed');
    const bad: [BodyInit, number][] = [
      ['{not json', 400],
      ['', 400],
      [JSON.stringify({ kind: 'COMPANY', key: imp.key }), 400],
      [JSON.stringify({ kind: 'WIDGET', key: imp.key, decision: 'SKIP' }), 400],
      [JSON.stringify({ kind: 'COMPANY', key: imp.key, decision: 'MERGE' }), 400],
      [JSON.stringify({ kind: 'COMPANY', key: imp.key, decision: 'SKIP', extra: 1 }), 400],
      [JSON.stringify({ kind: 'COMPANY', key: 'x'.repeat(1201), decision: 'SKIP' }), 400],
      [JSON.stringify({ kind: 'COMPANY', key: 'k'.repeat(5000), decision: 'SKIP' }), 413],
      // Well-formed, but not a possible duplicate of this import / a deal cannot link.
      [decision('name:not in this file', 'SKIP'), 422],
      [JSON.stringify({ kind: 'DEAL', key: 'a|b|c', decision: 'LINK_EXISTING' }), 422],
    ];
    for (const [body, status] of bad) {
      const res = await put('full', imp.id, body);
      expect(res.status, String(body).slice(0, 60)).toBe(status);
      const text = await res.text();
      expect(text).not.toMatch(/select |insert |crm_import_decisions|sqlstate/i);
      if (status === 422) expect(text).not.toContain('not in this file');
    }
    expect(await storedDecisions(imp.id)).toBe(0);
  });

  it('a repeated PUT is idempotent; concurrent PUTs leave one decision; none after confirmation', async () => {
    const imp = await importWithDuplicate('retry');
    const first = await put('full', imp.id, decision(imp.key, 'CREATE_NEW'));
    expect(first.status).toBe(200);
    const again = await put('full', imp.id, decision(imp.key, 'CREATE_NEW'));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
    expect(await storedDecisions(imp.id)).toBe(1);

    const raced = await Promise.all(
      (['SKIP', 'CREATE_NEW', 'SKIP', 'LINK_EXISTING'] as const).map((d) =>
        put('full', imp.id, decision(imp.key, d)),
      ),
    );
    expect(raced.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(await storedDecisions(imp.id)).toBe(1);

    const settled = (await (await put('full', imp.id, decision(imp.key, 'CREATE_NEW'))).json()) as {
      counts: unknown;
    };
    const confirmed = await call(confirm, 'full', `/api/crm/imports/${imp.id}/confirm`, {
      body: JSON.stringify({ fileSha256: imp.sha, counts: settled.counts }),
      params: { id: imp.id },
    });
    expect(confirmed.status).toBe(202);
    const late = await put('full', imp.id, decision(imp.key, null));
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toBe('NOT_PREVIEWED');
    // Reading still works after confirmation; the decision is the one confirmed.
    const after = (await (await get('full', imp.id)).json()) as {
      decisions: { decision: string }[];
    };
    expect(after.decisions.map((d) => d.decision)).toEqual(['CREATE_NEW']);
  });
});
