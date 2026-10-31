/**
 * BP-06, migration 0081 — no imported value reaches jobs.error_message, end to end.
 *
 * jobs.error_message is readable by every jobs.view holder, and drizzle's query errors carry the
 * statement's parameters (the imported names, emails and phones). A real failure that is not
 * about the row — a P0001 from a trigger — must leave the handler as a fixed message, be stored
 * as such by the worker's failJob(), roll its batch back whole, and let the retry finish.
 *
 * In the 'serial' project because it creates and drops a trigger on public.companies: DROP
 * TRIGGER takes ACCESS EXCLUSIVE, which parallel suites reading companies would queue behind.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { DB_READY, RUN, mkOrg, mkPerson } from '../workflows/helpers';
import { assignRoleId, mkCustomRole } from '../authz/fixtures';

describe.skipIf(!DB_READY)('crm_import job errors carry no imported value (0081, live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  let org = '';
  let importer = '';
  const fn = `poison_${RUN.replace(/[^a-z0-9]/g, '')}`;
  const secret = `SECRET-${RUN}`;

  beforeAll(async () => {
    org = await mkOrg(owner, `imp-err-${RUN}`);
    importer = await mkPerson(owner, org, 'ErrorImporter');
    const ownerPerson = await mkPerson(owner, org, 'ErrorOwner');
    await owner.query(
      `update public.people set work_email = 'owner.one@pravshi.example' where id = $1`,
      [ownerPerson],
    );
    const role = await mkCustomRole(
      owner,
      org,
      `IMPE_${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`,
      [
        'crm.import',
        'companies.view',
        'companies.create',
        'companies.edit',
        'contacts.view',
        'contacts.create',
        'contacts.edit',
        'people.view',
        'jobs.create',
      ].map((k): [string, string] => [k, 'GLOBAL']),
    );
    await assignRoleId(owner, importer, org, role);
    await owner.query(`create function public.${fn}() returns trigger language plpgsql as $f$
      begin if new.name like '%${secret}%' then raise exception 'poisoned'; end if; return new; end $f$`);
    await owner.query(
      `create trigger ${fn} before insert on public.companies for each row execute function public.${fn}()`,
    );
  });

  afterAll(async () => {
    await owner.query(`drop trigger if exists ${fn} on public.companies`);
    await owner.query(`drop function if exists public.${fn}()`);
    await owner.end();
  });

  it('stores only the fixed message, rolls the batch back, and the retry completes', async () => {
    const svc = await import('@/lib/import/sales-sheet/service');
    const { handleCrmImport } = await import('@/lib/import/sales-sheet/job');
    const { classifyError } = await import('@/lib/jobs/retry');
    const { failJob } = await import('@/lib/jobs/queue');
    const { buildJobAuthorization } = await import('@/worker/worker');
    const requestId = randomUUID();
    const auth = {
      ctx: { personId: importer, orgId: org, aal: 'aal2' as const },
      permission: 'crm.import',
      scope: 'GLOBAL' as const,
      aal: 'aal2' as const,
      requestId,
      meta: { requestId, ip: null, userAgent: null },
    } as unknown as Parameters<typeof svc.getImport>[0];
    const v = await svc.createImportPreview(auth, {
      fileName: 'poison.csv',
      bytes: new TextEncoder().encode(
        'Company,Company Domain,Contact First Name,Contact Last Name,Contact Email,Contact Phone,Owner Email\n' +
          `"Poison ${secret}",${secret.toLowerCase()}.example,Priya,${secret},priya.${secret.toLowerCase()}@private.example,+91 99999 ${RUN},owner.one@pravshi.example\n`,
      ),
    });
    await svc.confirmImport(auth, v.id, { fileSha256: v.fileSha256, counts: v.preview.counts });
    const jobId = (
      await owner.query<{ id: string }>(
        `select job_id as id from public.crm_imports where id = $1`,
        [v.id],
      )
    ).rows[0]!.id;
    const claim = () =>
      owner.query(
        `update public.jobs set status = 'running', claimed_by = 'w-poison', claimed_at = now() where id = $1`,
        [jobId],
      );
    const ctx = {
      job: { id: jobId, orgId: org, type: 'crm_import', payload: { importId: v.id } },
      workerId: 'w-poison',
      signal: new AbortController().signal,
      auth: undefined,
    } as unknown as Parameters<typeof handleCrmImport>[0];

    await claim();
    const thrown = await handleCrmImport(ctx).then(
      () => null,
      (e: unknown) => e as Error & { code?: string },
    );
    expect(thrown).not.toBeNull();
    expect(thrown!.code).toBe('P0001');
    expect(thrown!.message).toBe(`[jobs] crm_import job ${jobId}: commit failed (SQLSTATE P0001)`);
    for (const leaked of [secret, secret.toLowerCase(), 'params', 'insert into']) {
      expect(thrown!.message).not.toContain(leaked);
    }
    // What the worker stores is the sanitised message, and the error is still retried.
    await failJob(
      buildJobAuthorization({ id: jobId, orgId: org } as never),
      jobId,
      classifyError(thrown),
      true,
      'w-poison',
    );
    const stored = await owner.query<{ error_message: string }>(
      `select error_message from public.jobs where id = $1`,
      [jobId],
    );
    expect(stored.rows[0]!.error_message).toBe(thrown!.message);
    expect(classifyError(thrown).retryable).toBe(true);
    // The batch rolled back whole: nothing created, the row still PENDING (AC-I2).
    const row = await owner.query(
      `select status from public.crm_import_rows where import_id = $1`,
      [v.id],
    );
    expect(row.rows[0]).toEqual({ status: 'PENDING' });

    // Once the cause is gone, the retry completes the same import.
    await owner.query(`drop trigger ${fn} on public.companies`);
    await claim();
    await handleCrmImport(ctx);
    const done = await owner.query(
      `select status, created_count from public.crm_imports where id = $1`,
      [v.id],
    );
    expect(done.rows[0]).toEqual({ status: 'COMPLETED', created_count: 1 });
  });
});
