'use server';

/**
 * Phase 8 — Notifications center + bell: Server Actions (Workstream E).
 *
 * Authorize first, always: every action calls requirePermission() as its
 * FIRST statement. The mutations operate on the caller's OWN notifications
 * only (the service layer 404s on another user's id — no existence leak).
 */
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz/require-permission';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationUnread,
  NOTIFICATIONS_LIST_LIMIT_DEFAULT,
} from '@/lib/notifications/service';
import { resolveNotificationLinks } from './resolve-links';

const CENTER_PAGE_SIZE = NOTIFICATIONS_LIST_LIMIT_DEFAULT;
export type NotificationsTab = 'all' | 'unread';

const idSchema = z.string().uuid();

/** Page of the caller's notifications, with safe-navigation links resolved. */
export async function getNotificationsPageData(options: { tab: NotificationsTab; page: number }) {
  const auth = await requirePermission(await headers(), { permission: 'notifications.view' });
  const page = Number.isInteger(options.page) && options.page >= 1 ? options.page : 1;
  const result = await listNotifications(auth, {
    limit: CENTER_PAGE_SIZE,
    offset: (page - 1) * CENTER_PAGE_SIZE,
    unreadOnly: options.tab === 'unread',
  });
  const notifications = await resolveNotificationLinks(auth, result.notifications);
  return {
    tab: options.tab,
    page,
    limit: result.limit,
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / result.limit)),
    notifications,
  };
}

/** Bell dropdown preview: the 5 newest unread + the unread total for the badge. */
export async function getBellPreviewAction() {
  const auth = await requirePermission(await headers(), { permission: 'notifications.view' });
  const result = await listNotifications(auth, {
    limit: 5,
    offset: 0,
    unreadOnly: true,
  });
  const notifications = await resolveNotificationLinks(auth, result.notifications);
  return { notifications, unreadTotal: result.total };
}

/** Optimistic single mark-as-read (bell + center). Returns the updated row. */
export async function markNotificationReadAction(id: string) {
  const auth = await requirePermission(await headers(), { permission: 'notifications.view' });
  const notification = await markNotificationRead(auth, idSchema.parse(id));
  revalidatePath('/notifications');
  const [resolved] = await resolveNotificationLinks(auth, [notification]);
  return resolved;
}

/** Optimistic single mark-as-unread. Returns the updated row. */
export async function markNotificationUnreadAction(id: string) {
  const auth = await requirePermission(await headers(), { permission: 'notifications.view' });
  const notification = await markNotificationUnread(auth, idSchema.parse(id));
  revalidatePath('/notifications');
  const [resolved] = await resolveNotificationLinks(auth, [notification]);
  return resolved;
}

/** Mark every own unread notification as read. Returns the updated count. */
export async function markAllNotificationsReadAction() {
  const auth = await requirePermission(await headers(), { permission: 'notifications.view' });
  const result = await markAllNotificationsRead(auth);
  revalidatePath('/notifications');
  return result;
}
