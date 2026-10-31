/**
 * The `crm_import` job handler (migration 0081): runs a confirmed Sales Sheet import's commit as
 * the person who confirmed it.
 *
 * The principal comes from crm_import_execute_as_job(), called on the worker plane
 * (withQueueDb): the job must be running under THIS worker's claim, its payload must name an
 * import of the job's organization bound to this job, and the job's enqueuer must be the
 * import's creator and still a live person. Never from the payload, never chosen by the worker.
 * The organization returned is re-checked against the job row (the workflow-jobs pattern).
 *
 *  - 22023 (the job row does not verify) can never succeed on retry: non-retryable.
 *  - 42501 (no live principal) goes to the normal retry classifier; if the job then ends without
 *    an outcome, DB maintenance marks the import FAILED (crm_import_fail_abandoned).
 *  - A finished or cancelled import ends the job quietly.
 *  - An importer who can no longer see the import (lost crm.import): the import is marked FAILED
 *    from the worker plane (crm_import_record_job_failure) and the job ends.
 *
 * NOTHING FROM THE FILE LEAVES THIS HANDLER IN AN ERROR. The worker stores a failed job's message
 * in jobs.error_message, which every jobs.view holder can read, and drizzle's query errors carry
 * the statement's parameters — the imported names, emails and phones. Every error is replaced at
 * this boundary by a fixed message with only the job id and the SQLSTATE (safeJobError).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { AuthContext } from '@/lib/db/context';
import { withQueueDb } from '@/lib/jobs/queue';
import { CrmImportPayloadSchema } from '@/lib/jobs/types';
import { registerHandler, type JobExecutionContext } from '@/lib/jobs/handler-registry';
import { pgError, runImportCommit } from './commit';

const SAFE_NAME = 'CrmImportJobError';

/** Messages this import code raises itself — value-free by construction. */
const FIXED_MESSAGES: ReadonlySet<string> = new Set([
  'crm_import commit interrupted; it resumes on retry',
  'crm_import_execute_as_job returned no row',
  'INTERNAL: import row outcome not recorded',
  'INTERNAL: company insert returned no row',
  'INTERNAL: contact insert returned no row',
  'INTERNAL: deal insert returned no row',
]);

function nonRetryable(code: string, message: string): never {
  const error = new Error(message);
  error.name = SAFE_NAME;
  (error as { code?: string }).code = code;
  throw error;
}

/**
 * The error the worker may store: a fixed message, the job id and the SQLSTATE (or an errno
 * code) — enough to act on, nothing from the query. Keeps what the retry classifier reads: the
 * code, and a NeonDbError name for connection failures.
 */
export function safeJobError(error: unknown, jobId: string): Error {
  if (error instanceof Error && error.name === SAFE_NAME) return error; // built here, value-free
  const isZod = (error as { name?: unknown })?.name === 'ZodError';
  let rootName: string | undefined;
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    rootName = (e as { name?: unknown }).name as string | undefined;
  }
  const { code } = pgError(error);
  const safeCode = code && /^[A-Z0-9_]{2,32}$/.test(code) ? code : undefined;
  // This module's own fixed messages carry no value: kept, as a cause an operator can act on.
  const own =
    error instanceof Error && error.cause === undefined && FIXED_MESSAGES.has(error.message)
      ? error.message
      : undefined;
  const detail = [safeCode && `SQLSTATE ${safeCode}`, own].filter(Boolean).join('; ');
  const safe = new Error(
    isZod
      ? `[jobs] crm_import job ${jobId}: invalid payload`
      : `[jobs] crm_import job ${jobId}: commit failed${detail ? ` (${detail})` : ''}`,
  );
  safe.name = isZod ? 'ValidationError' : rootName === 'NeonDbError' ? 'NeonDbError' : SAFE_NAME;
  if (safeCode) (safe as { code?: string }).code = safeCode;
  return safe;
}

async function recordFailure(jobId: string, workerId: string, reason: string): Promise<void> {
  await withQueueDb((tx) =>
    tx.execute(sql`
      select public.crm_import_record_job_failure(${jobId}::uuid, ${workerId}, ${reason})
    `),
  );
}

async function run(ctx: JobExecutionContext): Promise<void> {
  const { job } = ctx;
  const payload = CrmImportPayloadSchema.parse(job.payload);

  let principal: { org_id: string; person_id: string; import_id: string; import_status: string };
  try {
    const res = await withQueueDb((tx) =>
      tx.execute<typeof principal>(sql`
        select org_id, person_id, import_id, import_status
        from public.crm_import_execute_as_job(${job.id}::uuid, ${ctx.workerId})
      `),
    );
    const row = res.rows[0];
    if (!row) throw new Error('crm_import_execute_as_job returned no row');
    principal = row;
  } catch (error) {
    if (pgError(error).code === '22023') {
      nonRetryable(
        'VALIDATION_ERROR',
        `[jobs] crm_import job ${job.id}: execution-identity verification failed — dropped`,
      );
    }
    throw error;
  }

  if (principal.org_id !== job.orgId || principal.import_id !== payload.importId) {
    nonRetryable('FORBIDDEN', `[jobs] crm_import job ${job.id}: principal does not match the job`);
  }
  if (principal.import_status !== 'QUEUED' && principal.import_status !== 'RUNNING') return;

  const auth: AuthContext = { personId: principal.person_id, orgId: principal.org_id, aal: 'aal1' };
  const result = await runImportCommit(auth, principal.import_id, randomUUID(), ctx.signal);
  if (result === 'NOT_VISIBLE') {
    await recordFailure(job.id, ctx.workerId, 'IMPORTER_NOT_PERMITTED');
  }
}

export async function handleCrmImport(ctx: JobExecutionContext): Promise<void> {
  try {
    await run(ctx);
  } catch (error) {
    throw safeJobError(error, ctx.job.id);
  }
}

registerHandler('crm_import', handleCrmImport);
