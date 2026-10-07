/**
 * Phase 8 — Notifications: delivery service (Workstream C).
 *
 * [CONTRACT] §16.3/§16.4/§16.7: create (via the Phase 6 'notification' job
 *            type, delivered through notifications_insert), list, unread
 *            count, mark read/unread/all-read. Every read/write constrains
 *            person_id = caller (own-rows-only); org comes from auth.ctx.
 * [PERMISSIONS] Callers go through withPermission('notifications.view') /
 *            ('notifications.preferences.manage') at the routes. Enqueueing
 *            jobs runs under the CALLER's authority (D2 — no synthetic
 *            actor): enqueueJob requires 'jobs.create', so a caller without
 *            it gets FORBIDDEN rather than a silent privilege escalation.
 * [IDEMPOTENCY] When eventId is supplied, (org_id, event_id) is checked
 *            before enqueue and the job carries dedupKey
 *            `notification:<eventId>` — a redelivered event returns the
 *            existing notification instead of duplicating.
 * [EMAIL]    The email channel reuses Phase 6 'email' jobs, gated by the
 *            recipient's preferences. The provider is NOT wired (Phase 6
 *            left sendEmailViaProvider fail-closed): with no provider
 *            configured the email is skipped gracefully and reported — no
 *            doomed job is enqueued. Wire EMAIL_PROVIDER /
 *            EMAIL_PROVIDER_API_KEY to enable delivery.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '@/env';
import { withAuthorizedDb } from '../db/authorized';
import { AuthorizationError } from '../authz/errors';
import type { Authorization } from '../authz/require-permission';
import { enqueueJob } from '../jobs/queue';
import {
  mapNotificationRow,
  type Notification,
  type NotificationRow,
  type ValidatedNotificationEvent,
} from './types';
import { makeNotificationEvent, type NewNotificationEventInput } from './events';
import { isChannelEnabled } from './preferences';

export const NOTIFICATIONS_LIST_LIMIT_DEFAULT = 20;
export const NOTIFICATIONS_LIST_LIMIT_MAX = 50;

function requirePersonId(auth: Authorization): string {
  const personId = auth.ctx.personId;
  if (personId === null || personId === undefined || personId === '') {
    throw new Error('INVALID_REQUEST: notifications require a person identity');
  }
  return personId;
}

function notFoundError(): AuthorizationError {
  // NOT_FOUND deliberately covers missing / out-of-scope / another tenant —
  // answering "exists but not yours" would leak cross-user existence.
  return new AuthorizationError('NOT_FOUND', {
    requestId: randomUUID(),
    reason: 'TARGET_NOT_VISIBLE',
  });
}

export type CreateNotificationInput = Omit<NewNotificationEventInput, 'orgId'>;

export type EmailSkipReason =
  'duplicate_event' | 'disabled_by_preference' | 'provider_unconfigured' | 'no_email_on_file';

export interface EmailDeliveryResult {
  status: 'queued' | 'skipped';
  jobId?: string;
  skipReason?: EmailSkipReason;
}

export interface CreateNotificationResult {
  status: 'queued' | 'duplicate' | 'skipped';
  /** Present when an in-app job was enqueued. */
  jobId?: string;
  /** Present when status is 'duplicate'. */
  notification?: Notification;
  /** True when the in-app channel is disabled by preference (nothing enqueued). */
  inAppSkipped?: boolean;
  email: EmailDeliveryResult;
}

/**
 * Pure: builds the Phase 6 'notification' job payload for an event. `type`
 * and `eventId` ride inside `data` — the job handler (handlers.ts) forwards
 * them to the type/event_id columns (migration 0052); entityType/entityId
 * ride in data the same way (no dedicated columns per §16.4).
 */
export function buildNotificationJobPayload(
  event: ValidatedNotificationEvent,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    ...(event.metadata ?? {}),
    type: event.type,
    eventId: event.eventId,
  };
  if (event.entityType !== undefined) data['entityType'] = event.entityType;
  if (event.entityId !== undefined) data['entityId'] = event.entityId;
  if (event.link !== undefined) data['link'] = event.link;
  return {
    personId: event.recipientUserId,
    title: event.title,
    message: event.body,
    data,
  };
}

/** The recipient must be an active person in the caller's org (defense in depth; the job handler re-checks). */
async function assertRecipientInOrg(
  auth: Authorization,
  orgId: string,
  personId: string,
): Promise<void> {
  const rows = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{ id: string }>(sql`
      select id from public.people
      where id = ${personId}::uuid
        and org_id = ${orgId}::uuid
        and deleted_at is null
      limit 1
    `),
  );
  if (rows.rows.length === 0) {
    throw new Error(
      'INVALID_REQUEST: notification recipient is not an active person in this organization',
    );
  }
}

/** Idempotency probe: the existing notification for (org_id, event_id), if any. */
async function findByEventId(
  auth: Authorization,
  orgId: string,
  eventId: string,
): Promise<Notification | null> {
  const rows = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<NotificationRow>(sql`
      select id, org_id, person_id, type, title, message, event_id, data, read_at, created_at
      from public.notifications
      where org_id = ${orgId}::uuid
        and event_id = ${eventId}
      limit 1
    `),
  );
  const row = rows.rows[0];
  return row === undefined ? null : mapNotificationRow(row);
}

/** Recipient's deliverable address: work_email preferred, personal_email fallback. Never logged. */
async function resolveRecipientEmail(
  auth: Authorization,
  orgId: string,
  personId: string,
): Promise<string | null> {
  const rows = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{ work_email: string | null; personal_email: string | null }>(sql`
      select work_email, personal_email from public.people
      where id = ${personId}::uuid
        and org_id = ${orgId}::uuid
        and deleted_at is null
      limit 1
    `),
  );
  const row = rows.rows[0];
  if (row === undefined) return null;
  return row.work_email ?? row.personal_email ?? null;
}

async function maybeEnqueueEmail(
  auth: Authorization,
  orgId: string,
  event: ValidatedNotificationEvent,
): Promise<EmailDeliveryResult> {
  const enabled = await isChannelEnabled(auth, event.recipientUserId, event.type, 'email');
  if (!enabled) {
    return { status: 'skipped', skipReason: 'disabled_by_preference' };
  }
  if (env.EMAIL_PROVIDER === undefined || env.EMAIL_PROVIDER_API_KEY === undefined) {
    // Fail gracefully: the provider is unwired (Phase 6 fail-closed), so
    // enqueueing would only produce a guaranteed dead-letter. The preference
    // is honored; delivery starts working the moment the provider is wired.
    console.warn(
      '[notifications] email channel enabled for event ' +
        `${event.type} but EMAIL_PROVIDER/EMAIL_PROVIDER_API_KEY is unset; ` +
        'skipping email enqueue (no doomed job created)',
    );
    return { status: 'skipped', skipReason: 'provider_unconfigured' };
  }
  const address = await resolveRecipientEmail(auth, orgId, event.recipientUserId);
  if (address === null) {
    return { status: 'skipped', skipReason: 'no_email_on_file' };
  }
  const job = await enqueueJob(auth, {
    type: 'email',
    payload: {
      to: [address],
      subject: event.title,
      text: event.body,
    },
    dedupKey: `notification-email:${event.eventId}`,
  });
  return { status: 'queued', jobId: job.id };
}

/**
 * Creates a notification for an event: idempotency check → in-app preference
 * gate → enqueue 'notification' job (dedupKey `notification:<eventId>`) →
 * email preference gate → maybe enqueue 'email' job.
 *
 * Runs under the caller's authority (D2): enqueueJob requires 'jobs.create'.
 * Throws ZodError on invalid input, INVALID_REQUEST when the recipient is
 * not in-org, AuthorizationError FORBIDDEN when the caller may not enqueue.
 */
export async function createNotification(
  auth: Authorization,
  input: CreateNotificationInput,
): Promise<CreateNotificationResult> {
  requirePersonId(auth);
  const orgId = auth.ctx.orgId;
  const event = makeNotificationEvent({ ...input, orgId });

  await assertRecipientInOrg(auth, orgId, event.recipientUserId);

  const existing = await findByEventId(auth, orgId, event.eventId);
  if (existing !== null) {
    return {
      status: 'duplicate',
      notification: existing,
      email: { status: 'skipped', skipReason: 'duplicate_event' },
    };
  }

  const inAppEnabled = await isChannelEnabled(auth, event.recipientUserId, event.type, 'in_app');
  let jobId: string | undefined;
  if (inAppEnabled) {
    const job = await enqueueJob(auth, {
      type: 'notification',
      payload: buildNotificationJobPayload(event),
      dedupKey: `notification:${event.eventId}`,
    });
    jobId = job.id;
  }

  const email = await maybeEnqueueEmail(auth, orgId, event);

  return {
    status: inAppEnabled ? 'queued' : 'skipped',
    ...(jobId !== undefined ? { jobId } : {}),
    ...(inAppEnabled ? {} : { inAppSkipped: true }),
    email,
  };
}

export interface ListNotificationsOptions {
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
}

export interface ListNotificationsResult {
  notifications: Notification[];
  total: number;
  limit: number;
  offset: number;
}

/** Own notifications, newest first. Limits are server-enforced (default 20, max 50). */
export async function listNotifications(
  auth: Authorization,
  options: ListNotificationsOptions = {},
): Promise<ListNotificationsResult> {
  const personId = requirePersonId(auth);
  const orgId = auth.ctx.orgId;
  const limit = Math.min(
    Math.max(options.limit ?? NOTIFICATIONS_LIST_LIMIT_DEFAULT, 1),
    NOTIFICATIONS_LIST_LIMIT_MAX,
  );
  const offset = Math.max(options.offset ?? 0, 0);
  const unreadOnly = options.unreadOnly ?? false;
  const unreadFilter = unreadOnly ? sql`and read_at is null` : sql``;

  const rows = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<NotificationRow>(sql`
      select id, org_id, person_id, type, title, message, event_id, data, read_at, created_at
      from public.notifications
      where org_id = ${orgId}::uuid
        and person_id = ${personId}::uuid
        ${unreadFilter}
      order by created_at desc
      limit ${limit} offset ${offset}
    `),
  );
  const counted = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{ count: string }>(sql`
      select count(*) as count
      from public.notifications
      where org_id = ${orgId}::uuid
        and person_id = ${personId}::uuid
        ${unreadFilter}
    `),
  );
  return {
    notifications: rows.rows.map(mapNotificationRow),
    total: Number(counted.rows[0]?.count ?? 0),
    limit,
    offset,
  };
}

/**
 * Unread count for the bell badge. Hits the partial index on
 * (org_id, person_id, type) WHERE read_at IS NULL (migration 0052).
 */
export async function getUnreadCount(auth: Authorization): Promise<number> {
  const personId = requirePersonId(auth);
  const rows = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{ count: string }>(sql`
      select count(*) as count
      from public.notifications
      where org_id = ${auth.ctx.orgId}::uuid
        and person_id = ${personId}::uuid
        and read_at is null
    `),
  );
  return Number(rows.rows[0]?.count ?? 0);
}

const uuidSchema = z.string().uuid();

/** Marks one OWN notification read/unread. Another user's id → NOT_FOUND (no leak). */
async function setNotificationRead(
  auth: Authorization,
  id: string,
  read: boolean,
): Promise<Notification> {
  const personId = requirePersonId(auth);
  const orgId = auth.ctx.orgId;
  const parsedId = uuidSchema.parse(id);
  const rows = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<NotificationRow>(sql`
      update public.notifications
      set read_at = case when ${read} then now() else null end
      where id = ${parsedId}::uuid
        and org_id = ${orgId}::uuid
        and person_id = ${personId}::uuid
      returning id, org_id, person_id, type, title, message, event_id, data, read_at, created_at
    `),
  );
  const row = rows.rows[0];
  if (row === undefined) throw notFoundError();
  return mapNotificationRow(row);
}

export async function markNotificationRead(auth: Authorization, id: string): Promise<Notification> {
  return setNotificationRead(auth, id, true);
}

export async function markNotificationUnread(
  auth: Authorization,
  id: string,
): Promise<Notification> {
  return setNotificationRead(auth, id, false);
}

/** Marks all OWN unread notifications as read. Returns the affected count. */
export async function markAllNotificationsRead(auth: Authorization): Promise<{ updated: number }> {
  const personId = requirePersonId(auth);
  const rows = await withAuthorizedDb(auth.ctx, (tx) =>
    tx.execute<{ id: string }>(sql`
      update public.notifications
      set read_at = now()
      where org_id = ${auth.ctx.orgId}::uuid
        and person_id = ${personId}::uuid
        and read_at is null
      returning id
    `),
  );
  return { updated: rows.rows.length };
}
