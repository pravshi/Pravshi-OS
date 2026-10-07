/**
 * Phase 8 — Notifications: shared types (Workstream C).
 *
 * [AGENT]            Notifications Backend Engineer (Workstream C)
 * [CONTEXT]          Phase 8 Search & Notifications, Pravshi OS.
 * [DECISION]         Implements the Lead Architect contract review
 *                    (phase8-contract-review.md §§16.3–16.7), which supersedes
 *                    the draft audit.
 * [CONTRACT]         Notification (§16.3), NotificationEvent (§16.4),
 *                    NotificationPreference (§16.5), permissions (§16.6),
 *                    API routes (§16.7).
 * [FILE OWNERSHIP]   OWN src/lib/notifications/. MUST NOT touch search code,
 *                    frontend, or migrations.
 *
 * Column mapping (migration 0052, Workstream A — this module implements
 * against the approved contract; the columns must exist at runtime):
 *   id               → id            recipientUserId → person_id
 *   orgId            → org_id        type          → type (new)
 *   title            → title         body          → message
 *   readAt           → read_at       createdAt     → created_at
 *   metadata         → data (jsonb)  eventId       → event_id (new, nullable)
 * entityType/entityId ride inside `data` (no dedicated columns per §16.4).
 */
import { z } from 'zod';

/** The 11 notification event types (§16.4, binding). */
export const NOTIFICATION_EVENT_TYPES = [
  'TASK_ASSIGNED',
  'TASK_DUE',
  'TASK_OVERDUE',
  'PROJECT_UPDATED',
  'DEAL_UPDATED',
  'DEAL_STAGE_CHANGED',
  'WORKFLOW_SUCCEEDED',
  'WORKFLOW_FAILED',
  'AUTOMATION_FAILED',
  'MENTION',
  'SYSTEM_ALERT',
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

/**
 * INTENTIONAL V1 BEHAVIOR — WORKFLOW_FAILED / WORKFLOW_SUCCEEDED /
 * AUTOMATION_FAILED are NOT auto-emitted by the workflow engine.
 *
 * Phase 8 QA (Workstream F) flagged this as a scenario gap; the decision
 * (integration review, 2026-10-07) is to document it as intended, not to
 * change it. These event types fire only when a workflow definition
 * explicitly contains a `send_notification` action — the workflow runner
 * itself stays silent. Auto-emission (e.g. notifying a workflow's owner on
 * every failure) is out of V1 scope: it needs a product decision on
 * recipients, preferences interaction, and noise/volume guarantees.
 */
export const NotificationEventTypeSchema = z.enum(NOTIFICATION_EVENT_TYPES);

export const NOTIFICATION_CHANNELS = ['in_app', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);

/**
 * A notification event to be delivered (§16.4). `eventId` is the idempotency
 * key: re-emitting the same eventId for the same org returns the existing
 * notification instead of creating a duplicate.
 */
export interface NotificationEvent {
  /** UUID idempotency key → event_id column. */
  eventId: string;
  type: NotificationEventType;
  orgId: string;
  /** Recipient person id → person_id column. */
  recipientUserId: string;
  title: string;
  /** → message column. */
  body: string;
  entityType?: string;
  entityId?: string;
  /** Optional deep-link path (e.g. `/tasks/<id>`); carried in data. */
  link?: string;
  /** → data column (merged under the reserved keys above). */
  metadata?: Record<string, unknown>;
}

export const NotificationEventSchema = z.strictObject({
  eventId: z.string().uuid(),
  type: NotificationEventTypeSchema,
  orgId: z.string().uuid(),
  recipientUserId: z.string().uuid(),
  title: z.string().trim().min(1, 'title is required').max(200),
  body: z.string().trim().min(1, 'body is required').max(2000),
  entityType: z.string().trim().min(1).max(128).optional(),
  entityId: z.string().trim().min(1).max(256).optional(),
  link: z.string().trim().min(1).max(2048).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ValidatedNotificationEvent = z.infer<typeof NotificationEventSchema>;

/** The API-facing notification shape (§16.3). */
export interface Notification {
  id: string;
  orgId: string;
  /** → person_id column. */
  recipientUserId: string;
  /** → type column (new in 0052). */
  type: NotificationEventType;
  title: string;
  /** → message column. */
  body: string;
  entityType?: string;
  entityId?: string;
  readAt: string | null;
  createdAt: string;
  /** → data column. */
  metadata?: Record<string, unknown>;
}

/** A stored delivery preference (§16.5). `'*'` eventType is the wildcard. */
export interface NotificationPreference {
  userId: string;
  orgId: string;
  eventType: NotificationEventType | '*';
  channel: NotificationChannel;
  enabled: boolean;
}

/** Raw row shape returned by the service's SQL (snake_case, like the table). */
export type NotificationRow = {
  id: string;
  org_id: string;
  person_id: string | null;
  /** Present after migration 0052; null before. */
  type: string | null;
  title: string;
  message: string;
  /** Present after migration 0052; null before. */
  event_id: string | null;
  data: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
};

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(NOTIFICATION_EVENT_TYPES);

/**
 * Maps a DB row to the API-facing Notification. `type` falls back to
 * `data.type` (pre-0052 rows written through the legacy insert path) and then
 * to SYSTEM_ALERT (the migration's own backfill default). Unknown type strings
 * are coerced to SYSTEM_ALERT rather than leaking an uncontracted value.
 */
export function mapNotificationRow(row: NotificationRow): Notification {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const rawType = row.type ?? (typeof data['type'] === 'string' ? (data['type'] as string) : null);
  const type: NotificationEventType =
    rawType !== null && KNOWN_EVENT_TYPES.has(rawType)
      ? (rawType as NotificationEventType)
      : 'SYSTEM_ALERT';
  const entityType =
    typeof data['entityType'] === 'string' ? (data['entityType'] as string) : undefined;
  const entityId = typeof data['entityId'] === 'string' ? (data['entityId'] as string) : undefined;
  return {
    id: row.id,
    orgId: row.org_id,
    recipientUserId: row.person_id ?? '',
    type,
    title: row.title,
    body: row.message,
    ...(entityType !== undefined ? { entityType } : {}),
    ...(entityId !== undefined ? { entityId } : {}),
    readAt: row.read_at,
    createdAt: row.created_at,
    metadata: data,
  };
}
