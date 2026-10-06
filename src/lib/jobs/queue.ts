/**
 * Phase 6 Queue Core — enqueue / claim / complete / fail / heartbeat / cancel / retry
 *
 * Owner: Queue Engineer. Other agents MUST NOT modify this file.
 *
 * ── AUTHORITY MODEL ──────────────────────────────────────────────────────────
 * Every function takes org_id from auth.ctx (NEVER from input or payload) and
 * re-states org_id on every query. The permission gate runs BEFORE input
 * validation (Phase 5 service.ts pattern): unauthorized callers get FORBIDDEN,
 * never INVALID_REQUEST.
 *
 * claimJob / heartbeatJob are WORKER-PLANE operations: their contract
 * signatures carry no Authorization (the worker has not learned the job's org
 * yet — it learns it FROM THE CLAIMED ROW, §3.6 actor authority rule). They
 * run on a plain pooled transaction without the per-request SET LOCAL
 * identity; the claim SQL deliberately has NO org filter (contract §3.2).
 * NOTE FOR DB/RLS ENGINEER: migration 0045 plans FORCE RLS on `jobs` with
 * per-org policies, so this cross-org claim needs an explicit privilege path —
 * e.g. a SECURITY DEFINER `jobs_claim()` function (the Phase 5
 * workflow_record_execution pattern) or a dedicated worker role. The SQL below
 * is final; only the privilege path is open.
 *
 * ── EXACTLY-ONCE CLAIMING ────────────────────────────────────────────────────
 * claimJob runs SELECT ... FOR UPDATE SKIP LOCKED + the claiming UPDATE inside
 * ONE transaction. SKIP LOCKED makes concurrent workers skip rows another
 * worker's transaction has locked instead of blocking, so N workers racing on
 * the same pending row resolve to exactly one winner: the losers' SELECT sees
 * the row as locked and skips it. The winner's UPDATE (status pending→claimed)
 * commits atomically with the lock, so a crash between SELECT and UPDATE can
 * never hand the same job to two workers.
 */
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { withAuthorizedDb, type Tx } from '../db/authorized';
import { connectWithWake } from '../db/pool';
import type { Authorization } from '../authz/require-permission';
import { AuthorizationError } from '../authz/errors';
import { auditJobsMutation } from './audit';
import {
  canTransitionJob,
  EnqueueJobInputSchema,
  JOB_PAYLOAD_SCHEMAS,
  JOB_TYPES,
  JOB_TYPE_SET,
  type EnqueueJobInput,
  type Job,
  type JobStatus,
  type JobType,
} from './types';
import type { JobError } from './retry';

// ── Permissions (seeded by 0045; names frozen by contract §2.5) ───────────────

const PERM_CREATE = 'jobs.create';
const PERM_RETRY = 'jobs.retry';
const PERM_CANCEL = 'jobs.cancel';

// ── Worker-plane privilege path (migrations 0045/0047) ───────────────────────
//
// The worker runs as the nil-UUID system actor (SYSTEM_ACTOR_ID in
// ./worker), which is not a row in `people`: authz.person_id() → NULL, so
// authz.has('jobs.retry') is always false and the org-scoped RLS policies
// fail closed for every worker-plane write. Provisioning RBAC permissions to
// a non-person identity was rejected (it would bypass the role/people
// resolution every other permission flows through); instead the worker plane
// calls SECURITY DEFINER functions — the jobs_claim_next() pattern from
// 0045, extended by 0047 to start/complete/fail/heartbeat. Each function
// takes NO org_id: org scoping comes from the JOB ROW (contract §3.6 actor
// authority rule) plus the claimed_by ownership check, so a worker can only
// touch jobs it currently holds the claim for — never cross-org.

/** Nil-UUID system actor. Must match SYSTEM_ACTOR_ID in ./worker. */
const SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-000000000000';

function isSystemActor(auth: Authorization): boolean {
  return auth.ctx.personId === SYSTEM_ACTOR_ID;
}

/**
 * Map a worker-plane definer-function raise to the queue's error vocabulary:
 * JOB_ILLEGAL_TRANSITION → INVALID_REQUEST (the same verdict
 * assertTransition gives on the authorized path); anything else propagates
 * unchanged. A zero-row result (not thrown) means the claim is not held by
 * this worker → NOT_FOUND, handled at each call site.
 */
function mapWorkerPlaneError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('JOB_ILLEGAL_TRANSITION')) {
    return invalidRequest(message);
  }
  return error instanceof Error ? error : new Error(message);
}

function workerClaimNotFound(): AuthorizationError {
  return new AuthorizationError('NOT_FOUND', {
    requestId: randomUUIDish(),
    reason: 'TARGET_NOT_VISIBLE',
  });
}

/**
 * Permission gate BEFORE validation — mirrors Phase 5 service.ts
 * requireWorkflowPermission: a caller without the permission gets FORBIDDEN
 * even when the input would also fail validation.
 */
async function requireJobPermission(auth: Authorization, permission: string): Promise<void> {
  const check = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{ ok: boolean }>(sql`select authz.has(${permission}) as ok`),
  );
  if (check.rows[0]?.ok !== true) {
    throw new AuthorizationError('FORBIDDEN', {
      requestId: auth.requestId,
      reason: 'PERMISSION_DENIED',
    });
  }
}

/** Worker-plane transaction: same machinery as withAuthorizedDb but without a
 *  per-request identity (there is no user on this path — see header note).
 *  Exported for handlers that need a worker-plane privilege path of their own
 *  (e.g. workflow-jobs.ts calls the 0048 workflow_execute_as_job() verifier
 *  through it — the definer verifies everything from the job row, so the
 *  caller identity is irrelevant). */
export async function withQueueDb<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await connectWithWake();
  try {
    const db = drizzle(client);
    return await db.transaction(fn);
  } finally {
    client.release();
  }
}

function isPgCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/** A 23505 from the (org_id, dedup_key) unique index becomes the caller's no-op. */
function isDedupConflict(error: unknown): boolean {
  return isPgCode(error, '23505');
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function invalidRequest(message: string): Error {
  return new Error(`INVALID_REQUEST: ${message}`);
}

/** Raw `jobs` row → Job contract type. Column order matches the SELECT lists below. */
function mapJobRow(row: Record<string, unknown>): Job {
  const type = String(row.type);
  if (!JOB_TYPE_SET.has(type)) {
    throw new Error(`INTERNAL: unknown job type '${type}' in database`);
  }
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    type: type as JobType,
    status: String(row.status) as JobStatus,
    priority: Number(row.priority),
    payload: (row.payload ?? {}) as Record<string, unknown>,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    nextRunAt: toIso(row.next_run_at),
    claimedBy: row.claimed_by == null ? null : String(row.claimed_by),
    claimedAt: row.claimed_at == null ? null : toIso(row.claimed_at),
    heartbeatAt: row.heartbeat_at == null ? null : toIso(row.heartbeat_at),
    dedupKey: row.dedup_key == null ? null : String(row.dedup_key),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const JOB_COLUMNS = sql`
  id, org_id, type, status, priority, payload, attempts, max_attempts,
  next_run_at, claimed_by, claimed_at, heartbeat_at, dedup_key,
  error_code, error_message, created_at, updated_at
`;

/** Load one job, org-scoped. Zero rows → NOT_FOUND (missing or other org's). */
async function loadJobForUpdate(
  tx: Tx,
  orgId: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  const result = await tx.execute<Record<string, unknown>>(sql`
    select ${JOB_COLUMNS} from jobs
    where id = ${jobId} and org_id = ${orgId}
    for update
  `);
  const row = result.rows[0];
  if (!row) {
    throw new AuthorizationError('NOT_FOUND', {
      requestId: randomUUIDish(),
      reason: 'TARGET_NOT_VISIBLE',
    });
  }
  return row;
}

function randomUUIDish(): string {
  return '00000000-0000-4000-8000-000000000000';
}

/**
 * Enforce the §3.1 state machine inside the caller's transaction.
 * Throws INVALID_REQUEST on any disallowed transition.
 */
function assertTransition(job: Job, to: JobStatus): void {
  if (!canTransitionJob(job.status, to)) {
    throw invalidRequest(`illegal job transition ${job.status} -> ${to} for job ${job.id}`);
  }
}

// ── enqueue ───────────────────────────────────────────────────────────────────

/**
 * Validate the payload against the per-type zod schema, stamp org_id from
 * auth.ctx (NEVER from input), and insert. A dedup_key collision returns the
 * existing job — an idempotent no-op. Race-safe: the (org_id, dedup_key)
 * unique index arbitrates concurrent inserts; the loser catches 23505 and
 * fetches the winner's row.
 */
export async function enqueueJob(auth: Authorization, input: EnqueueJobInput): Promise<Job> {
  await requireJobPermission(auth, PERM_CREATE);

  const parsed = EnqueueJobInputSchema.parse(input);
  try {
    JOB_PAYLOAD_SCHEMAS[parsed.type].parse(parsed.payload);
  } catch (e) {
    if (e instanceof z.ZodError) {
      throw invalidRequest(`invalid payload for job type '${parsed.type}': ${e.message}`);
    }
    throw e;
  }

  const orgId = auth.ctx.orgId;
  const nextRunAt = parsed.nextRunAt ?? new Date().toISOString();

  return withAuthorizedDb(auth.ctx, async (tx) => {
    try {
      const result = await tx.execute<Record<string, unknown>>(sql`
        insert into jobs (org_id, type, priority, payload, max_attempts, next_run_at, dedup_key)
        values (${orgId}, ${parsed.type}, ${parsed.priority}, ${JSON.stringify(parsed.payload)}::jsonb,
                ${parsed.maxAttempts}, ${nextRunAt}::timestamptz, ${parsed.dedupKey ?? null})
        returning ${JOB_COLUMNS}
      `);
      const inserted = result.rows[0];
      if (!inserted) throw new Error('INTERNAL: job insert returned no row');
      return mapJobRow(inserted);
    } catch (e) {
      if (isDedupConflict(e) && parsed.dedupKey != null) {
        // Lost the race (or a true duplicate): return the existing job.
        const existing = await tx.execute<Record<string, unknown>>(sql`
          select ${JOB_COLUMNS} from jobs
          where org_id = ${orgId} and dedup_key = ${parsed.dedupKey}
        `);
        if (existing.rows[0]) return mapJobRow(existing.rows[0]);
      }
      throw e;
    }
  });
}

// ── claim ─────────────────────────────────────────────────────────────────────

/**
 * Atomically claim the highest-priority due pending job (optionally filtered
 * by type). Single transaction: SELECT ... FOR UPDATE SKIP LOCKED, then UPDATE
 * to claimed with claimed_by / claimed_at / heartbeat_at. Returns null when no
 * job is due.
 *
 * Exactly-once: SKIP LOCKED lets concurrent workers skip rows locked by
 * another worker's in-flight transaction instead of blocking on them, so two
 * workers can never be handed the same row — the losers simply see the next
 * unlocked candidate. The status flip commits in the same transaction as the
 * lock, so there is no window where a job is "selected but not marked".
 */
export async function claimJob(workerId: string, types?: JobType[]): Promise<Job | null> {
  if (!workerId || workerId.length > 128) {
    throw invalidRequest('workerId is required (max 128 chars)');
  }
  if (types !== undefined) {
    if (!Array.isArray(types) || types.length === 0 || types.some((t) => !JOB_TYPE_SET.has(t))) {
      throw invalidRequest(`types must be a non-empty array of: ${JOB_TYPES.join(', ')}`);
    }
  }

  return withQueueDb(async (tx) => {
    // Worker-plane privilege path (contract §3.2): RLS is FORCED on jobs,
    // so the cross-org claim goes through the SECURITY DEFINER
    // jobs_claim_next() from 0045 — the only claim path. Identical claim
    // semantics to the raw SQL it replaces: highest-priority due pending
    // job, SELECT ... FOR UPDATE SKIP LOCKED, claim stamped atomically.
    // The scalar composite return is NULL when nothing was claimed, which
    // surfaces as a single all-NULL row — hence the id filter.
    const result = await tx.execute<Record<string, unknown>>(sql`
      select * from public.jobs_claim_next(${workerId}, ${types ?? null}::text[]) as claimed
      where claimed.id is not null
    `);
    const row = result.rows[0];
    return row ? mapJobRow(row) : null;
  });
}

// ── start (claimed → running) ─────────────────────────────────────────────────
//
// NOTE FOR LEAD ARCHITECT: the §3.1 state machine requires claimed → running,
// but §3.2 lists no queue function for it, so a worker could never advance a
// claim. startJob fills that gap (permission: jobs.retry). Ratify or replace.

/** Mark a claimed job as running. The worker calls this right before executing. */
export async function startJob(
  auth: Authorization,
  jobId: string,
  workerId?: string,
): Promise<void> {
  if (isSystemActor(auth)) {
    // Worker plane: the system actor cannot pass the permission gate, so the
    // transition goes through the SECURITY DEFINER jobs_start() (0047),
    // which enforces claimed_by ownership and the claimed → running
    // transition in SQL. Zero rows → claim not held → NOT_FOUND.
    if (!workerId) {
      throw invalidRequest('workerId is required for system-actor startJob');
    }
    await withQueueDb(async (tx) => {
      try {
        const result = await tx.execute<Record<string, unknown>>(sql`
          select * from public.jobs_start(${workerId}, ${jobId})
        `);
        if (!result.rows[0]) throw workerClaimNotFound();
      } catch (e) {
        throw mapWorkerPlaneError(e);
      }
    });
    return;
  }
  await requireJobPermission(auth, PERM_RETRY);
  await withAuthorizedDb(auth.ctx, async (tx) => {
    const job = mapJobRow(await loadJobForUpdate(tx, auth.ctx.orgId, jobId));
    assertTransition(job, 'running');
    await tx.execute(sql`
      update jobs
      set status = 'running', heartbeat_at = now(), updated_at = now()
      where id = ${jobId} and org_id = ${auth.ctx.orgId}
    `);
  });
}

// ── complete ──────────────────────────────────────────────────────────────────

/**
 * running → succeeded. `result` is accepted for API compatibility; the jobs
 * table has no result column, so it is not persisted (a future column can be
 * added by the DB engineer without changing this signature).
 */
export async function completeJob(
  auth: Authorization,
  jobId: string,
  _result?: unknown,
  workerId?: string,
): Promise<void> {
  if (isSystemActor(auth)) {
    // Worker plane: running → succeeded through the SECURITY DEFINER
    // jobs_complete() (0047). Zero rows → claim not held → NOT_FOUND.
    if (!workerId) {
      throw invalidRequest('workerId is required for system-actor completeJob');
    }
    await withQueueDb(async (tx) => {
      try {
        const result = await tx.execute<Record<string, unknown>>(sql`
          select * from public.jobs_complete(${workerId}, ${jobId})
        `);
        if (!result.rows[0]) throw workerClaimNotFound();
      } catch (e) {
        throw mapWorkerPlaneError(e);
      }
    });
    return;
  }
  await requireJobPermission(auth, PERM_RETRY);
  await withAuthorizedDb(auth.ctx, async (tx) => {
    const job = mapJobRow(await loadJobForUpdate(tx, auth.ctx.orgId, jobId));
    assertTransition(job, 'succeeded');
    await tx.execute(sql`
      update jobs
      set status = 'succeeded',
          error_code = null,
          error_message = null,
          updated_at = now()
      where id = ${jobId} and org_id = ${auth.ctx.orgId}
    `);
  });
}

// ── fail ──────────────────────────────────────────────────────────────────────

/**
 * running (or claimed, if the worker died before startJob) → failed | dead_letter.
 * attempts increments here — NOT on claim — so the count means "completed
 * attempts", matching the reaper contract (§3.4: stale claimed/running →
 * pending with attempts+1 for the abandoned attempt).
 *
 * - retryable && attempts < maxAttempts → 'failed' (eligible for retryJob)
 * - otherwise → 'dead_letter' (terminal until manual replay)
 */
export async function failJob(
  auth: Authorization,
  jobId: string,
  error: JobError,
  retryable: boolean,
  workerId?: string,
): Promise<void> {
  if (isSystemActor(auth)) {
    // Worker plane: the failed/dead_letter decision (attempts+1 vs
    // max_attempts, retryable flag) runs inside the SECURITY DEFINER
    // jobs_fail() (0047) so the read and the write are atomic. Error
    // truncation matches the authorized path exactly (code ≤64 chars,
    // message NUL-stripped ≤2000 chars). Zero rows → claim not held.
    if (!workerId) {
      throw invalidRequest('workerId is required for system-actor failJob');
    }
    if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') {
      throw invalidRequest('error must be a JobError { code, message }');
    }
    await withQueueDb(async (tx) => {
      try {
        const result = await tx.execute<Record<string, unknown>>(sql`
          select * from public.jobs_fail(
            ${workerId},
            ${jobId},
            ${error.code.slice(0, 64)},
            ${error.message.replace(/\0/g, '').slice(0, 2000)},
            ${retryable}
          )
        `);
        if (!result.rows[0]) throw workerClaimNotFound();
      } catch (e) {
        throw mapWorkerPlaneError(e);
      }
    });
    return;
  }
  await requireJobPermission(auth, PERM_RETRY);
  if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') {
    throw invalidRequest('error must be a JobError { code, message }');
  }
  await withAuthorizedDb(auth.ctx, async (tx) => {
    const job = mapJobRow(await loadJobForUpdate(tx, auth.ctx.orgId, jobId));
    if (job.status !== 'running' && job.status !== 'claimed') {
      throw invalidRequest(`cannot fail job ${job.id} from status '${job.status}'`);
    }
    const attempts = job.attempts + 1;
    const terminal = !retryable || attempts >= job.maxAttempts;
    const to: JobStatus = terminal ? 'dead_letter' : 'failed';
    assertTransition(job, to);
    await tx.execute(sql`
      update jobs
      set status = ${to},
          attempts = ${attempts},
          error_code = ${error.code.slice(0, 64)},
          error_message = ${error.message.replace(/\0/g, '').slice(0, 2000)},
          next_run_at = now(),
          updated_at = now()
      where id = ${jobId} and org_id = ${auth.ctx.orgId}
    `);
  });
}

// ── heartbeat ─────────────────────────────────────────────────────────────────

/**
 * Worker-plane liveness ping. Only the worker holding the claim
 * (claimed_by = workerId) on a claimed/running job may move the heartbeat;
 * anything else → NOT_FOUND so a stale worker cannot resurrect a reaped job.
 */
export async function heartbeatJob(workerId: string, jobId: string): Promise<void> {
  if (!workerId) throw invalidRequest('workerId is required');
  // Worker-plane privilege path (0047): RLS is FORCED on jobs, so the
  // liveness ping goes through the SECURITY DEFINER jobs_heartbeat(),
  // which only moves the heartbeat when this worker holds the claim.
  const ok = await withQueueDb(async (tx) => {
    const result = await tx.execute<{ ok: boolean }>(sql`
      select public.jobs_heartbeat(${workerId}, ${jobId}) as ok
    `);
    return result.rows[0]?.ok === true;
  });
  if (!ok) {
    throw new AuthorizationError('NOT_FOUND', {
      requestId: randomUUIDish(),
      reason: 'TARGET_NOT_VISIBLE',
    });
  }
}

// ── cancel ────────────────────────────────────────────────────────────────────

/** Any non-terminal job → cancelled. Terminal (succeeded/cancelled) → throw. */
export async function cancelJob(auth: Authorization, jobId: string): Promise<void> {
  await requireJobPermission(auth, PERM_CANCEL);
  let fromStatus: JobStatus | null = null;
  let jobType: JobType | null = null;
  await withAuthorizedDb(auth.ctx, async (tx) => {
    const job = mapJobRow(await loadJobForUpdate(tx, auth.ctx.orgId, jobId));
    fromStatus = job.status;
    jobType = job.type;
    assertTransition(job, 'cancelled');
    await tx.execute(sql`
      update jobs
      set status = 'cancelled', updated_at = now()
      where id = ${jobId} and org_id = ${auth.ctx.orgId}
    `);
  });
  // Audited after the mutation commits (own transaction, fail-open): the
  // actor/org are derived from auth.ctx by write_audit_log().
  await auditJobsMutation(auth, {
    action: 'job.cancelled',
    entityType: 'job',
    entityId: jobId,
    severity: 'MEDIUM',
    metadata: {
      jobType,
      fromStatus,
      toStatus: 'cancelled',
    },
  });
}

// ── retry ─────────────────────────────────────────────────────────────────────

/**
 * failed | dead_letter → pending (manual replay). Resets the attempt counter
 * so maxAttempts applies fresh to the replay, clears claim/error state, and
 * makes the job due immediately. Terminal states and active jobs → throw.
 */
export async function retryJob(auth: Authorization, jobId: string): Promise<Job> {
  await requireJobPermission(auth, PERM_RETRY);
  const replayed = await withAuthorizedDb(auth.ctx, async (tx) => {
    const job = mapJobRow(await loadJobForUpdate(tx, auth.ctx.orgId, jobId));
    const fromStatus = job.status;
    const jobType = job.type;
    assertTransition(job, 'pending');
    const result = await tx.execute<Record<string, unknown>>(sql`
      update jobs
      set status = 'pending',
          attempts = 0,
          next_run_at = now(),
          claimed_by = null,
          claimed_at = null,
          heartbeat_at = null,
          error_code = null,
          error_message = null,
          updated_at = now()
      where id = ${jobId} and org_id = ${auth.ctx.orgId}
      returning ${JOB_COLUMNS}
    `);
    const row = result.rows[0];
    if (!row) throw new Error('INTERNAL: job retry update returned no row');
    return { replayed: mapJobRow(row), fromStatus, jobType };
  });
  // Audited after the mutation commits (own transaction, fail-open): the
  // actor/org are derived from auth.ctx by write_audit_log().
  await auditJobsMutation(auth, {
    action: 'job.retried',
    entityType: 'job',
    entityId: jobId,
    severity: 'MEDIUM',
    metadata: {
      jobType: replayed.jobType,
      fromStatus: replayed.fromStatus,
      toStatus: replayed.replayed.status,
    },
  });
  return replayed.replayed;
}
