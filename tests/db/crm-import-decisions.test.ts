import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { DB_READY, RUN, mkOrg, mkPerson } from '../workflows/helpers';
import { assignRoleId, mkCustomRole } from '../authz/fixtures';

/**
 * Sales Sheet duplicate resolution against a live database (0088): decisions per company,
 * contact and deal key, the preview recomputed after each, the confirmed plan recorded once and
 * applied by the commit — on the per-row and the batch path, when the organization changes
 * between upload and confirmation, and when it changes between confirmation and commit.
 * Representative fixtures only (the real sheet's mapping is pending).
 */
const GRANTS: [string, string][] = [
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

async function stateOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'NO ERROR';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
      const c = (e as { code?: unknown }).code;
      if (typeof c === 'string') return c;
    }
    return String(error);
  }
}

type Svc = typeof import('@/lib/import/sales-sheet/service');
type Commit = typeof import('@/lib/import/sales-sheet/commit');

describe.skipIf(!DB_READY)('Sales Sheet duplicate decisions (0088, live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  const app = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
  owner.on('error', () => undefined);
  app.on('error', () => undefined);
  let svc: Svc;
  let commit: Commit;
  let org = '';
  let other = '';
  let importer = '';
  let colleague = '';
  let outsider = '';
  const tag = `${RUN}${Math.random().toString(36).slice(2, 6)}`;
  const OWNER = `dup.owner.${tag}@pravshi.example`;
  const enc = (s: string) => new TextEncoder().encode(s);
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
  const ctxOf = (personId: string) => ({ personId, orgId: org, aal: 'aal1' as const });
  const name = (s: string) => `${s} ${tag}`;
  const key = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

  /** An existing company (no domain), optionally with contacts and deals, owned by the importer. */
  const existing = async (
    company: string,
    contacts: [string, string][] = [],
    deals: string[] = [],
  ) => {
    const c = await owner.query<{ id: string }>(
      `insert into public.companies (org_id, owner_person_id, name, country_code)
       values ($1, $2, $3, 'IN') returning id`,
      [org, importer, company],
    );
    const companyId = c.rows[0]!.id;
    const contactIds: string[] = [];
    for (const [first, last] of contacts) {
      const k = await owner.query<{ id: string }>(
        `insert into public.contacts (org_id, owner_person_id, company_id, first_name, last_name)
         values ($1, $2, $3, $4, $5) returning id`,
        [org, importer, companyId, first, last],
      );
      contactIds.push(k.rows[0]!.id);
    }
    for (const title of deals) {
      const pipe = await owner.query<{ pid: string; sid: string }>(
        `select p.id pid, s.id sid from public.pipelines p join public.pipeline_stages s on s.pipeline_id = p.id
         where p.org_id = $1 order by p.created_at, s.position limit 1`,
        [org],
      );
      await owner.query(
        `insert into public.deals (org_id, owner_person_id, title, company_id, contact_id, currency,
                                   stage, pipeline_id, pipeline_stage_id)
         values ($1, $2, $3, $4, $5, 'INR', 'NEW', $6, $7)`,
        [
          org,
          importer,
          title,
          companyId,
          contactIds[0] ?? null,
          pipe.rows[0]!.pid,
          pipe.rows[0]!.sid,
        ],
      );
    }
    return { companyId, contactIds };
  };

  const upload = async (csv: string, file = 'dups.csv') =>
    svc.createImportPreview(authOf(org, importer), { fileName: file, bytes: enc(csv) });
  const decide = (
    id: string,
    kind: 'COMPANY' | 'CONTACT' | 'DEAL',
    k: string,
    decision: 'LINK_EXISTING' | 'CREATE_NEW' | 'SKIP' | null,
    who = importer,
  ) => svc.setDecision(authOf(org, who), id, { kind, key: k, decision });
  const confirmWith = async (id: string, sha: string) => {
    const p = await svc.getDecisionPreview(authOf(org, importer), id);
    await svc.confirmImport(authOf(org, importer), id, {
      fileSha256: sha,
      counts: p.counts,
      includeRows: [],
    });
    return p;
  };
  const rowsOf = async (id: string) =>
    (
      await owner.query<{
        row_number: number;
        status: string;
        company_id: string | null;
        contact_id: string | null;
      }>(
        `select row_number, status, company_id, contact_id from public.crm_import_rows
         where import_id = $1 order by row_number`,
        [id],
      )
    ).rows;
  const companiesNamed = async (n: string) =>
    (
      await owner.query<{ n: number }>(
        `select count(*)::int n from public.companies where org_id = $1 and lower(name) = lower($2)
           and deleted_at is null`,
        [org, n],
      )
    ).rows[0]!.n;

  beforeAll(async () => {
    svc = await import('@/lib/import/sales-sheet/service');
    commit = await import('@/lib/import/sales-sheet/commit');
    org = await mkOrg(owner, `dup-${tag}`);
    other = await mkOrg(owner, `dup-b-${tag}`);
    importer = await mkPerson(owner, org, 'DupImporter');
    colleague = await mkPerson(owner, org, 'DupColleague');
    outsider = await mkPerson(owner, other, 'DupOutsider');
    await owner.query(`update public.people set work_email = $2 where id = $1`, [importer, OWNER]);
    const t = tag.toUpperCase().replace(/[^A-Z0-9]/g, 'X');
    const role = await mkCustomRole(owner, org, `DUP_${t}`, GRANTS);
    await assignRoleId(owner, importer, org, role);
    await assignRoleId(owner, colleague, org, role);
    const roleB = await mkCustomRole(owner, other, `DUPB_${t}`, GRANTS);
    await assignRoleId(owner, outsider, other, roleB);
  }, 180_000);

  afterAll(async () => {
    await owner.end();
    await app.end();
  });

  const HEADER = 'Company,Contact First Name,Contact Last Name,Deal Title,Owner Email\n';

  it('use the existing company, contact and deal decisions: links, never duplicates', async () => {
    const company = name('Shared Ltd');
    const ex = await existing(company, [['Asha', 'Rao']], ['Renewal']);
    const v = await upload(
      HEADER + `${company},Asha,Rao,Renewal,${OWNER}\n` + `${company},Ben,Roy,Upsell,${OWNER}\n`,
    );
    const ck = `name:${key(company)}`;
    let p = await svc.getDecisionPreview(authOf(org, importer), v.id);
    expect(p.unresolved.companies).toEqual([ck]);
    // Each decision answers the recomputed preview: the company decided, Asha and her deal surface.
    p = await decide(v.id, 'COMPANY', ck, 'LINK_EXISTING');
    const ak = `name:asha rao|${ck}`;
    const dk = `renewal|${ck}|${ak}`;
    expect(p.unresolved).toEqual({ companies: [], contacts: [ak], deals: [dk] });
    p = await decide(v.id, 'CONTACT', ak, 'LINK_EXISTING');
    expect(p.unresolved).toEqual({ companies: [], contacts: [], deals: [dk] });
    // A decision can be cleared (undecided again) and made again before confirmation.
    p = await decide(v.id, 'CONTACT', ak, null);
    expect(p.unresolved).toEqual({ companies: [], contacts: [ak], deals: [dk] });
    p = await decide(v.id, 'CONTACT', ak, 'LINK_EXISTING');
    p = await decide(v.id, 'DEAL', dk, 'CREATE_NEW');
    expect(p.unresolved).toEqual({ companies: [], contacts: [], deals: [] });
    await confirmWith(v.id, v.fileSha256);
    await commit.runImportCommit(ctxOf(importer), v.id, randomUUID());
    const rows = await rowsOf(v.id);
    expect(rows.map((r) => r.status)).toEqual(['CREATED', 'CREATED']);
    expect(rows.map((r) => r.company_id)).toEqual([ex.companyId, ex.companyId]);
    expect(rows[0]!.contact_id).toBe(ex.contactIds[0]);
    expect(await companiesNamed(company)).toBe(1);
  });

  it('create a new company: created once, its contacts new, the existing one untouched', async () => {
    const company = name('Twin Name Co');
    const ex = await existing(company, [['Asha', 'Rao']]);
    const v = await upload(
      HEADER + `${company},Asha,Rao,Deal A,${OWNER}\n` + `${company},Ben,Roy,Deal B,${OWNER}\n`,
    );
    const p = await decide(v.id, 'COMPANY', `name:${key(company)}`, 'CREATE_NEW');
    // A company declared new has no existing contacts: Asha stops being a possible duplicate.
    expect(p.unresolved).toEqual({ companies: [], contacts: [], deals: [] });
    await confirmWith(v.id, v.fileSha256);
    await commit.runImportCommit(ctxOf(importer), v.id, randomUUID());
    const rows = await rowsOf(v.id);
    expect(rows.map((r) => r.status)).toEqual(['CREATED', 'CREATED']);
    expect(rows[0]!.company_id).not.toBe(ex.companyId);
    expect(rows[1]!.company_id).toBe(rows[0]!.company_id);
    expect(await companiesNamed(company)).toBe(2);
    expect(rows[0]!.contact_id).not.toBe(ex.contactIds[0]);
  });

  it('skip, and undecided: nothing is created for those rows', async () => {
    const skipCo = name('Skip Me Ltd');
    const openCo = name('Undecided Ltd');
    await existing(skipCo);
    await existing(openCo);
    const v = await upload(
      'Company,Owner Email\n' +
        `${skipCo},${OWNER}\n` +
        `${openCo},${OWNER}\n` +
        `${name('Brand New')},${OWNER}\n`,
    );
    const p = await decide(v.id, 'COMPANY', `name:${key(skipCo)}`, 'SKIP');
    expect(p.skippedRows).toEqual([2]);
    expect(p.unresolved.companies).toEqual([`name:${key(openCo)}`]);
    await confirmWith(v.id, v.fileSha256);
    await commit.runImportCommit(ctxOf(importer), v.id, randomUUID());
    expect((await rowsOf(v.id)).map((r) => r.status)).toEqual(['SKIPPED', 'SKIPPED', 'CREATED']);
    expect(await companiesNamed(skipCo)).toBe(1);
    expect(await companiesNamed(openCo)).toBe(1);
  });

  it('refuses "use the existing" when several companies share the name; links exactly the one confirmed', async () => {
    const twin = name('Ambiguous Ltd');
    await existing(twin);
    await existing(twin);
    const v = await upload('Company,Owner Email\n' + `${twin},${OWNER}\n`);
    const p = await decide(v.id, 'COMPANY', `name:${key(twin)}`, 'LINK_EXISTING');
    expect(p.invalidRows).toEqual([2]);

    // Confirmed against one match; a second appears before the commit runs: the plan names the
    // confirmed company by id, so the row links to exactly that one — no guess, no new company.
    const late = name('Late Twin Ltd');
    const chosen = await existing(late);
    const w = await upload('Company,Owner Email\n' + `${late},${OWNER}\n`, 'late.csv');
    await decide(w.id, 'COMPANY', `name:${key(late)}`, 'LINK_EXISTING');
    await confirmWith(w.id, w.fileSha256);
    await existing(late);
    await commit.runImportCommit(ctxOf(importer), w.id, randomUUID());
    expect(await rowsOf(w.id)).toMatchObject([{ status: 'LINKED', company_id: chosen.companyId }]);
    expect(await companiesNamed(late)).toBe(2);

    // The confirmed company is deleted before the commit runs: the row fails, nothing is created.
    const gone = name('Gone Ltd');
    const goneCo = await existing(gone);
    const x = await upload('Company,Owner Email\n' + `${gone},${OWNER}\n`, 'gone.csv');
    await decide(x.id, 'COMPANY', `name:${key(gone)}`, 'LINK_EXISTING');
    await confirmWith(x.id, x.fileSha256);
    await owner.query(`update public.companies set deleted_at = now() where id = $1`, [
      goneCo.companyId,
    ]);
    await commit.runImportCommit(ctxOf(importer), x.id, randomUUID());
    const rows = await owner.query<{ status: string; errors: { reason: string }[] }>(
      `select status, errors from public.crm_import_rows where import_id = $1`,
      [x.id],
    );
    expect(rows.rows[0]!.status).toBe('FAILED');
    expect(rows.rows[0]!.errors[0]!.reason).toBe(
      'the existing company you chose is no longer visible to you',
    );
    expect(await companiesNamed(gone)).toBe(0);
  });

  it('refuses "create a new company" for a row whose contact belongs to the existing one', async () => {
    const company = name('Owned Contact Ltd');
    const ex = await existing(company);
    await owner.query(
      `insert into public.contacts (org_id, owner_person_id, company_id, first_name, last_name, email)
       values ($1, $2, $3, 'Bob', 'Lee', $4)`,
      [org, importer, ex.companyId, `bob.${tag}@x.example`],
    );
    const v = await upload(
      'Company,Contact First Name,Contact Last Name,Contact Email,Owner Email\n' +
        `${company},Bob,Lee,bob.${tag}@x.example,${OWNER}\n`,
    );
    const p = await decide(v.id, 'COMPANY', `name:${key(company)}`, 'CREATE_NEW');
    expect(p.invalidRows).toEqual([2]);
  });

  it('authorization and validation: importer only, a real possible duplicate only, deals cannot link', async () => {
    const company = name('Guarded Ltd');
    await existing(company);
    const v = await upload('Company,Owner Email\n' + `${company},${OWNER}\n`);
    const ck = `name:${key(company)}`;
    await expect(decide(v.id, 'COMPANY', ck, 'SKIP', colleague)).rejects.toMatchObject({
      code: 'NOT_IMPORTER',
    });
    await expect(decide(v.id, 'COMPANY', 'name:not in this file', 'SKIP')).rejects.toMatchObject({
      code: 'INVALID_DECISION',
    });
    await expect(decide(v.id, 'DEAL', 'x|y|z', 'LINK_EXISTING')).rejects.toMatchObject({
      code: 'INVALID_DECISION',
    });
    await expect(
      svc.setDecision(authOf(other, outsider), v.id, {
        kind: 'COMPANY',
        key: ck,
        decision: 'SKIP',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Directly in the database, another organization's identity writes nothing.
    const c = await app.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.person_id', $1, true), set_config('app.org_id', $2, true),
                set_config('app.aal', 'aal2', true)`,
        [outsider, other],
      );
      const state = await stateOf(
        c.query(
          `insert into public.crm_import_decisions (org_id, import_id, kind, entity_key, decision, decided_by)
           values ($1, $2, 'COMPANY', $3, 'SKIP', $4)`,
          [org, v.id, ck, outsider],
        ),
      );
      expect(['42501', '23503']).toContain(state);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  });

  it('decisions freeze at confirmation; the plan is immutable; a repeated confirm is idempotent', async () => {
    const company = name('Frozen Ltd');
    await existing(company);
    const v = await upload('Company,Owner Email\n' + `${company},${OWNER}\n`);
    const ck = `name:${key(company)}`;
    await decide(v.id, 'COMPANY', ck, 'CREATE_NEW');
    const seen = await confirmWith(v.id, v.fileSha256);
    await expect(decide(v.id, 'COMPANY', ck, 'SKIP')).rejects.toMatchObject({
      code: 'NOT_PREVIEWED',
    });
    // The same confirmation again: no mismatch, no second job.
    const job = (
      await owner.query<{ job_id: string }>(`select job_id from public.crm_imports where id = $1`, [
        v.id,
      ])
    ).rows[0]!.job_id;
    await svc.confirmImport(authOf(org, importer), v.id, {
      fileSha256: v.fileSha256,
      counts: seen.counts,
      includeRows: [],
    });
    expect(
      (
        await owner.query<{ job_id: string }>(
          `select job_id from public.crm_imports where id = $1`,
          [v.id],
        )
      ).rows[0]!.job_id,
    ).toBe(job);
    // The guard refuses any decision or plan change after confirmation, even as the importer.
    const c = await app.connect();
    try {
      await c.query('begin');
      await c.query(
        `select set_config('app.person_id', $1, true), set_config('app.org_id', $2, true),
                set_config('app.aal', 'aal2', true)`,
        [importer, org],
      );
      expect(
        await stateOf(
          c.query(`update public.crm_import_decisions set decision = 'SKIP' where import_id = $1`, [
            v.id,
          ]),
        ),
      ).toBe('23514');
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
    const c2 = await app.connect();
    try {
      await c2.query('begin');
      await c2.query(
        `select set_config('app.person_id', $1, true), set_config('app.org_id', $2, true),
                set_config('app.aal', 'aal2', true)`,
        [importer, org],
      );
      expect(
        await stateOf(
          c2.query(`update public.crm_import_row_plans set skip = true where import_id = $1`, [
            v.id,
          ]),
        ),
      ).toBe('42501');
    } finally {
      await c2.query('rollback').catch(() => undefined);
      c2.release();
    }
    // Commit, then commit again (a retry): the second run changes nothing.
    await commit.runImportCommit(ctxOf(importer), v.id, randomUUID());
    const once = await rowsOf(v.id);
    await commit.runImportCommit(ctxOf(importer), v.id, randomUUID());
    expect(await rowsOf(v.id)).toEqual(once);
    expect(await companiesNamed(company)).toBe(2);
  });

  it('concurrent submissions: one decision per entity, and a decision never slips past a confirmation', async () => {
    const company = name('Raced Ltd');
    await existing(company);
    const v = await upload('Company,Owner Email\n' + `${company},${OWNER}\n`);
    const ck = `name:${key(company)}`;
    const both = await Promise.allSettled([
      decide(v.id, 'COMPANY', ck, 'CREATE_NEW'),
      decide(v.id, 'COMPANY', ck, 'SKIP'),
      decide(v.id, 'COMPANY', ck, 'LINK_EXISTING'),
    ]);
    // Serialised on the import row: each is a valid re-decision of the same company, applied
    // one after another — all succeed, the last one stands, one row per entity.
    expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    const stored = await owner.query<{ n: number }>(
      `select count(*)::int n from public.crm_import_decisions where import_id = $1`,
      [v.id],
    );
    expect(stored.rows[0]!.n).toBe(1);

    // A decision racing the confirmation: either it lands before (and the plan includes it) or
    // it is refused — never recorded after the plan.
    const before = await svc.getDecisionPreview(authOf(org, importer), v.id);
    const [conf, late] = await Promise.allSettled([
      svc.confirmImport(authOf(org, importer), v.id, {
        fileSha256: v.fileSha256,
        counts: before.counts,
        includeRows: [],
      }),
      decide(v.id, 'COMPANY', ck, null),
    ]);
    const status = (
      await owner.query<{ status: string }>(`select status from public.crm_imports where id = $1`, [
        v.id,
      ])
    ).rows[0]!.status;
    // The two serialise on the import row (confirm locks it; a decision takes a share lock).
    // Exactly one of them wins, and the loser is refused — never both, never neither.
    expect([conf.status, late.status].sort()).toEqual(['fulfilled', 'rejected']);
    const decisions = await owner.query<{ n: number }>(
      `select count(*)::int n from public.crm_import_decisions where import_id = $1`,
      [v.id],
    );
    const plans = await owner.query<{ n: number }>(
      `select count(*)::int n from public.crm_import_row_plans where import_id = $1`,
      [v.id],
    );
    if (conf.status === 'fulfilled') {
      // Confirmed first: the decision it confirmed is recorded and planned; the late clearing
      // was refused (the import is no longer PREVIEWED).
      expect(status).toBe('QUEUED');
      expect((late as PromiseRejectedResult).reason).toMatchObject({ code: 'NOT_PREVIEWED' });
      expect(decisions.rows[0]!.n).toBe(1);
      expect(plans.rows[0]!.n).toBe(1);
    } else {
      // The clearing landed first: the confirmation was sent counts that no longer match.
      expect(status).toBe('PREVIEWED');
      expect((conf as PromiseRejectedResult).reason).toMatchObject({ code: 'PREVIEW_MISMATCH' });
      expect(decisions.rows[0]!.n).toBe(0);
      expect(plans.rows[0]!.n).toBe(0);
    }
  });

  /** Runs the commit and records which path decided each batch. */
  const commitObserved = async (id: string, careful = false) => {
    const paths: string[] = [];
    await commit.runImportCommit(ctxOf(importer), id, randomUUID(), undefined, {
      careful,
      onBatch: (path) => paths.push(path),
    });
    return paths;
  };

  it('the batch path follows the confirmed plan: a row the organization made a duplicate after upload is skipped (DR-1)', async () => {
    const a = name('After Upload A');
    const b = name('After Upload B');
    // Clean at upload: neither company exists yet, so nothing is a possible duplicate.
    const v = await upload('Company,Owner Email\n' + `${a},${OWNER}\n` + `${b},${OWNER}\n`);
    // A colleague creates both before the import is confirmed.
    await existing(a);
    await existing(b);
    let p = await svc.getDecisionPreview(authOf(org, importer), v.id);
    expect(p.unresolved.companies.sort()).toEqual([`name:${key(a)}`, `name:${key(b)}`].sort());
    // B is decided (skip); A stays undecided — so the import is a decided one with a plan.
    p = await decide(v.id, 'COMPANY', `name:${key(b)}`, 'SKIP');
    await confirmWith(v.id, v.fileSha256);
    const paths = await commitObserved(v.id);
    expect(paths).toEqual(['FAST']);
    expect((await rowsOf(v.id)).map((r) => r.status)).toEqual(['SKIPPED', 'SKIPPED']);
    expect(await companiesNamed(a)).toBe(1);
    expect(await companiesNamed(b)).toBe(1);
  });

  it('a stale contact decision made moot by "create a new company" creates, never links the old contact (DR-2)', async () => {
    const company = name('Moot Ltd');
    const ex = await existing(company, [['Asha', 'Rao']]);
    const v = await upload(HEADER + `${company},Asha,Rao,,${OWNER}\n`);
    const ck = `name:${key(company)}`;
    const ak = `name:asha rao|${ck}`;
    // Undecided company: Asha may be its existing contact — decided "use the existing".
    await decide(v.id, 'CONTACT', ak, 'LINK_EXISTING');
    // Then the company is declared new: Asha is a new contact of the new company.
    let p = await decide(v.id, 'COMPANY', ck, 'CREATE_NEW');
    expect(p.unresolved).toEqual({ companies: [], contacts: [], deals: [] });
    expect(p.counts.contacts).toEqual({ create: 1, link: 0, possibleDuplicate: 0 });
    // The moot decision can always be cleared; it can no longer be made.
    p = await decide(v.id, 'CONTACT', ak, null);
    await expect(decide(v.id, 'CONTACT', ak, 'LINK_EXISTING')).rejects.toMatchObject({
      code: 'INVALID_DECISION',
    });
    // Recreate the stale decision (company undecided first), then confirm and commit.
    await decide(v.id, 'COMPANY', ck, null);
    await decide(v.id, 'CONTACT', ak, 'LINK_EXISTING');
    await decide(v.id, 'COMPANY', ck, 'CREATE_NEW');
    await confirmWith(v.id, v.fileSha256);
    await commitObserved(v.id, true);
    const [row] = await rowsOf(v.id);
    expect(row!.status).toBe('CREATED');
    expect(row!.company_id).not.toBe(ex.companyId);
    expect(row!.contact_id).not.toBe(ex.contactIds[0]);
    expect(await companiesNamed(company)).toBe(2);
  });

  it('later rows of a company marked new: its contact and deal are new, never the old company’s (DR-3)', async () => {
    const company = name('Marked New Ltd');
    const ex = await existing(company, [['Asha', 'Rao']], ['Renewal']);
    const v = await upload(
      HEADER + `${company},Cy,Lee,,${OWNER}\n` + `${company},Asha,Rao,Renewal,${OWNER}\n`,
    );
    const p = await decide(v.id, 'COMPANY', `name:${key(company)}`, 'CREATE_NEW');
    expect(p.unresolved).toEqual({ companies: [], contacts: [], deals: [] });
    expect(p.invalidRows).toEqual([]);
    await confirmWith(v.id, v.fileSha256);
    await commitObserved(v.id);
    const rows = await rowsOf(v.id);
    expect(rows.map((r) => r.status)).toEqual(['CREATED', 'CREATED']);
    expect(rows[1]!.company_id).toBe(rows[0]!.company_id);
    expect(rows[0]!.company_id).not.toBe(ex.companyId);
    expect(rows[1]!.contact_id).not.toBe(ex.contactIds[0]);
    expect(await companiesNamed(company)).toBe(2);
  });

  it('rows the upload found invalid stay invalid in the recomputed preview (DR-4)', async () => {
    const lateOwner = `dup.late.${tag}@pravshi.example`;
    const company = name('Recount Ltd');
    await existing(company);
    const v = await upload(
      'Company,Owner Email\n' + `${company},${OWNER}\n` + `${name('Fresh Recount')},${lateOwner}\n`,
    );
    expect(v.invalidRows.map((r) => r.rowNumber)).toEqual([3]);
    // The owner becomes an active person after upload: the row is still not committed, so it
    // must not count as valid.
    const late = await mkPerson(owner, org, 'DupLateOwner');
    await owner.query(`update public.people set work_email = $2 where id = $1`, [late, lateOwner]);
    const p = await decide(v.id, 'COMPANY', `name:${key(company)}`, 'CREATE_NEW');
    expect(p.invalidRows).toEqual([3]);
    expect(p.counts.validRows).toBe(1);
    expect(p.counts.companies).toEqual({ create: 1, link: 0, possibleDuplicate: 0 });
  });

  it('decisions and plans: tenant isolation, importer-only writes, read by a GLOBAL holder, no per-row includes (DR-9)', async () => {
    const company = name('Isolated Ltd');
    await existing(company);
    const v = await upload('Company,Owner Email\n' + `${company},${OWNER}\n`);
    const ck = `name:${key(company)}`;
    await decide(v.id, 'COMPANY', ck, 'CREATE_NEW');
    // A GLOBAL holder of crm.import who is not the importer reads the decisions.
    const seen = await svc.getDecisionPreview(authOf(org, colleague), v.id);
    expect(seen.decisions).toEqual([{ kind: 'COMPANY', key: ck, decision: 'CREATE_NEW' }]);
    // Rows are not included one by one in a decided import.
    await expect(
      svc.confirmImport(authOf(org, importer), v.id, {
        fileSha256: v.fileSha256,
        counts: seen.counts,
        includeRows: [2],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INCLUDE' });

    const as = async <T>(
      person: string,
      orgId: string,
      fn: (c: import('@neondatabase/serverless').PoolClient) => Promise<T>,
    ) => {
      const c = await app.connect();
      try {
        await c.query('begin');
        await c.query(
          `select set_config('app.person_id', $1, true), set_config('app.org_id', $2, true),
                  set_config('app.aal', 'aal2', true)`,
          [person, orgId],
        );
        return await fn(c);
      } finally {
        await c.query('rollback').catch(() => undefined);
        c.release();
      }
    };
    // Another organization sees nothing.
    expect(
      await as(
        outsider,
        other,
        async (c) =>
          (await c.query(`select 1 from public.crm_import_decisions where import_id = $1`, [v.id]))
            .rowCount,
      ),
    ).toBe(0);
    // A colleague cannot clear the importer's decision, nor write a plan.
    expect(
      await as(colleague, org, (c) =>
        stateOf(c.query(`delete from public.crm_import_decisions where import_id = $1`, [v.id])),
      ),
    ).toBe('42501');
    expect(
      await as(colleague, org, (c) =>
        stateOf(
          c.query(
            `insert into public.crm_import_row_plans (org_id, import_id, row_number, skip)
             values ($1, $2, 2, true)`,
            [org, v.id],
          ),
        ),
      ),
    ).toBe('42501');
    await confirmWith(v.id, v.fileSha256);
    // After confirmation not even the importer adds to the plan.
    expect(
      await as(importer, org, (c) =>
        stateOf(
          c.query(
            `insert into public.crm_import_row_plans (org_id, import_id, row_number, skip)
             values ($1, $2, 3, true)`,
            [org, v.id],
          ),
        ),
      ),
    ).not.toBe('NO ERROR');
    expect(
      await as(
        outsider,
        other,
        async (c) =>
          (await c.query(`select 1 from public.crm_import_row_plans where import_id = $1`, [v.id]))
            .rowCount,
      ),
    ).toBe(0);
  });

  it('decisions on related entities racing each other still yield a plan without duplicates (DR-5)', async () => {
    const company = name('Race Pair Ltd');
    const ex = await existing(company, [['Asha', 'Rao']]);
    const v = await upload(HEADER + `${company},Asha,Rao,,${OWNER}\n`);
    const ck = `name:${key(company)}`;
    const ak = `name:asha rao|${ck}`;
    await Promise.allSettled([
      decide(v.id, 'CONTACT', ak, 'LINK_EXISTING'),
      decide(v.id, 'COMPANY', ck, 'CREATE_NEW'),
    ]);
    const p = await svc.getDecisionPreview(authOf(org, importer), v.id);
    expect(p.unresolved).toEqual({ companies: [], contacts: [], deals: [] });
    await confirmWith(v.id, v.fileSha256);
    await commitObserved(v.id, true);
    const [row] = await rowsOf(v.id);
    expect(row!.status).toBe('CREATED');
    expect(row!.contact_id).not.toBe(ex.contactIds[0]);
    expect(await companiesNamed(company)).toBe(2);
  });
});
