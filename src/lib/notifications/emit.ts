/**
 * Phase 8 — Notifications: domain emission entry point (Workstream C).
 *
 * emitNotification() is what domain code calls when something worth
 * notifying happened (task assigned, deal stage changed, workflow failed,
 * …). It is a thin, documented alias over the service: validation,
 * idempotency, preference gating, and job enqueue all live in service.ts.
 *
 * P1b (AUD-05) wired the built-in emission points: task assignment /
 * completion (src/lib/work/tasks.ts) and deal stage changes
 * (src/lib/crm/deals.ts, src/lib/crm/pipelines.ts) emit through
 * emitNotificationSafely() below, at the same post-commit points as the
 * workflow-event dispatches and integration fan-out (D3).
 *
 * The eventId contract: the service requires a UUID (NotificationEventSchema),
 * so a human-readable occurrence key cannot be passed raw — derive one with
 * stableEventId() from the occurrence's stable parts (e.g.
 * stableEventId('task-assigned', taskId, assigneeId, updatedAt)). The same
 * occurrence always derives the same UUID, so a redelivered emission dedupes
 * in the service ((org_id, event_id) probe + the job's dedup key); a new
 * occurrence (new assignee, new updatedAt) derives a fresh one.
 */
import { createHash } from 'node:crypto';
import type { Authorization } from '../authz/require-permission';
import {
  createNotification,
  type CreateNotificationInput,
  type CreateNotificationResult,
} from './service';

export type { CreateNotificationInput, CreateNotificationResult };

/**
 * Emit a notification event to one person in the caller's org.
 * Never throws for delivery reasons the caller can't act on — validation
 * and authorization failures propagate; the worker owns delivery retries.
 */
export async function emitNotification(
  auth: Authorization,
  input: CreateNotificationInput,
): Promise<CreateNotificationResult> {
  return createNotification(auth, input);
}

/**
 * Derives a deterministic UUID (v5-shaped: SHA-256 over the parts, version
 * and variant bits stamped) from an occurrence's stable parts. Two calls
 * with the same parts yield the same id; any part change yields a new one.
 * This is the idempotency key for built-in emissions — pass the parts that
 * identify ONE occurrence (entity id + recipient + the write's updatedAt
 * or history-row id), never a wall-clock timestamp generated at emit time.
 */
export function stableEventId(...parts: Array<string | number>): string {
  const hex = createHash('sha256').update(parts.map(String).join(':'), 'utf8').digest('hex');
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Composes a `<prefix>: <subject>` notification title clipped to the event
 * schema's 200-char cap (entity names run longer — task titles to 255).
 */
export function notificationTitle(prefix: string, subject: string): string {
  return `${prefix}: ${subject}`.slice(0, 200);
}

/**
 * Failure-isolated emission for domain services (P1b, AUD-05).
 *
 * The originating mutation has already committed when this runs (emissions
 * are post-commit, like dispatchWorkflowEvent and emitIntegrationEvent),
 * and a notification must never break it (D3): emitNotification runs under
 * the caller's authority (D2 — no synthetic actor), so a caller without
 * `jobs.create` gets FORBIDDEN from the queue's gate, a recipient who left
 * the org gets INVALID_REQUEST, and any DB fault is possible. All of those
 * are logged here and swallowed — the domain operation's result stands.
 * Returns the service result on success, null when emission failed.
 */
export async function emitNotificationSafely(
  auth: Authorization,
  input: CreateNotificationInput,
): Promise<CreateNotificationResult | null> {
  try {
    return await emitNotification(auth, input);
  } catch (error) {
    console.error('[notifications] domain emission failed — domain operation unaffected', {
      type: input.type,
      recipientUserId: input.recipientUserId,
      orgId: auth.ctx.orgId,
      error,
    });
    return null;
  }
}
