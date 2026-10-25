/**
 * BP-06, 0081 — /api/crm/imports through the real route handlers, real Better Auth sessions and
 * real TOTP (tests/authz/fixtures). Proves the refusals the database cannot express on its own:
 * crm.import plus the create permission of every table the file writes (AC-S1), jobs.create for
 * the commit, MFA for a GLOBAL holder of a sensitive permission, body limits, malformed input, and
 * another organization's import answering 404. Nothing stubs an authorization decision.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Account } from '../authz/fixtures';

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

describe.skipIf(!HAS_DB)('/api/crm/imports routes (0081)', () => {
  let fx: typeof import('../authz/fixtures');
  let owner: ReturnType<typeof import('../authz/fixtures').ownerPool>;
  let upload: Handler;
  let read: Handler;
  let confirm: Handler;
  let cancel: Handler;
  let failedRows: Handler;
  const acct: Record<string, Account> = {};
  const run = Math.random().toString(36).slice(2, 8);
  const ownerEmail = `imp-owner.${run}@example.test`;
  const csv = (company: string) =>
    new TextEncoder().encode(`Company,Owner Email\n${company} ${run},${ownerEmail}\n`);

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
  const uploadAs = (who: string, body: BodyInit, fileName = 'routes.csv') =>
    call(upload, who, `/api/crm/imports?fileName=${encodeURIComponent(fileName)}`, { body });

  beforeAll(async () => {
    fx = await import('../authz/fixtures');
    owner = fx.ownerPool();
    upload = (await import('@/app/api/crm/imports/route')).POST as unknown as Handler;
    read = (await import('@/app/api/crm/imports/[id]/route')).GET as unknown as Handler;
    confirm = (await import('@/app/api/crm/imports/[id]/confirm/route')).POST as unknown as Handler;
    cancel = (await import('@/app/api/crm/imports/[id]/cancel/route')).POST as unknown as Handler;
    failedRows = (await import('@/app/api/crm/imports/[id]/failed-rows/route'))
      .GET as unknown as Handler;

    const orgA = await fx.mkOrg(owner, `imp-routes-a-${run}`);
    const orgB = await fx.mkOrg(owner, `imp-routes-b-${run}`);
    const deptA = await fx.mkDept(owner, orgA, `IR${run.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`);
    const deptB = await fx.mkDept(owner, orgB, `IR${run.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`);
    const role = (org: string, key: string, grants: [string, string][]) =>
      fx.mkCustomRole(owner, org, `${key}_${run.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, grants);
    const specs: [string, string, string, [string, string][], boolean][] = [
      ['full', orgA, deptA, ALL, true],
      ['noMfa', orgA, deptA, ALL, false],
      ['noImport', orgA, deptA, without('crm.import'), false],
      ['noDeals', orgA, deptA, without('deals.create'), true],
      ['noJobs', orgA, deptA, without('jobs.create'), true],
      ['otherOrg', orgB, deptB, ALL, true],
    ];
    for (const [label, org, dept, grants, mfa] of specs) {
      const r = await role(org, `IR_${label.toUpperCase()}`, grants);
      acct[label] = await fx.mkAccount(owner, {
        org,
        dept,
        run,
        label: `ir-${label.toLowerCase()}`,
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

  it('refuses an upload without crm.import, without a create permission, or without MFA (AC-S1)', async () => {
    expect((await uploadAs('noImport', csv('A'))).status).toBe(403);
    expect((await uploadAs('noDeals', csv('A'))).status).toBe(403);
    const stepUp = await uploadAs('noMfa', csv('A'));
    expect(stepUp.status).toBe(403);
    expect(((await stepUp.json()) as { error: { code: string } }).error.code).toBe(
      'STEP_UP_REQUIRED',
    );
  });

  it('refuses malformed and oversized input before recording anything', async () => {
    const tooBig = new Uint8Array(5 * 1024 * 1024 + 1).fill(0x41);
    expect((await uploadAs('full', tooBig)).status).toBe(413);
    const notUtf8 = await uploadAs('full', new Uint8Array([0x43, 0xff, 0x0a]));
    expect(notUtf8.status).toBe(422);
    expect(((await notUtf8.json()) as { error: string }).error).toBe('NOT_UTF8');
    expect((await uploadAs('full', csv('A'), 'bad\u0007name.csv')).status).toBe(400);
    expect((await uploadAs('full', new TextEncoder().encode('Owner Email\nx@y.z\n'))).status).toBe(
      422,
    );
  });

  it('previews, confirms once, and refuses what it must around confirmation', async () => {
    const created = await uploadAs('full', csv('Routes'));
    expect(created.status).toBe(201);
    const view = (await created.json()) as {
      id: string;
      fileSha256: string;
      preview: { counts: unknown };
    };
    const params = { id: view.id };
    const body = JSON.stringify({ fileSha256: view.fileSha256, counts: view.preview.counts });
    const confirmAs = (who: string, b: BodyInit = body) =>
      call(confirm, who, `/api/crm/imports/${view.id}/confirm`, { body: b, params });

    // jobs.create is required for the commit; another organization sees nothing.
    expect((await confirmAs('noJobs')).status).toBe(403);
    expect((await confirmAs('otherOrg')).status).toBe(404);
    expect(
      (await call(read, 'otherOrg', `/api/crm/imports/${view.id}`, { method: 'GET', params }))
        .status,
    ).toBe(404);
    expect(
      (await call(cancel, 'otherOrg', `/api/crm/imports/${view.id}/cancel`, { params })).status,
    ).toBe(404);
    // Malformed, oversized, or not the preview that was shown.
    expect((await confirmAs('full', '{not json')).status).toBe(400);
    expect((await confirmAs('full', JSON.stringify({ fileSha256: 'x' }))).status).toBe(400);
    expect((await confirmAs('full', ' '.repeat(256 * 1024 + 1))).status).toBe(413);
    const mismatch = await confirmAs(
      'full',
      JSON.stringify({ fileSha256: '0'.repeat(64), counts: view.preview.counts }),
    );
    expect(mismatch.status).toBe(409);
    expect(((await mismatch.json()) as { error: string }).error).toBe('PREVIEW_MISMATCH');

    const queued = await confirmAs('full');
    expect(queued.status).toBe(202);
    expect(((await queued.json()) as { status: string }).status).toBe('QUEUED');
    const again = await confirmAs('full');
    expect(again.status).toBe(202);
    const jobs = await owner.query<{ n: number }>(
      `select count(*)::int n from public.jobs where dedup_key = $1`,
      [`crm_import:${view.id}`],
    );
    expect(jobs.rows[0]!.n).toBe(1);

    // The same file again is refused with the earlier import named (AC-I1).
    const second = (await (await uploadAs('full', csv('Routes'))).json()) as {
      id: string;
      fileSha256: string;
      preview: { counts: unknown };
    };
    const refused = await call(confirm, 'full', `/api/crm/imports/${second.id}/confirm`, {
      body: JSON.stringify({ fileSha256: second.fileSha256, counts: second.preview.counts }),
      params: { id: second.id },
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: 'ALREADY_IMPORTED',
      earlierImportId: view.id,
    });

    // Leave nothing for a real worker to pick up from this suite.
    await owner.query(`update public.jobs set status = 'cancelled' where dedup_key = $1`, [
      `crm_import:${view.id}`,
    ]);
  });

  it('serves the failed rows as CSV, and 404 for an id that is not a uuid', async () => {
    const created = (await (
      await uploadAs(
        'full',
        new TextEncoder().encode(`Company,Owner Email\nFails ${run},stranger@nowhere.example\n`),
      )
    ).json()) as { id: string };
    const res = await call(failedRows, 'full', `/api/crm/imports/${created.id}/failed-rows`, {
      method: 'GET',
      params: { id: created.id },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="import-${created.id}-failed-rows.csv"`,
    );
    expect((await res.text()).split('\r\n')[1]).toMatch(/^"2",/);
    const bad = await call(failedRows, 'full', '/api/crm/imports/x/failed-rows', {
      method: 'GET',
      params: { id: 'x"\r\nSet-Cookie: a=b' },
    });
    expect(bad.status).toBe(404);
  });
});
