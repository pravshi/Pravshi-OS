/**
 * V1 audit TI-18 / MT-M3, LIVE DB — every job and schedule mutation writes its audit entry
 * in the mutation's own transaction (src/lib/jobs/audit.ts):
 *   - success: exactly one entry for the entity, attributed to the caller, carrying the
 *     request id;
 *   - failure: when the audit write fails, the mutation rolls back — the row is unchanged
 *     and no entry is left behind.
 *
 * The failure is real, not mocked: a request id that is not a UUID makes the ::uuid cast in
 * the write_audit_log() call raise (22P02) inside the transaction — the position any audit
 * failure (a full partition, a revoked grant) would occupy.
 *
 * Drives the API store (createSchedule / updateSchedule / deleteSchedule) and the queue
 * (cancelJob / retryJob) as a real person, on app_user. Gated behind DB_READY.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from '@neondatabase/serverless';
import type { Authorization } from '@/lib/authz/require-permission';
import { DB_READY, mkOrg, mkPerson, mkRoleFor, mkWorkflow, RUN } from '../workflows/helpers';

const REQUEST_ID = '00000000-0000-4000-8000-0000000000ab';

describe.skipIf(!DB_READY)('job/schedule audit is in the mutation transaction (live DB)', () => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL_MIGRATE });
  let orgId = '';
  let personId = '';
  let workflowId = '';
  let auth: Authorization;
  let broken: Authorization; // same caller; its audit write cannot succeed

  beforeAll(async () => {
    if (!DB_READY) return;
    orgId = await mkOrg(owner, `jaudit-${RUN}`);
    personId = await mkPerson(owner, orgId, `Jobs Audit ${RUN}`);
    await mkRoleFor(owner, orgId, personId, `jaudit_${RUN}`, [
      'jobs.view',
      'jobs.create',
      'jobs.retry',
      'jobs.cancel',
    ]);
    workflowId = (await mkWorkflow(owner, orgId, { createdBy: personId })).id;
    const ctx = { personId, orgId, aal: 'aal1' };
    auth = {
      ctx,
      requestId: REQUEST_ID,
      meta: { requestId: REQUEST_ID, ip: null, userAgent: null },
    } as unknown as Authorization;
    broken = {
      ctx,
      requestId: REQUEST_ID,
      meta: { requestId: 'not-a-uuid', ip: null, userAgent: null },
    } as unknown as Authorization;
  }, 60_000);

  afterAll(async () => {
    if (!DB_READY) return;
    await owner.end();
  });

  const entries = async (action: string, entityId: string) =>
    (
      await owner.query<{ actor_person_id: string; request_id: string }>(
        `select actor_person_id, request_id from public.audit_logs
         where org_id = $1 and action = $2 and entity_id = $3`,
        [orgId, action, entityId],
      )
    ).rows;

  const scheduleRow = async (id: string) =>
    (
      await owner.query<{ name: string; is_active: boolean }>(
        `select name, is_active from public.schedules where id = $1`,
        [id],
      )
    ).rows[0];

  const seedSchedule = async (name: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into public.schedules
           (org_id, workflow_id, name, cron, timezone, is_active, next_run_at, created_by)
         values ($1, $2, $3, '0 9 * * *', 'UTC', true, now() + interval '1 day', $4)
         returning id`,
        [orgId, workflowId, name, personId],
      )
    ).rows[0]!.id;

  /**
   * Jobs are seeded due a day from now. Other suites run the worker plane's live retry sweep
   * (jobs_sweep_retryable: failed AND next_run_at <= now()) and live claims (jobs_claim_next:
   * pending AND next_run_at <= now(), any type) on this shared database; a job due now could be
   * moved by them between this test's own steps — a failed job swept to pending was observed.
   * Not due, the job is outside both, and only this test changes it.
   */
  const seedJob = async (status: 'pending' | 'failed') =>
    (
      await owner.query<{ id: string }>(
        `insert into public.jobs (org_id, type, status, next_run_at)
         values ($1, 'email', $2, now() + interval '1 day') returning id`,
        [orgId, status],
      )
    ).rows[0]!.id;

  /** The job's mutable state, to prove a refused mutation changed none of it. */
  const jobRow = async (id: string) =>
    (
      await owner.query<{
        status: string;
        attempts: number;
        not_due: boolean;
        next_run_at: string;
        updated_at: string;
      }>(
        `select status, attempts, next_run_at > now() as not_due,
                next_run_at::text, updated_at::text
           from public.jobs where id = $1`,
        [id],
      )
    ).rows[0]!;

  const jobStatus = async (id: string) =>
    (await owner.query<{ status: string }>(`select status from public.jobs where id = $1`, [id]))
      .rows[0]!.status;

  it('createSchedule: one entry on success; nothing at all when the audit fails', async () => {
    const { createSchedule } = await import('@/app/api/jobs/store');
    const input = (name: string) => ({ workflowId, name, cron: '0 9 * * *', timezone: 'UTC' });

    const created = await createSchedule(auth, input(`jaudit-ok-${RUN}`));
    const ok = await entries('schedule.created', created.id);
    expect(ok).toEqual([{ actor_person_id: personId, request_id: REQUEST_ID }]);

    const name = `jaudit-rollback-${RUN}`;
    await expect(createSchedule(broken, input(name))).rejects.toThrow();
    const { rowCount } = await owner.query(
      `select 1 from public.schedules where org_id = $1 and name = $2`,
      [orgId, name],
    );
    expect(rowCount).toBe(0);
  });

  it('updateSchedule: a failed audit leaves the schedule unchanged', async () => {
    const { updateSchedule } = await import('@/app/api/jobs/store');
    const id = await seedSchedule(`jaudit-upd-${RUN}`);

    await expect(updateSchedule(broken, id, { name: `jaudit-upd-x-${RUN}` })).rejects.toThrow();
    expect((await scheduleRow(id))!.name).toBe(`jaudit-upd-${RUN}`);
    expect(await entries('schedule.updated', id)).toHaveLength(0);

    await updateSchedule(auth, id, { name: `jaudit-upd-y-${RUN}` });
    expect((await scheduleRow(id))!.name).toBe(`jaudit-upd-y-${RUN}`);
    expect(await entries('schedule.updated', id)).toHaveLength(1);
  });

  it('deleteSchedule: a failed audit leaves the schedule active', async () => {
    const { deleteSchedule } = await import('@/app/api/jobs/store');
    const id = await seedSchedule(`jaudit-del-${RUN}`);

    await expect(deleteSchedule(broken, id)).rejects.toThrow();
    expect((await scheduleRow(id))!.is_active).toBe(true);
    expect(await entries('schedule.deleted', id)).toHaveLength(0);

    await deleteSchedule(auth, id);
    expect((await scheduleRow(id))!.is_active).toBe(false);
    expect(await entries('schedule.deleted', id)).toHaveLength(1);
  });

  it('cancelJob: a failed audit leaves the job pending', async () => {
    const { cancelJob } = await import('@/lib/jobs/queue');
    const id = await seedJob('pending');
    const seeded = await jobRow(id);
    expect(seeded.not_due).toBe(true); // outside live claims (see seedJob)

    await expect(cancelJob(broken, id)).rejects.toThrow();
    expect(await jobRow(id)).toEqual(seeded); // nothing about the job changed
    expect(await entries('job.cancelled', id)).toHaveLength(0);

    await cancelJob(auth, id);
    expect(await jobStatus(id)).toBe('cancelled');
    expect(await entries('job.cancelled', id)).toEqual([
      { actor_person_id: personId, request_id: REQUEST_ID },
    ]);
  });

  it('retryJob: a failed audit leaves the job failed', async () => {
    const { retryJob } = await import('@/lib/jobs/queue');
    const id = await seedJob('failed');
    const seeded = await jobRow(id);
    expect(seeded.not_due).toBe(true); // outside the live retry sweep (see seedJob)

    await expect(retryJob(broken, id)).rejects.toThrow();
    expect(await jobRow(id)).toEqual(seeded); // still failed; nothing about the job changed
    expect(await entries('job.retried', id)).toHaveLength(0);

    // A successful retry makes the job pending AND due at once, so a live claim may take it
    // immediately; the state the retry committed is read from its own result, not re-read.
    const replayed = await retryJob(auth, id);
    expect(replayed.status).toBe('pending');
    expect(replayed.attempts).toBe(0);
    expect(await entries('job.retried', id)).toHaveLength(1);
  });
});
