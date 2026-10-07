/**
 * Phase 8 — Notifications: event construction (Workstream C).
 *
 * Owns the NotificationEvent contract (§16.4): validation and the
 * idempotency-key default. Emission points (task/deal/workflow triggers) call
 * makeNotificationEvent() and hand the result to emit.ts; stable eventIds are
 * the caller's responsibility when cross-call idempotency is wanted.
 */
import { randomUUID } from 'node:crypto';
import {
  NotificationEventSchema,
  type NotificationEventType,
  type ValidatedNotificationEvent,
} from './types';

export type { NotificationEventType };

/** Input for makeNotificationEvent: eventId is optional and stamped when absent. */
export interface NewNotificationEventInput {
  eventId?: string;
  type: NotificationEventType;
  orgId: string;
  recipientUserId: string;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
  link?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Validates the input against NotificationEventSchema and stamps a random
 * UUID eventId when the caller did not supply one. A caller that needs
 * redelivery idempotency MUST pass a stable eventId (e.g.
 * `task-assigned:${taskId}:${assigneeId}`) — without one, every call is a new
 * event. Throws ZodError on invalid input (→ 400 at API boundaries,
 * INVALID_REQUEST in workflow actions).
 */
export function makeNotificationEvent(
  input: NewNotificationEventInput,
): ValidatedNotificationEvent {
  return NotificationEventSchema.parse({
    ...input,
    eventId: input.eventId ?? randomUUID(),
  });
}

/**
 * Builds a namespaced, stable idempotency key from parts. Parts are joined
 * with ':' — callers must ensure the parts themselves identify the event
 * (org scoping is applied separately by the service).
 */
export function buildEventId(...parts: Array<string | number>): string {
  return parts.map((p) => String(p)).join(':');
}
