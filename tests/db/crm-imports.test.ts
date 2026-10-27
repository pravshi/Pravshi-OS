/**
 * BP-06, migration 0081 — the stored Sales Sheet import, end to end against a live database:
 * preview → record → confirm → crm_import job principal → background commit (proposal AC-T2).
 *
 * The services are called with the importer's identity; every write goes through
 * withAuthorizedDb() and is decided by RLS, the 0081 guards and the CRM's own policies and
 * triggers. Fixtures are fresh organizations per run, so the suite is re-runnable on the shared
 * test database. The file is tests/fixtures/sales-sheet/representative.csv (no real data).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { DB_READY, RUN, mkOrg, mkPerson } from '../workflows/helpers';
import { assignRoleId, mkCustomRole } from '../authz/fixtures';

const FIXTURE = new Uint8Array(
  readFileSync(join(process.cwd(), 'tests', 'fixtures', 'sales-sheet', 'representative.csv')),
);
const IMPORTER_GRANTS: [string, string][] = [
  ['crm.import', 'GLOBAL'],
  ['companies.view', 'GLOBAL'],
  ['companies.create', 'GLOBAL'],
  ['companies.edit', 'GLOBAL'],
  ['contacts.view', 'GLOBAL'],
  ['contacts.create', 'GLOBAL'],
  ['contacts.edit', 'GLOBAL'],
  ['deals.view', 'GLOBAL'],
  ['deals.create', 'GLOBAL'],
  ['deals.edit', 'GLOBAL'],
  ['people.view', 'GLOBAL'],
  ['jobs.create', 'GLOBAL'],
];

/** The SQLSTATE a promise rejects with — through drizzle's wrapper (`cause`) — or NO ERROR. */
async function stateOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'NO ERROR';
  } catch (error) {
    for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
      const code = (e as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
    return String(error);
  }
}

type Svc = typeof import('@/lib/import/sales-sheet/service');
type Commit = typeof import('@/lib/import/sales-sheet/commit');

describe.skipIf(!DB_READY)('Sales Sheet import persistence (0081, live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  const worker = new Pool({ connectionString: process.env.DATABASE_URL_WORKER });
  const app = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
  let svc: Svc;
  let commit: Commit;
  let orgA = '';
  let orgB = '';
  let importer = '';
  let colleague = '';
  let selfImporter = '';
  let noImport = '';
  let importerB = '';
  let ownerOne = '';

  const authOf = (orgId: string, personId: string) => {
    const requestId = randomUUID();
    return {
      ctx: { personId, orgId, aal: 'aal2' as const },
      permission: 'crm.import',
      scope: 'GLOBAL' as const,
      aal: 'aal2' as const,
      requestId,
      meta: { requestId, ip: null, userAgent: null },
    } as unknown as Parameters<Svc['getImport']>[0];
  };
  const ctxOf = (orgId: string, personId: string) => ({ personId, orgId, aal: 'aal1' as const });

  /** Runs SQL as app_user with the given identity, inside a rolled-back transaction. */
  const asUser = async <T extends Record<string, unknown>>(
    orgId: string,
    personId: string,
    text: string,
    params: unknown[] = [],
  ) => {
    const c = await app.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.person_id', $1, true), set_config('app.org_id', $2, true),
                set_config('app.aal', 'aal2', true)`,
        [personId, orgId],
      );
      return await c.query<T>(text, params);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  };

  const setWorkEmail = (person: string, email: string) =>
    owner.query(`update public.people set work_email = $2 where id = $1`, [person, email]);

  const countsOf = (v: Awaited<ReturnType<Svc['getImport']>>) => v.preview.counts;

  beforeAll(async () => {
    svc = await import('@/lib/import/sales-sheet/service');
    commit = await import('@/lib/import/sales-sheet/commit');

    orgA = await mkOrg(owner, `imp-a-${RUN}`);
    orgB = await mkOrg(owner, `imp-b-${RUN}`);
    importer = await mkPerson(owner, orgA, 'Importer');
    colleague = await mkPerson(owner, orgA, 'Colleague');
    selfImporter = await mkPerson(owner, orgA, 'SelfImporter');
    noImport = await mkPerson(owner, orgA, 'NoImport');
    ownerOne = await mkPerson(owner, orgA, 'OwnerOne');
    const ownerTwo = await mkPerson(owner, orgA, 'OwnerTwo');
    importerB = await mkPerson(owner, orgB, 'ImporterB');
    await setWorkEmail(ownerOne, 'owner.one@pravshi.example');
    await setWorkEmail(ownerTwo, 'owner.two@pravshi.example');
    // The same owner address in organization B: it must never resolve for organization A.
    await setWorkEmail(importerB, 'owner.one@pravshi.example');

    const tag = RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X');
    const full = await mkCustomRole(owner, orgA, `IMP_${tag}`, IMPORTER_GRANTS);
    for (const p of [importer, colleague]) await assignRoleId(owner, p, orgA, full);
    const fullB = await mkCustomRole(owner, orgB, `IMPB_${tag}`, IMPORTER_GRANTS);
    await assignRoleId(owner, importerB, orgB, fullB);
    const self = await mkCustomRole(owner, orgA, `IMPS_${tag}`, [
      ['crm.import', 'GLOBAL'],
      ['companies.view', 'SELF'],
      ['companies.create', 'SELF'],
      ['companies.edit', 'SELF'],
      ['contacts.view', 'SELF'],
      ['contacts.create', 'SELF'],
      ['contacts.edit', 'SELF'],
      ['deals.view', 'SELF'],
      ['deals.create', 'SELF'],
      ['deals.edit', 'SELF'],
      ['people.view', 'GLOBAL'],
      ['jobs.create', 'GLOBAL'],
    ]);
    await assignRoleId(owner, selfImporter, orgA, self);
    const crmOnly = await mkCustomRole(
      owner,
      orgA,
      `IMPN_${tag}`,
      IMPORTER_GRANTS.filter(([k]) => k !== 'crm.import'),
    );
    await assignRoleId(owner, noImport, orgA, crmOnly);

    // Existing CRM data in organization A, owned by the importer: row 4 links to it, and a
    // same-name company without a domain makes row 5 a possible duplicate.
    const existing = (
      await owner.query<{ id: string }>(
        `insert into public.companies (org_id, owner_person_id, name, domain)
         values ($1, $2, 'Existing Co', 'existing.example') returning id`,
        [orgA, importer],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into public.contacts (org_id, owner_person_id, company_id, first_name, last_name, email)
       values ($1, $2, $3, 'Old', 'Contact', 'known@existing.example')`,
      [orgA, importer, existing],
    );
    await owner.query(
      `insert into public.companies (org_id, owner_person_id, name) values ($1, $2, 'Name Only Ltd')`,
      [orgA, importer],
    );
  });

  afterAll(async () => {
    await Promise.all([owner.end(), worker.end(), app.end()]);
  });

  const crmCount = async (org: string) =>
    (
      await owner.query<{ n: number }>(
        `select (select count(*) from public.companies where org_id = $1)
              + (select count(*) from public.contacts where org_id = $1)
              + (select count(*) from public.deals where org_id = $1) as n`,
        [org],
      )
    ).rows[0]!.n;

  let first: Awaited<ReturnType<Svc['getImport']>>;

  it('previews and records the file without writing to the CRM (AC-P1, AC-P3, AC-A3)', async () => {
    const before = await crmCount(orgA);
    first = await svc.createImportPreview(authOf(orgA, importer), {
      fileName: 'sales-sheet.csv',
      bytes: FIXTURE,
    });
    expect(first.status).toBe('PREVIEWED');
    expect(first.dataRows).toBe(10);
    expect(countsOf(first)).toMatchObject({ validRows: 6, invalidRows: 4 });
    expect(first.invalidRows.map((r) => r.rowNumber)).toEqual([7, 8, 9, 11]);
    expect(first.possibleDuplicateRows).toEqual([5]);
    expect(first.preview.unknownHeaders).toEqual(['Notes Column']);
    expect(await crmCount(orgA)).toBe(before);
    const stored = await owner.query<{ created_by: string; rows: number; values: string[] }>(
      `select i.created_by, (select count(*)::int from public.crm_import_rows r
                              where r.import_id = i.id) as rows,
              (select r.source_values from public.crm_import_rows r
                where r.import_id = i.id and r.row_number = 6) as values
       from public.crm_imports i where i.id = $1`,
      [first.id],
    );
    expect(stored.rows[0]).toMatchObject({ created_by: importer, rows: 10 });
    expect(stored.rows[0]!.values[0]).toBe('Quoted, Comma Pvt');
  });

  it('never resolves an owner from another organization (AC-P4, AC-S2)', () => {
    // owner.one exists in both organizations; organization A's row 9 owner is a stranger in
    // both. Row 2's owner resolved in A to A's person: proven at commit below.
    expect(first.invalidRows.find((r) => r.rowNumber === 9)!.errors[0]!.reason).toMatch(
      /not an active person of this organization/,
    );
  });

  it('refuses a confirmation that does not match the file or the preview (AC-P3)', async () => {
    const auth = authOf(orgA, importer);
    const base = { fileSha256: first.fileSha256, counts: countsOf(first) };
    await expect(
      svc.confirmImport(auth, first.id, { ...base, fileSha256: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'PREVIEW_MISMATCH' });
    await expect(
      svc.confirmImport(auth, first.id, {
        ...base,
        counts: { ...base.counts, validRows: base.counts.validRows + 1 },
      }),
    ).rejects.toMatchObject({ code: 'PREVIEW_MISMATCH' });
    await expect(
      svc.confirmImport(auth, first.id, { ...base, includeRows: [2] }),
    ).rejects.toMatchObject({ code: 'INVALID_INCLUDE' });
  });

  it('another crm.import holder sees the import but cannot change it (AC-S3)', async () => {
    const seen = await svc.getImport(authOf(orgA, colleague), first.id);
    expect(seen.id).toBe(first.id);
    expect(
      await stateOf(
        asUser(
          orgA,
          colleague,
          `update public.crm_imports set status = 'CANCELLED' where id = $1`,
          [first.id],
        ),
      ),
    ).toBe('42501');
  });

  it('isolates organizations and requires crm.import (AC-S2, AC-S3)', async () => {
    await expect(svc.getImport(authOf(orgB, importerB), first.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const fromB = await asUser(
      orgB,
      importerB,
      `select count(*)::int n from public.crm_import_rows
                                                  where import_id = $1`,
      [first.id],
    );
    expect(fromB.rows[0]!.n).toBe(0);
    const noPerm = await asUser(
      orgA,
      noImport,
      `select count(*)::int n from public.crm_imports
                                                  where id = $1`,
      [first.id],
    );
    expect(noPerm.rows[0]!.n).toBe(0);
    expect(
      await stateOf(
        svc.createImportPreview(authOf(orgA, noImport), { fileName: 'x.csv', bytes: FIXTURE }),
      ),
    ).toBe('42501');
  });

  it('keeps the recorded preview immutable and grants no delete', async () => {
    const auth = [orgA, importer] as const;
    expect(
      await stateOf(
        asUser(
          ...auth,
          `update public.crm_imports set file_sha256 = repeat('a', 64) where id = $1`,
          [first.id],
        ),
      ),
    ).toBe('23514');
    expect(
      await stateOf(
        asUser(
          ...auth,
          `update public.crm_import_rows set source_values = '[]' where import_id = $1`,
          [first.id],
        ),
      ),
    ).toBe('23514');
    expect(
      await stateOf(asUser(...auth, `delete from public.crm_imports where id = $1`, [first.id])),
    ).toBe('42501');
    // A row cannot be decided before its import runs.
    expect(
      await stateOf(
        asUser(
          ...auth,
          `update public.crm_import_rows set status = 'CREATED'
                          where import_id = $1 and row_number = 2`,
          [first.id],
        ),
      ),
    ).toBe('23514');
  });

  let jobId = '';

  it('confirms once: one job, bound to the importer, audited without row values (AC-I3, AC-A1)', async () => {
    const auth = authOf(orgA, importer);
    const body = { fileSha256: first.fileSha256, counts: countsOf(first) };
    const queued = await svc.confirmImport(auth, first.id, body);
    expect(queued.status).toBe('QUEUED');
    const again = await svc.confirmImport(auth, first.id, body);
    expect(again.status).toBe('QUEUED');
    const jobs = await owner.query<{ id: string; enqueued_by: string; payload: unknown }>(
      `select j.id, j.enqueued_by, j.payload from public.jobs j
       where j.org_id = $1 and j.type = 'crm_import' and j.dedup_key = $2`,
      [orgA, `crm_import:${first.id}`],
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.enqueued_by).toBe(importer);
    expect(jobs.rows[0]!.payload).toEqual({ importId: first.id });
    jobId = jobs.rows[0]!.id;
    const audit = await owner.query<{ n: number; metadata: Record<string, unknown> }>(
      `select count(*) over ()::int n, metadata from public.audit_logs
       where org_id = $1 and action = 'crm.import.started' and entity_id = $2`,
      [orgA, first.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(Object.keys(audit.rows[0]!.metadata).sort()).toEqual(
      [
        'dataRows',
        'fileName',
        'fileSha256',
        'importId',
        'includedRows',
        'invalidRows',
        'jobId',
        'reimport',
        'validRows',
      ].sort(),
    );
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toMatch(/acme|asha|example/i);
  });

  it('gives the job principal only to the worker holding the job (0081 definer)', async () => {
    const call = (pool: Pool, workerId: string) =>
      pool.query<{ person_id: string; import_id: string; import_status: string }>(
        `select person_id, import_id, import_status
         from public.crm_import_execute_as_job($1::uuid, $2)`,
        [jobId, workerId],
      );
    expect(await stateOf(call(worker, 'w-imp'))).toBe('22023'); // not running yet
    await owner.query(
      `update public.jobs set status = 'running', claimed_by = 'w-imp', claimed_at = now()
       where id = $1`,
      [jobId],
    );
    const ok = await call(worker, 'w-imp');
    expect(ok.rows[0]).toEqual({
      person_id: importer,
      import_id: first.id,
      import_status: 'QUEUED',
    });
    expect(await stateOf(call(worker, 'someone-else'))).toBe('42501');
    expect(await stateOf(call(app, 'w-imp'))).toBe('42501'); // app_user cannot execute it
  });

  it('commits as the importer: each row once, counts add up, owners handed over (AC-C1–C3, AC-A2)', async () => {
    const aborted = new AbortController();
    aborted.abort();
    // Interrupted before the first batch: the import is RUNNING and nothing is decided.
    await expect(
      commit.runImportCommit(ctxOf(orgA, importer), first.id, randomUUID(), aborted.signal),
    ).rejects.toThrow(/interrupted/);
    // Resumed (AC-I2).
    await commit.runImportCommit(ctxOf(orgA, importer), first.id, randomUUID());
    const done = await svc.getImport(authOf(orgA, importer), first.id);
    expect(done.status).toBe('COMPLETED_WITH_ERRORS');
    expect(done.result).toEqual({ created: 4, linked: 1, skipped: 1, failed: 4 });
    const rows = await owner.query<{ row_number: number; status: string }>(
      `select row_number, status from public.crm_import_rows where import_id = $1 order by 1`,
      [first.id],
    );
    expect(Object.fromEntries(rows.rows.map((r) => [r.row_number, r.status]))).toEqual({
      2: 'CREATED',
      3: 'CREATED',
      4: 'LINKED',
      5: 'SKIPPED',
      6: 'CREATED',
      7: 'FAILED',
      8: 'FAILED',
      9: 'FAILED',
      10: 'CREATED',
      11: 'FAILED',
    });
    const acme = await owner.query<{ n: number; owner_person_id: string; created_by: string }>(
      `select count(*) over ()::int n, owner_person_id, created_by from public.companies
       where org_id = $1 and domain = 'acme.example'`,
      [orgA],
    );
    expect(acme.rows).toHaveLength(1); // rows 2 and 3 are one company (AC-D4)
    expect(acme.rows[0]).toMatchObject({ owner_person_id: ownerOne, created_by: importer });
    const linked = await owner.query<{
      company_id: string;
      contact_id: string;
      deal_id: string | null;
    }>(
      `select r.company_id, r.contact_id, r.deal_id from public.crm_import_rows r
       where r.import_id = $1 and r.row_number = 4`,
      [first.id],
    );
    const existing = await owner.query<{ id: string }>(
      `select id from public.companies where org_id = $1 and domain = 'existing.example'`,
      [orgA],
    );
    expect(linked.rows[0]).toMatchObject({ company_id: existing.rows[0]!.id, deal_id: null });
    const untouched = await owner.query<{ owner_person_id: string }>(
      `select owner_person_id from public.companies where id = $1`,
      [existing.rows[0]!.id],
    );
    expect(untouched.rows[0]!.owner_person_id).toBe(importer); // AC-D5: never modified
    const audit = await owner.query<{ metadata: Record<string, unknown> }>(
      `select metadata from public.audit_logs
       where org_id = $1 and action = 'crm.import.completed' and entity_id = $2`,
      [orgA, first.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata).toMatchObject({ created: 4, linked: 1, skipped: 1, failed: 4 });
    // A decided row stays decided; a finished import stays finished.
    await commit.runImportCommit(ctxOf(orgA, importer), first.id, randomUUID());
    expect((await svc.getImport(authOf(orgA, importer), first.id)).result.created).toBe(4);
    expect(
      await stateOf(
        owner.query(`update public.crm_imports set status = 'RUNNING' where id = $1`, [first.id]),
      ),
    ).toBe('42501'); // no person identity at all
  });

  it('exports the failed rows with their reasons (AC-C4)', async () => {
    const csv = await svc.failedRowsFor(authOf(orgA, importer), first.id);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toMatch(/^"Row","Company",/);
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(['"7"', '"8"', '"9"', '"11"']);
  });

  it('refuses the same file again unless asked, then includes a chosen possible duplicate (AC-I1, AC-D1)', async () => {
    const auth = authOf(orgA, importer);
    const second = await svc.createImportPreview(auth, { fileName: 'again.csv', bytes: FIXTURE });
    expect(second.earlierImportId).toBe(first.id);
    const body = { fileSha256: second.fileSha256, counts: countsOf(second) };
    await expect(svc.confirmImport(auth, second.id, body)).rejects.toMatchObject({
      code: 'ALREADY_IMPORTED',
      details: { earlierImportId: first.id },
    });
    expect(second.possibleDuplicateRows).toEqual([2, 3, 5, 6]); // deals now exist; row 5 as before
    await svc.confirmImport(auth, second.id, { ...body, includeRows: [5], allowReimport: true });
    await commit.runImportCommit(ctxOf(orgA, importer), second.id, randomUUID());
    const rows = await owner.query<{ row_number: number; status: string }>(
      `select row_number, status from public.crm_import_rows
       where import_id = $1 and status <> 'FAILED' order by 1`,
      [second.id],
    );
    expect(Object.fromEntries(rows.rows.map((r) => [r.row_number, r.status]))).toEqual({
      2: 'SKIPPED',
      3: 'SKIPPED',
      4: 'LINKED',
      5: 'CREATED',
      6: 'SKIPPED',
      10: 'LINKED',
    });
  });

  it('fails a row alone when its owner is outside the importer’s reach (AC-C2, owner reach)', async () => {
    const auth = authOf(orgA, selfImporter);
    const csv = new TextEncoder().encode(
      'Company,Company Domain,Owner Email\n' +
        `Reach Ok ${RUN},reach-ok-${RUN}.example,selfimporter.${RUN}@pravshi.example\n` +
        `Reach Refused ${RUN},reach-no-${RUN}.example,owner.one@pravshi.example\n`,
    );
    await setWorkEmail(selfImporter, `selfimporter.${RUN}@pravshi.example`);
    const v = await svc.createImportPreview(auth, { fileName: 'reach.csv', bytes: csv });
    await svc.confirmImport(auth, v.id, { fileSha256: v.fileSha256, counts: countsOf(v) });
    await commit.runImportCommit(ctxOf(orgA, selfImporter), v.id, randomUUID());
    const done = await svc.getImport(auth, v.id);
    expect(done.result).toEqual({ created: 1, linked: 0, skipped: 0, failed: 1 });
    expect(done.invalidRows[0]).toMatchObject({ rowNumber: 3 });
    expect(done.invalidRows[0]!.errors[0]!.reason).toMatch(/not permitted/);
    const refused = await owner.query<{ n: number }>(
      `select count(*)::int n from public.companies where org_id = $1 and domain = $2`,
      [orgA, `reach-no-${RUN}.example`],
    );
    expect(refused.rows[0]!.n).toBe(0); // the row's savepoint rolled its insert back
  });

  it('fails only the row a concurrent change broke (AC-T2)', async () => {
    const auth = authOf(orgA, importer);
    const csv = new TextEncoder().encode(
      'Company,Company Domain,Contact First Name,Contact Last Name,Contact Email,Owner Email\n' +
        `Race One ${RUN},race1-${RUN}.example,Ann,Ray,ann-${RUN}@race.example,owner.one@pravshi.example\n` +
        `Race Two ${RUN},race2-${RUN}.example,Ben,Roy,ben-${RUN}@race.example,owner.one@pravshi.example\n`,
    );
    const v = await svc.createImportPreview(auth, { fileName: 'race.csv', bytes: csv });
    expect(countsOf(v)).toMatchObject({ validRows: 2, invalidRows: 0 });
    // After the preview, someone else creates Ben under another company.
    const other = (
      await owner.query<{ id: string }>(
        `insert into public.companies (org_id, owner_person_id, name) values ($1,$2,$3) returning id`,
        [orgA, colleague, `Elsewhere ${RUN}`],
      )
    ).rows[0]!.id;
    await owner.query(
      `insert into public.contacts (org_id, owner_person_id, company_id, first_name, last_name, email)
       values ($1,$2,$3,'Ben','Roy',$4)`,
      [orgA, colleague, other, `ben-${RUN}@race.example`],
    );
    await svc.confirmImport(auth, v.id, { fileSha256: v.fileSha256, counts: countsOf(v) });
    await commit.runImportCommit(ctxOf(orgA, importer), v.id, randomUUID());
    const done = await svc.getImport(auth, v.id);
    expect(done.result).toEqual({ created: 1, linked: 0, skipped: 0, failed: 1 });
    expect(done.invalidRows[0]!.errors[0]!.reason).toMatch(/another company/);
  });

  it('cancels a queued import, and its job then ends without writing', async () => {
    const auth = authOf(orgA, importer);
    const csv = new TextEncoder().encode(
      `Company,Owner Email\nCancelled ${RUN},owner.one@pravshi.example\n`,
    );
    const v = await svc.createImportPreview(auth, { fileName: 'cancel.csv', bytes: csv });
    await svc.confirmImport(auth, v.id, { fileSha256: v.fileSha256, counts: countsOf(v) });
    expect((await svc.cancelImport(auth, v.id)).status).toBe('CANCELLED');
    const job = await owner.query<{ id: string }>(
      `select id from public.jobs where org_id = $1 and dedup_key = $2`,
      [orgA, `crm_import:${v.id}`],
    );
    await owner.query(
      `update public.jobs set status = 'running', claimed_by = 'w-cancel', claimed_at = now()
       where id = $1`,
      [job.rows[0]!.id],
    );
    const p = await worker.query<{ import_status: string }>(
      `select import_status from public.crm_import_execute_as_job($1::uuid, 'w-cancel')`,
      [job.rows[0]!.id],
    );
    expect(p.rows[0]!.import_status).toBe('CANCELLED');
    await commit.runImportCommit(ctxOf(orgA, importer), v.id, randomUUID());
    const n = await owner.query<{ n: number }>(
      `select count(*)::int n from public.companies where org_id = $1 and name = $2`,
      [orgA, `Cancelled ${RUN}`],
    );
    expect(n.rows[0]!.n).toBe(0);
  });

  it('runs through the crm_import job handler on the worker plane, as the importer', async () => {
    const { handleCrmImport } = await import('@/lib/import/sales-sheet/job');
    const auth = authOf(orgA, importer);
    const csv = new TextEncoder().encode(
      `Company,Company Domain,Owner Email\nVia Job ${RUN},via-job-${RUN}.example,owner.one@pravshi.example\n`,
    );
    const v = await svc.createImportPreview(auth, { fileName: 'job.csv', bytes: csv });
    await svc.confirmImport(auth, v.id, { fileSha256: v.fileSha256, counts: countsOf(v) });
    const job = (
      await owner.query<{ id: string }>(
        `update public.jobs set status = 'running', claimed_by = 'w-handler', claimed_at = now()
         where org_id = $1 and dedup_key = $2 returning id`,
        [orgA, `crm_import:${v.id}`],
      )
    ).rows[0]!.id;
    const jobCtx = (payload: Record<string, unknown>) =>
      ({
        job: { id: job, orgId: orgA, type: 'crm_import', payload },
        workerId: 'w-handler',
        signal: new AbortController().signal,
        auth: undefined,
      }) as unknown as Parameters<typeof handleCrmImport>[0];
    // A payload naming another import is refused, non-retryably, before anything is written.
    await expect(handleCrmImport(jobCtx({ importId: first.id }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await handleCrmImport(jobCtx({ importId: v.id }));
    const done = await svc.getImport(auth, v.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.result.created).toBe(1);
    const company = await owner.query<{ created_by: string; owner_person_id: string }>(
      `select created_by, owner_person_id from public.companies where org_id = $1 and domain = $2`,
      [orgA, `via-job-${RUN}.example`],
    );
    expect(company.rows[0]).toEqual({ created_by: importer, owner_person_id: ownerOne });
  });

  // ── Remediation (independent reviews of 0081): retention, errors, duplicates, stuck imports ──

  const enc = (s: string) => new TextEncoder().encode(s);
  /** Preview and confirm a file as the importer; returns the import id and its job id. */
  const queue = async (
    person: string,
    fileName: string,
    csv: string,
    includeRows: number[] = [],
  ) => {
    const auth = authOf(orgA, person);
    const v = await svc.createImportPreview(auth, { fileName, bytes: enc(csv) });
    await svc.confirmImport(auth, v.id, {
      fileSha256: v.fileSha256,
      counts: countsOf(v),
      includeRows,
    });
    const job = await owner.query<{ id: string }>(
      `select job_id as id from public.crm_imports where id = $1`,
      [v.id],
    );
    return { id: v.id, jobId: job.rows[0]!.id, view: v };
  };
  const claim = (jobId: string, workerId: string) =>
    owner.query(
      `update public.jobs set status = 'running', claimed_by = $2, claimed_at = now() where id = $1`,
      [jobId, workerId],
    );
  const jobCtxFor = (jobId: string, importId: string, workerId: string) =>
    ({
      job: {
        id: jobId,
        orgId: orgA,
        type: 'crm_import',
        payload: { importId },
        attempts: 0,
        maxAttempts: 5,
      },
      workerId,
      signal: new AbortController().signal,
      auth: undefined,
    }) as unknown as Parameters<
      Awaited<typeof import('@/lib/import/sales-sheet/job')>['handleCrmImport']
    >[0];
  const statusOf = async (id: string) =>
    (
      await owner.query<{ status: string; failure_reason: string | null; job_id: string | null }>(
        `select status, failure_reason, job_id from public.crm_imports where id = $1`,
        [id],
      )
    ).rows[0]!;

  it('binds an import to a job of its own organization, and only deletion clears it (0081 F-1)', async () => {
    const q = await queue(
      importer,
      'bind.csv',
      `Company,Owner Email\nBind ${RUN},owner.one@pravshi.example\n`,
    );
    // The importer cannot unbind a live job, nor point the import at another job.
    expect(
      await stateOf(
        asUser(orgA, importer, `update public.crm_imports set job_id = null where id = $1`, [q.id]),
      ),
    ).toBe('23514');
    // A job of another organization cannot be bound at all: the composite foreign key.
    const p = await svc.createImportPreview(authOf(orgA, importer), {
      fileName: 'bind2.csv',
      bytes: enc(`Company,Owner Email\nBind Two ${RUN},owner.one@pravshi.example\n`),
    });
    const foreignJob = (
      await owner.query<{ id: string }>(
        `insert into public.jobs (org_id, type, payload) values ($1, 'cleanup', '{"target":"x"}')
         returning id`,
        [orgB],
      )
    ).rows[0]!.id;
    expect(
      await stateOf(
        asUser(
          orgA,
          importer,
          `update public.crm_imports set status = 'QUEUED', job_id = $2 where id = $1`,
          [p.id, foreignJob],
        ),
      ),
    ).toBe('23503');
    // Deleting the job (retention, cleanup, an operator) succeeds and clears only job_id.
    const before = await owner.query(`select * from public.crm_imports where id = $1`, [q.id]);
    await owner.query(`delete from public.jobs where id = $1`, [q.jobId]);
    const after = await owner.query(`select * from public.crm_imports where id = $1`, [q.id]);
    expect({ ...after.rows[0], job_id: 'x' }).toEqual({ ...before.rows[0], job_id: 'x' });
    expect(after.rows[0]!.job_id).toBeNull();
    // The import stays auditable: its started entry still names the deleted job.
    const audit = await owner.query<{ job: string }>(
      `select metadata ->> 'jobId' as job from public.audit_logs
       where org_id = $1 and action = 'crm.import.started' and entity_id = $2`,
      [orgA, q.id],
    );
    expect(audit.rows[0]!.job).toBe(q.jobId);
    // …and, now abandoned, the maintenance sweep records its failure (stuck imports).
    const swept = await worker.query<{ n: number }>(
      `select public.crm_import_fail_abandoned(10000) n`,
    );
    expect(swept.rows[0]!.n).toBeGreaterThanOrEqual(1);
    expect(await statusOf(q.id)).toMatchObject({ status: 'FAILED', failure_reason: 'JOB_ENDED' });
    const failed = await owner.query<{ reason: string; result: string; actor: string | null }>(
      `select metadata ->> 'reason' as reason, result::text, actor_person_id as actor
       from public.audit_logs where org_id = $1 and action = 'crm.import.failed' and entity_id = $2`,
      [orgA, q.id],
    );
    // Attributed to the import's creator, never actor-less (audit-triggers.test.ts invariant).
    expect(failed.rows).toEqual([{ reason: 'JOB_ENDED', result: 'ERROR', actor: importer }]);
    // The sweep and the failure recorder are the worker's alone; no other role writes the table.
    expect(await stateOf(app.query(`select public.crm_import_fail_abandoned(1)`))).toBe('42501');
    expect(
      await stateOf(
        worker.query(`update public.crm_imports set failure_reason = 'X_X' where id = $1`, [q.id]),
      ),
    ).toBe('42501');
  });

  it('sanitises every error it lets out of the job handler (0081 F-2, unit)', async () => {
    // The end-to-end proof (a real non-row failure, the stored jobs.error_message, the resume) is
    // tests/serial/crm-import-error-sanitising.test.ts: it needs DDL on public.companies.
    const { safeJobError } = await import('@/lib/import/sales-sheet/job');
    const { classifyError } = await import('@/lib/jobs/retry');
    const secret = `SECRET-${RUN}`;
    const neon = Object.assign(new Error(`duplicate key: (email)=(${secret}@x.example)`), {
      name: 'NeonDbError',
      code: '40001',
      detail: `Key (email)=(${secret}@x.example) already exists.`,
    });
    const drizzle = Object.assign(
      new Error(`Failed query: insert into public.contacts ...\nparams: ${secret},+91 99999`),
      { name: 'DrizzleQueryError', cause: neon },
    );
    const safe = safeJobError(drizzle, 'job-1') as Error & { code?: string };
    expect(safe.message).toBe('[jobs] crm_import job job-1: commit failed (SQLSTATE 40001)');
    expect(JSON.stringify({ ...safe, message: safe.message, stack: '' })).not.toContain(secret);
    expect(safe.name).toBe('NeonDbError');
    expect(classifyError(safe).retryable).toBe(classifyError(drizzle).retryable);
    // The handler's own value-free messages survive as the cause.
    expect(safeJobError(new Error('INTERNAL: import row outcome not recorded'), 'j').message).toBe(
      '[jobs] crm_import job j: commit failed (INTERNAL: import row outcome not recorded)',
    );
    // Anything else is reduced to the fixed text.
    expect(safeJobError(new Error(`boom ${secret}`), 'j').message).toBe(
      '[jobs] crm_import job j: commit failed',
    );
  });

  it('keeps imported values out of preview row errors (0081 F-2)', async () => {
    const secret = `SECRET-${RUN}`;
    const v = await svc.createImportPreview(authOf(orgA, importer), {
      fileName: 'leak.csv',
      bytes: enc(
        'Company,Contact First Name,Contact Last Name,Contact Email,Expected Close,Deal Title,Owner Email\n' +
          `Leak Co,Ann,Ray,not-an-email-${secret},31/12/${secret},Deal,owner.one@pravshi.example\n` +
          `Leak Co,Ann,Ray,,,Deal,${secret.toLowerCase()}@nowhere.example\n`,
      ),
    });
    expect(v.invalidRows).toHaveLength(2);
    expect(JSON.stringify(v.invalidRows)).not.toMatch(new RegExp(secret, 'i'));
  });

  it('keeps a declined possible duplicate declined for every row of its key (0081 B3)', async () => {
    const before = await owner.query<{ n: number }>(
      `select count(*)::int n from public.companies where org_id = $1 and lower(name) = 'name only ltd'`,
      [orgA],
    );
    const csv =
      'Company,Owner Email\nName Only Ltd,owner.one@pravshi.example\nName Only Ltd,owner.one@pravshi.example\n';
    const declined = await queue(importer, 'dup-declined.csv', csv);
    expect(declined.view.possibleDuplicateRows).toEqual([2, 3]);
    await commit.runImportCommit(ctxOf(orgA, importer), declined.id, randomUUID());
    expect((await svc.getImport(authOf(orgA, importer), declined.id)).result).toEqual({
      created: 0,
      linked: 0,
      skipped: 2,
      failed: 0,
    });
    // Including the later row only: it creates one company; the declined row stays skipped.
    const chosen = await queue(
      importer,
      'dup-chosen.csv',
      `${csv}Name Only Ltd,owner.one@pravshi.example\n`,
      [3],
    );
    await commit.runImportCommit(ctxOf(orgA, importer), chosen.id, randomUUID());
    const rows = await owner.query<{ row_number: number; status: string }>(
      `select row_number, status from public.crm_import_rows where import_id = $1 order by 1`,
      [chosen.id],
    );
    expect(rows.rows.map((r) => r.status)).toEqual(['SKIPPED', 'CREATED', 'SKIPPED']);
    const after = await owner.query<{ n: number }>(
      `select count(*)::int n from public.companies where org_id = $1 and lower(name) = 'name only ltd'`,
      [orgA],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n + 1);
  });

  it('lets only one of two concurrent confirmations of the same file through (0081 S3, AC-I3)', async () => {
    const auth = authOf(orgA, importer);
    const csv = enc(`Company,Owner Email\nConcurrent ${RUN},owner.one@pravshi.example\n`);
    const [a, b] = await Promise.all([
      svc.createImportPreview(auth, { fileName: 'c1.csv', bytes: csv }),
      svc.createImportPreview(auth, { fileName: 'c2.csv', bytes: csv }),
    ]);
    const settled = await Promise.allSettled(
      [a, b].map((v) =>
        svc.confirmImport(auth, v.id, { fileSha256: v.fileSha256, counts: countsOf(v) }),
      ),
    );
    const codes = settled.map((s) =>
      s.status === 'fulfilled' ? s.value.status : (s.reason as { code?: string }).code,
    );
    expect(codes.sort()).toEqual(['ALREADY_IMPORTED', 'QUEUED']);
    // The same import confirmed twice at once: one job.
    const c = await svc.createImportPreview(auth, {
      fileName: 'c3.csv',
      bytes: enc(`Company,Owner Email\nTwice ${RUN},owner.one@pravshi.example\n`),
    });
    const body = { fileSha256: c.fileSha256, counts: countsOf(c) };
    const both = await Promise.all([
      svc.confirmImport(auth, c.id, body),
      svc.confirmImport(auth, c.id, body),
    ]);
    expect(both.map((v) => v.status)).toEqual(['QUEUED', 'QUEUED']);
    const jobs = await owner.query<{ n: number }>(
      `select count(*)::int n from public.jobs where org_id = $1 and dedup_key = $2`,
      [orgA, `crm_import:${c.id}`],
    );
    expect(jobs.rows[0]!.n).toBe(1);
  });

  it('resumes an interrupted commit from the rows not yet decided, each once (AC-I2)', async () => {
    const lines = Array.from(
      { length: 150 },
      (_, i) => `Resume ${RUN} ${i},resume-${RUN}-${i}.example,owner.one@pravshi.example`,
    );
    const q = await queue(
      importer,
      'resume.csv',
      `Company,Company Domain,Owner Email\n${lines.join('\n')}\n`,
    );
    let checks = 0;
    const afterOneBatch = {
      get aborted() {
        return ++checks > 1;
      },
    } as AbortSignal;
    await expect(
      commit.runImportCommit(ctxOf(orgA, importer), q.id, randomUUID(), afterOneBatch),
    ).rejects.toThrow(/interrupted/);
    const mid = await owner.query<{ pending: number; decided: number }>(
      `select count(*) filter (where status = 'PENDING')::int pending,
              count(*) filter (where status <> 'PENDING')::int decided
       from public.crm_import_rows where import_id = $1`,
      [q.id],
    );
    expect(mid.rows[0]).toEqual({ pending: 50, decided: 100 });
    await commit.runImportCommit(ctxOf(orgA, importer), q.id, randomUUID());
    expect((await svc.getImport(authOf(orgA, importer), q.id)).result.created).toBe(150);
    const companies = await owner.query<{ n: number }>(
      `select count(*)::int n from public.companies where org_id = $1 and domain like $2`,
      [orgA, `resume-${RUN}-%`],
    );
    expect(companies.rows[0]!.n).toBe(150);
    // 150 rows, each with several statements and a savepoint, twice: well within seconds alone,
    // but this runs beside the whole suite — hence the explicit limit.
  }, 120_000);

  it('records a failure when the importer loses crm.import, and ends a finished job quietly (0081 S1, S2)', async () => {
    const { handleCrmImport } = await import('@/lib/import/sales-sheet/job');
    const loser = await mkPerson(owner, orgA, 'Loser');
    const role = await mkCustomRole(
      owner,
      orgA,
      `IMPL_${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`,
      IMPORTER_GRANTS,
    );
    await assignRoleId(owner, loser, orgA, role);
    const q = await queue(
      loser,
      'lost.csv',
      `Company,Owner Email\nLost ${RUN},owner.one@pravshi.example\n`,
    );
    await owner.query(`delete from public.person_roles where person_id = $1 and role_id = $2`, [
      loser,
      role,
    ]);
    await claim(q.jobId, 'w-lost');
    await handleCrmImport(jobCtxFor(q.jobId, q.id, 'w-lost')); // ends: nothing it can do
    expect(await statusOf(q.id)).toMatchObject({
      status: 'FAILED',
      failure_reason: 'IMPORTER_NOT_PERMITTED',
    });
    const audit = await owner.query<{ reason: string }>(
      `select metadata ->> 'reason' as reason from public.audit_logs
       where org_id = $1 and action = 'crm.import.failed' and entity_id = $2`,
      [orgA, q.id],
    );
    expect(audit.rows).toEqual([{ reason: 'IMPORTER_NOT_PERMITTED' }]);
    // A redelivered job of a finished import ends without error.
    await handleCrmImport(jobCtxFor(q.jobId, q.id, 'w-lost'));
    // The failure recorder works only for the job this worker holds.
    expect(
      await stateOf(
        worker.query(
          `select public.crm_import_record_job_failure($1::uuid, 'someone-else', 'COMMIT_ERROR')`,
          [q.jobId],
        ),
      ),
    ).toBe('42501');
    expect(
      await stateOf(
        worker.query(
          `select public.crm_import_record_job_failure($1::uuid, 'w-lost', 'free text')`,
          [q.jobId],
        ),
      ),
    ).toBe('22023');
  });

  // ── Second review round: scope, frozen columns, cancellation, the importer, counts ──

  it('shows a holder of crm.import below GLOBAL only their own imports (0081 M-1)', async () => {
    const narrow = await mkPerson(owner, orgA, 'NarrowImporter');
    const role = await mkCustomRole(
      owner,
      orgA,
      `IMPS2_${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`,
      [['crm.import', 'SELF'], ...IMPORTER_GRANTS.filter(([k]) => k !== 'crm.import')],
    );
    await assignRoleId(owner, narrow, orgA, role);
    const own = await svc.createImportPreview(authOf(orgA, narrow), {
      fileName: 'mine.csv',
      bytes: enc(`Company,Owner Email\nMine ${RUN},owner.one@pravshi.example\n`),
    });
    expect((await svc.getImport(authOf(orgA, narrow), own.id)).id).toBe(own.id);
    // Another importer's import, its rows and its failed-row values are invisible.
    await expect(svc.getImport(authOf(orgA, narrow), first.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(svc.failedRowsFor(authOf(orgA, narrow), first.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const rows = await asUser<{ n: number }>(
      orgA,
      narrow,
      `select count(*)::int n from public.crm_import_rows where import_id = $1`,
      [first.id],
    );
    expect(rows.rows[0]!.n).toBe(0);
    // A GLOBAL holder still sees the narrow holder's import.
    expect((await svc.getImport(authOf(orgA, colleague), own.id)).id).toBe(own.id);
  });

  it('keeps job_id and the lifecycle columns to their transitions (0081 L-1)', async () => {
    const v = await svc.createImportPreview(authOf(orgA, importer), {
      fileName: 'frozen.csv',
      bytes: enc(`Company,Owner Email\nFrozen ${RUN},owner.one@pravshi.example\n`),
    });
    const ownJob = (
      await owner.query<{ id: string }>(
        `insert into public.jobs (org_id, type, payload) values ($1, 'cleanup', '{"target":"x"}') returning id`,
        [orgA],
      )
    ).rows[0]!.id;
    expect(
      await stateOf(
        asUser(orgA, importer, `update public.crm_imports set job_id = $2 where id = $1`, [
          v.id,
          ownJob,
        ]),
      ),
    ).toBe('23514');
    expect(
      await stateOf(
        asUser(
          orgA,
          importer,
          `update public.crm_imports set failure_reason = 'X_Y' where id = $1`,
          [v.id],
        ),
      ),
    ).toBe('23514');
    // A caller's timestamps are ignored, not stored.
    const written = await asUser<{ confirmed_at: string | null }>(
      orgA,
      importer,
      `update public.crm_imports set confirmed_at = now() - interval '1 year' where id = $1
       returning confirmed_at`,
      [v.id],
    );
    expect(written.rows[0]!.confirmed_at).toBeNull();
  });

  it('refuses cancelling a crm_import job directly, in the database and the jobs service (0081 L-2)', async () => {
    const q = await queue(
      importer,
      'nocancel.csv',
      `Company,Owner Email\nNo Cancel ${RUN},owner.one@pravshi.example\n`,
    );
    const ops = await mkPerson(owner, orgA, 'Ops');
    const role = await mkCustomRole(
      owner,
      orgA,
      `IMPO_${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`,
      [
        ['jobs.view', 'GLOBAL'],
        ['jobs.cancel', 'GLOBAL'],
      ],
    );
    await assignRoleId(owner, ops, orgA, role);
    expect(
      await stateOf(
        asUser(orgA, ops, `update public.jobs set status = 'cancelled' where id = $1`, [q.jobId]),
      ),
    ).toBe('42501');
    const { cancelJob } = await import('@/lib/jobs/queue');
    await expect(cancelJob(authOf(orgA, ops), q.jobId)).rejects.toThrow(
      /cancelled through its import/,
    );
    expect(
      (await owner.query(`select status from public.jobs where id = $1`, [q.jobId])).rows[0],
    ).toEqual({ status: 'pending' });
    // The import itself is cancelled by its importer, through its own path.
    expect((await svc.cancelImport(authOf(orgA, importer), q.id)).status).toBe('CANCELLED');
  });

  it('answers another crm.import holder’s confirm or cancel with NOT_IMPORTER (0081 L-3)', async () => {
    const v = await svc.createImportPreview(authOf(orgA, importer), {
      fileName: 'mine-only.csv',
      bytes: enc(`Company,Owner Email\nMine Only ${RUN},owner.one@pravshi.example\n`),
    });
    const body = { fileSha256: v.fileSha256, counts: countsOf(v) };
    await expect(svc.confirmImport(authOf(orgA, colleague), v.id, body)).rejects.toMatchObject({
      code: 'NOT_IMPORTER',
    });
    await expect(svc.cancelImport(authOf(orgA, colleague), v.id)).rejects.toMatchObject({
      code: 'NOT_IMPORTER',
    });
    expect((await svc.getImport(authOf(orgA, importer), v.id)).status).toBe('PREVIEWED');
  });

  it('records what a failed import committed, and fails a dead-lettered one (0081 S-3)', async () => {
    const lines = Array.from(
      { length: 120 },
      (_, i) => `Dead ${RUN} ${i},dead-${RUN}-${i}.example,owner.one@pravshi.example`,
    );
    const q = await queue(
      importer,
      'dead.csv',
      `Company,Company Domain,Owner Email\n${lines.join('\n')}\n`,
    );
    let checks = 0;
    const afterOneBatch = {
      get aborted() {
        return ++checks > 1;
      },
    } as AbortSignal;
    await expect(
      commit.runImportCommit(ctxOf(orgA, importer), q.id, randomUUID(), afterOneBatch),
    ).rejects.toThrow(/interrupted/);
    // Retries exhausted: the worker dead-letters the job; the next maintenance pass fails it.
    await owner.query(`update public.jobs set status = 'dead_letter' where id = $1`, [q.jobId]);
    await worker.query(`select public.crm_import_fail_abandoned(10000)`);
    const failed = await owner.query(
      `select status, failure_reason, created_count, linked_count, skipped_count, failed_count
       from public.crm_imports where id = $1`,
      [q.id],
    );
    expect(failed.rows[0]).toEqual({
      status: 'FAILED',
      failure_reason: 'JOB_ENDED',
      created_count: 100,
      linked_count: 0,
      skipped_count: 0,
      failed_count: 0,
    });
  });

  it('refuses to include a possible duplicate that would fail if included (0081 S-1)', async () => {
    const existing = await owner.query<{ id: string }>(
      `select id from public.companies where org_id = $1 and name = 'Name Only Ltd' and domain is null
       order by created_at limit 1`,
      [orgA],
    );
    await owner.query(
      `insert into public.contacts (org_id, owner_person_id, company_id, first_name, last_name, email)
       values ($1, $2, $3, 'Bob', 'Lee', $4)`,
      [orgA, importer, existing.rows[0]!.id, `bob.${RUN}@x.example`],
    );
    const v = await svc.createImportPreview(authOf(orgA, importer), {
      fileName: 'not-includable.csv',
      bytes: enc(
        'Company,Contact First Name,Contact Last Name,Contact Email,Owner Email\n' +
          `Name Only Ltd,Bob,Lee,bob.${RUN}@x.example,owner.one@pravshi.example\n`,
      ),
    });
    expect(v.preview.notIncludableRows).toEqual([2]);
    await expect(
      svc.confirmImport(authOf(orgA, importer), v.id, {
        fileSha256: v.fileSha256,
        counts: countsOf(v),
        includeRows: [2],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INCLUDE' });
  });

  it('does not let jobs.retry reset a running crm_import job (0081 R-1)', async () => {
    const q = await queue(
      importer,
      'noretry.csv',
      `Company,Owner Email\nNo Retry ${RUN},owner.one@pravshi.example\n`,
    );
    await claim(q.jobId, 'w-noretry');
    const ops = await mkPerson(owner, orgA, 'RetryOps');
    const role = await mkCustomRole(
      owner,
      orgA,
      `IMPR2_${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`,
      [
        ['jobs.view', 'GLOBAL'],
        ['jobs.retry', 'GLOBAL'],
      ],
    );
    await assignRoleId(owner, ops, orgA, role);
    const { retryJob } = await import('@/lib/jobs/queue');
    await expect(retryJob(authOf(orgA, ops), q.jobId)).rejects.toThrow(/cannot be retried/);
    expect(
      (await owner.query(`select status, claimed_by from public.jobs where id = $1`, [q.jobId]))
        .rows[0],
    ).toEqual({ status: 'running', claimed_by: 'w-noretry' });
  });

  // ── The commit's set-based fast path against the row-by-row path ─────────────────────────

  /**
   * Imports one generated file as `importer` — careful (row by row) or not — and returns what it
   * decided in a form free of ids: each record named by the first row that referenced it. The
   * file: two linking rows (existing company and contact; a declined possible duplicate), then
   * `rows` rows — companies shared by key in threes, a contact repeated, rows without contact or
   * deal, WON and QUALIFIED stages, owners alternating between the importer and another person
   * (or always the importer) — and, when asked, one row the commit refuses (its contact is created
   * under another company after the preview).
   */
  const diffRun = async (
    tag: string,
    careful: boolean,
    opts: { importer: string; email: string; rows: number; onlyMe?: boolean; refuse?: boolean },
  ) => {
    const { importer: me } = opts;
    const existing = (
      await owner.query<{ id: string }>(
        `insert into public.companies (org_id, owner_person_id, name, domain)
         values ($1, $2, $3, $4) returning id`,
        [orgA, colleague, `Diff Existing ${tag}`, `existing-${tag}.example`],
      )
    ).rows[0]!.id;
    const contactAt = (email: string) =>
      owner.query(
        `insert into public.contacts (org_id, owner_person_id, company_id, first_name, last_name, email)
         values ($1, $2, $3, 'Known', 'Person', $4)`,
        [orgA, colleague, existing, email],
      );
    await contactAt(`known@existing-${tag}.example`);
    const lines = [
      `Diff Existing ${tag},existing-${tag}.example,Known,Person,known@existing-${tag}.example,,,,${opts.email}`,
      `Name Only Ltd,,,,,,,,${opts.email}`,
    ];
    if (opts.refuse) {
      lines.push(
        `Diff ${tag} Refused,refused-${tag}.example,Tak,En,taken@existing-${tag}.example,,,,${opts.email}`,
      );
    }
    for (let i = 0; i < opts.rows; i++) {
      const g = Math.floor(i / 3);
      const email = `p${i % 3 === 1 ? i - 1 : i}@co${g}-${tag}.example`;
      const contact = i % 10 === 0 ? ',,' : `Ann,Row${i},${email}`;
      const deal =
        i % 4 === 0 ? ',,' : `Deal ${tag} ${i},${1000 + i},${i % 3 ? 'QUALIFIED' : 'WON'}`;
      const ownerEmail = i % 2 || opts.onlyMe ? opts.email : 'owner.one@pravshi.example';
      lines.push(`Diff ${tag} Co ${g},co${g}-${tag}.example,${contact},${deal},${ownerEmail}`);
    }
    const csv =
      'Company,Company Domain,Contact First Name,Contact Last Name,Contact Email,Deal Title,Deal Value,Stage,Owner Email\n' +
      lines.join('\n') +
      '\n';
    const q = await queue(me, `diff-${tag}.csv`, csv);
    // After the preview, as a concurrent change: the commit, not the preview, refuses the row.
    if (opts.refuse) await contactAt(`taken@existing-${tag}.example`);
    const paths: string[] = [];
    await commit.runImportCommit(ctxOf(orgA, me), q.id, randomUUID(), undefined, {
      careful,
      onBatch: (path) => paths.push(path),
    });
    const rows = await owner.query<{
      row_number: number;
      status: string;
      errors: unknown;
      company_id: string | null;
      contact_id: string | null;
      deal_id: string | null;
      company_owner: string | null;
      contact_owner: string | null;
      deal_owner: string | null;
      contact_company: string | null;
      deal_closed: boolean | null;
      created_by: string | null;
      history: number;
    }>(
      `select r.row_number, r.status, r.errors, r.company_id, r.contact_id, r.deal_id,
              co.owner_person_id company_owner, ct.owner_person_id contact_owner,
              d.owner_person_id deal_owner, ct.company_id contact_company,
              d.closed_at is not null deal_closed, co.created_by,
              (select count(*)::int from public.deal_stage_history h where h.deal_id = r.deal_id) history
       from public.crm_import_rows r
       left join public.companies co on co.id = r.company_id
       left join public.contacts ct on ct.id = r.contact_id
       left join public.deals d on d.id = r.deal_id
       where r.import_id = $1 order by r.row_number`,
      [q.id],
    );
    const names = new Map<string, string>([[existing, 'existing']]);
    const name = (id: string | null, row: number) => {
      if (id === null) return null;
      if (!names.has(id)) names.set(id, `row${row}`);
      return names.get(id)!;
    };
    const person = (id: string | null) =>
      id === null ? null : id === me ? 'me' : id === ownerOne ? 'one' : id;
    const shape = rows.rows.map((r) => ({
      row: r.row_number,
      status: r.status,
      errors: r.errors,
      company: name(r.company_id, r.row_number),
      contact: name(r.contact_id, r.row_number),
      deal: name(r.deal_id, r.row_number),
      owners: [person(r.company_owner), person(r.contact_owner), person(r.deal_owner)],
      contactCompany: name(r.contact_company, r.row_number),
      closed: r.deal_closed,
      history: r.history,
      createdBy: person(r.created_by),
    }));
    const ids = rows.rows.flatMap((r) => [r.company_id, r.contact_id, r.deal_id]);
    const audit = await owner.query<{ entity_type: string; action: string; n: number }>(
      `select entity_type, action, count(*)::int n from public.audit_logs
       where org_id = $1 and entity_id = any($2::uuid[]) group by 1, 2 order by 1, 2`,
      [orgA, [...new Set(ids.filter((x) => x !== null))]],
    );
    const done = await svc.getImport(authOf(orgA, me), q.id);
    return { shape, audit: audit.rows, result: done.result, status: done.status, paths };
  };
  const sameDecisions = (
    fast: Awaited<ReturnType<typeof diffRun>>,
    careful: Awaited<ReturnType<typeof diffRun>>,
  ) =>
    expect(fast).toMatchObject({
      shape: careful.shape,
      audit: careful.audit,
      result: careful.result,
      status: careful.status,
    });

  it('decides a batch set-based exactly as row by row (commit fast path)', async () => {
    const email = `colleague.${RUN}@pravshi.example`;
    await setWorkEmail(colleague, email);
    const opts = { importer: colleague, email, rows: 148 };
    const careful = await diffRun(`c${RUN}`, true, opts);
    const fast = await diffRun(`f${RUN}`, false, opts);
    expect(careful.paths).toEqual(['CAREFUL', 'CAREFUL']);
    expect(fast.paths).toEqual(['FAST', 'FAST']);
    expect(careful.status).toBe('COMPLETED');
    expect(careful.result).toMatchObject({ created: 133, linked: 16, skipped: 1, failed: 0 });
    expect(careful.shape[0]).toMatchObject({
      row: 2,
      status: 'LINKED',
      company: 'existing',
      owners: ['me', 'me', null],
    });
    expect(careful.audit.length).toBeGreaterThan(0);
    expect(careful.shape.some((r) => r.history > 0)).toBe(true);
    sameDecisions(fast, careful);
  });

  it('decides a batch row by row when one of its rows is refused, with the same results (commit fast path)', async () => {
    const email = `colleague.${RUN}@pravshi.example`;
    await setWorkEmail(colleague, email);
    const opts = { importer: colleague, email, rows: 20, refuse: true };
    const careful = await diffRun(`cr${RUN}`, true, opts);
    const fast = await diffRun(`fr${RUN}`, false, opts);
    expect(careful.result.failed).toBe(1);
    expect(careful.shape[2]).toMatchObject({ row: 4, status: 'FAILED' });
    expect(fast.paths).toEqual(['CAREFUL']); // the attempt was declined and rolled back whole
    sameDecisions(fast, careful);
  });

  it('refuses a record the importer may create but not see, as row by row does (commit fast path)', async () => {
    // Owned by the importer itself, nothing is handed over: only RETURNING reads the deal back.
    const blind = await mkPerson(owner, orgA, 'NoDealView');
    const email = `nodealview.${RUN}@pravshi.example`;
    await setWorkEmail(blind, email);
    const role = await mkCustomRole(
      owner,
      orgA,
      `IMPV_${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`,
      IMPORTER_GRANTS.filter(([k]) => k !== 'deals.view'),
    );
    await assignRoleId(owner, blind, orgA, role);
    const opts = { importer: blind, email, rows: 8, onlyMe: true };
    const careful = await diffRun(`cv${RUN}`, true, opts);
    const fast = await diffRun(`fv${RUN}`, false, opts);
    expect(careful.result.failed).toBeGreaterThan(0);
    expect(careful.shape.every((r) => r.deal === null)).toBe(true);
    expect(fast.paths).toEqual(['CAREFUL']);
    sameDecisions(fast, careful);
  });
});
