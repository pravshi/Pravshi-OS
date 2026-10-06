/**
 * Phase 6 Queue Core — Job Contracts (Queue Engineer owns this file)
 *
 * Written FIRST per the Phase 6 architecture contracts (§3.1): every other
 * Phase 6 agent READS this file and does not redefine it. Contract changes
 * require Lead Architect approval.
 *
 * The durable queue is PostgreSQL-backed (no Redis). Table: `jobs`
 * (drizzle/0045_automation_jobs.sql, owned by the DB/Migration Engineer).
 */
import { z } from 'zod';

// ── Job type & status ─────────────────────────────────────────────────────────

export const JOB_TYPES = [
  'workflow_run',
  'scheduled_trigger',
  'retry',
  'webhook',
  'cleanup',
  'notification',
  'email',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_TYPE_SET: ReadonlySet<string> = new Set(JOB_TYPES);

export const JOB_STATUSES = [
  'pending',
  'claimed',
  'running',
  'succeeded',
  'failed',
  'dead_letter',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_STATUS_SET: ReadonlySet<string> = new Set(JOB_STATUSES);

// ── Job row ───────────────────────────────────────────────────────────────────

export interface Job {
  id: string;
  orgId: string;
  type: JobType;
  status: JobStatus;
  priority: number;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  nextRunAt: string; // ISO-8601
  claimedBy: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  dedupKey: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── State machine (§3.1 — ONLY these transitions are allowed) ─────────────────

/**
 * pending     → claimed | cancelled
 * claimed     → running | pending (release) | cancelled
 * running     → succeeded | failed | dead_letter | pending (requeue) | cancelled
 * failed      → pending (retry) | dead_letter | cancelled
 * dead_letter → pending (manual replay) | cancelled
 * succeeded   → (terminal)
 * cancelled   → (terminal)
 */
const JOB_TRANSITIONS: Record<JobStatus, ReadonlySet<JobStatus>> = {
  pending: new Set(['claimed', 'cancelled']),
  claimed: new Set(['running', 'pending', 'cancelled']),
  running: new Set(['succeeded', 'failed', 'dead_letter', 'pending', 'cancelled']),
  failed: new Set(['pending', 'dead_letter', 'cancelled']),
  dead_letter: new Set(['pending', 'cancelled']),
  succeeded: new Set(),
  cancelled: new Set(),
};

/** Returns true only if `from → to` is an allowed job state transition. */
export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from]?.has(to) ?? false;
}

// ── Per-type payload zod schemas ──────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `workflow_run` — dispatched by the scheduler (§3.5) and manual/API callers. */
export const WorkflowRunPayloadSchema = z.strictObject({
  workflowId: z.string().regex(UUID, 'workflowId must be a uuid'),
  eventInput: z.record(z.string(), z.unknown()).optional(),
  manualInput: z.record(z.string(), z.unknown()).optional(),
  /** D4 recursion depth; the handler rejects when this exceeds MAX_DISPATCH_DEPTH. */
  depth: z.number().int().min(0).default(0),
});
export type WorkflowRunPayload = z.infer<typeof WorkflowRunPayloadSchema>;

/** `scheduled_trigger` — a schedule firing; the scheduler normally enqueues a
 *  `workflow_run` directly (§3.5), but the type stays available for direct use. */
export const ScheduledTriggerPayloadSchema = z.strictObject({
  scheduleId: z.string().regex(UUID, 'scheduleId must be a uuid'),
  workflowId: z.string().regex(UUID, 'workflowId must be a uuid'),
  /** Minute-precision UTC of the scheduled window (drives dedup). */
  windowStart: z.string().datetime({ offset: true }),
});
export type ScheduledTriggerPayload = z.infer<typeof ScheduledTriggerPayloadSchema>;

/** `webhook` — outbound HTTP POST (SSRF rules enforced by the handler, §6). */
export const WebhookPayloadSchema = z.strictObject({
  url: z.string().url(),
  method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  signatureSecretRef: z.string().max(128).optional(),
  timeoutMs: z.number().int().min(1000).max(30000).default(10000),
});
export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

/** `email` — provider send with retry; dedup by dedupKey. */
export const EmailPayloadSchema = z
  .strictObject({
    to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]),
    subject: z.string().min(1).max(300),
    text: z.string().max(200_000).optional(),
    html: z.string().max(500_000).optional(),
    templateId: z.string().max(128).optional(),
    templateVars: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((p) => p.text !== undefined || p.html !== undefined || p.templateId !== undefined, {
    message: 'email payload needs text, html, or templateId',
  });
export type EmailPayload = z.infer<typeof EmailPayloadSchema>;

/** `notification` — writes to the notifications table (existing system, §6). */
export const NotificationPayloadSchema = z.strictObject({
  personId: z.string().regex(UUID, 'personId must be a uuid').optional(),
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(2000),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;

/** `cleanup` — retention / housekeeping sweeps. */
export const CleanupPayloadSchema = z.strictObject({
  target: z.string().min(1).max(128),
  olderThanDays: z.number().int().min(1).max(3650).optional(),
  dryRun: z.boolean().default(false),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type CleanupPayload = z.infer<typeof CleanupPayloadSchema>;

/** `retry` — re-drive a failed/dead-letter job through the queue. */
export const RetryPayloadSchema = z.strictObject({
  jobId: z.string().regex(UUID, 'jobId must be a uuid'),
  reason: z.string().max(500).optional(),
});
export type RetryPayload = z.infer<typeof RetryPayloadSchema>;

/** Payload schema per job type. queue.ts validates every enqueue against these. */
export const JOB_PAYLOAD_SCHEMAS: Record<JobType, z.ZodTypeAny> = {
  workflow_run: WorkflowRunPayloadSchema,
  scheduled_trigger: ScheduledTriggerPayloadSchema,
  retry: RetryPayloadSchema,
  webhook: WebhookPayloadSchema,
  cleanup: CleanupPayloadSchema,
  notification: NotificationPayloadSchema,
  email: EmailPayloadSchema,
};

// ── Enqueue input ─────────────────────────────────────────────────────────────

export interface EnqueueJobInput {
  type: JobType;
  /** Validated by the per-type zod schema above. Never carries orgId. */
  payload: Record<string, unknown>;
  /** Higher claims first. Default 0. */
  priority?: number;
  /** Default 5. */
  maxAttempts?: number;
  /** ISO-8601; default now (delayed jobs set a future time). */
  nextRunAt?: string;
  /** Idempotency key; a duplicate returns the existing job (no-op). */
  dedupKey?: string;
}

export const EnqueueJobInputSchema = z.strictObject({
  type: z.enum(JOB_TYPES),
  payload: z.record(z.string(), z.unknown()),
  priority: z.number().int().min(-1000).max(1000).default(0),
  maxAttempts: z.number().int().min(1).max(100).default(5),
  nextRunAt: z.string().datetime({ offset: true }).optional(),
  dedupKey: z.string().min(1).max(256).optional(),
});
