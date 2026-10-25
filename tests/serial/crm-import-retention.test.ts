/**
 * BP-06, migration 0081 — job retention keeps working once Sales Sheet imports exist.
 *
 * run_data_retention() (0065) deletes succeeded and cancelled jobs older than 90 days across every
 * organization in one statement. An import references its job (composite foreign key, ON DELETE
 * SET NULL), and the import's guard refuses changes by anyone but its importer — before the 0081
 * remediation, the foreign key's own UPDATE was refused too and every retention run failed once
 * the first import job was 90 days old. Here: a completed import whose job is past retention.
 *
 * In the 'serial' project because run_data_retention() deletes across the whole database: run
 * beside other suites it could remove rows they backdated on purpose.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import { DB_READY, RUN, mkOrg, mkPerson } from '../workflows/helpers';
import { assignRoleId, mkCustomRole } from '../authz/fixtures';

describe.skipIf(!DB_READY)('job retention with Sales Sheet imports present (0081)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  const worker = new Pool({ connectionString: process.env.DATABASE_URL_WORKER });
  let org = '';
  let importer = '';

  beforeAll(async () => {
    org = await mkOrg(owner, `imp-ret-${RUN}`);
    importer = await mkPerson(owner, org, 'RetentionImporter');
    const ownerPerson = await mkPerson(owner, org, 'RetentionOwner');
    await owner.query(`update public.people set work_email = $2 where id = $1`, [
      ownerPerson,
      'owner.one@pravshi.example',
    ]);
    const role = await mkCustomRole(
      owner,
      org,
      `IMPR_${RUN.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`,
      [
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
      ].map((k): [string, string] => [k, 'GLOBAL']),
    );
    await assignRoleId(owner, importer, org, role);
  });

  afterAll(async () => {
    await Promise.all([owner.end(), worker.end()]);
  });

  it('deletes an old import job, keeps the import and its audit trail', async () => {
    const svc = await import('@/lib/import/sales-sheet/service');
    const { runImportCommit } = await import('@/lib/import/sales-sheet/commit');
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
      fileName: 'retention.csv',
      bytes: new TextEncoder().encode(
        `Company,Owner Email\nRetained ${RUN},owner.one@pravshi.example\n`,
      ),
    });
    await svc.confirmImport(auth, v.id, {
      fileSha256: v.fileSha256,
      counts: v.preview.counts,
    });
    await runImportCommit({ personId: importer, orgId: org, aal: 'aal1' }, v.id, randomUUID());
    const job = (
      await owner.query<{ job_id: string }>(`select job_id from public.crm_imports where id = $1`, [
        v.id,
      ])
    ).rows[0]!.job_id;
    // The job succeeded 91 days ago. created_at is frozen by 0061's jobs_identity_freeze; this
    // suite runs alone (the serial project), so the owner lifts it for this one statement, in
    // one transaction.
    const c = await owner.connect();
    try {
      await c.query('begin');
      await c.query('alter table public.jobs disable trigger jobs_identity_freeze');
      await c.query(
        `update public.jobs set status = 'succeeded', created_at = now() - interval '91 days'
         where id = $1`,
        [job],
      );
      await c.query('alter table public.jobs enable trigger jobs_identity_freeze');
      await c.query('commit');
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }

    const result = await worker.query<{ target: string; deleted: number }>(
      `select target, deleted from public.run_data_retention(10000)`,
    );
    expect(result.rows.find((r) => r.target === 'jobs')!.deleted).toBeGreaterThanOrEqual(1);

    expect((await owner.query(`select 1 from public.jobs where id = $1`, [job])).rows).toHaveLength(
      0,
    );
    const after = await owner.query<{
      status: string;
      job_id: string | null;
      created_count: number;
    }>(`select status, job_id, created_count from public.crm_imports where id = $1`, [v.id]);
    expect(after.rows[0]).toEqual({ status: 'COMPLETED', job_id: null, created_count: 1 });
    const audit = await owner.query<{ action: string; job: string }>(
      `select action, metadata ->> 'jobId' as job from public.audit_logs
       where org_id = $1 and entity_id = $2 order by occurred_at`,
      [org, v.id],
    );
    expect(audit.rows).toEqual([
      { action: 'crm.import.started', job },
      { action: 'crm.import.completed', job },
    ]);
    // A completed import is never touched by the abandoned-import sweep.
    await worker.query(`select public.crm_import_fail_abandoned(10000)`);
    expect(
      (await owner.query(`select status from public.crm_imports where id = $1`, [v.id])).rows[0],
    ).toEqual({ status: 'COMPLETED' });
  });
});
