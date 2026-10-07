/**
 * Phase 8 — Notifications: domain emission entry point (Workstream C).
 *
 * emitNotification() is what domain code calls when something worth
 * notifying happened (task assigned, deal stage changed, workflow failed,
 * …). It is a thin, documented alias over the service: validation,
 * idempotency, preference gating, and job enqueue all live in service.ts.
 *
 * Emission points are NOT wired here — wiring emit() into task/deal/
 * workflow services is follow-up work. The eventId contract: pass a stable
 * key (e.g. `task-assigned:${taskId}:${assigneeId}`) when redelivery must
 * dedupe; omit it for fire-and-forget.
 */
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
