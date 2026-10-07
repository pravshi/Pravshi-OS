'use client';

/**
 * Phase 8 — Notification center list (Workstream E).
 *
 * Interactive list for /notifications. Receives the server-resolved page as
 * props (keyed by tab+page so state resets on navigation) and applies
 * optimistic mark read/unread / mark-all-read with rollback on error.
 *
 * Security: the rows rendered are the caller's own (server-enforced); links
 * are accessibility-verified server-side (resolve-links.ts) — `link: null`
 * renders an "unavailable" state, never a guessed URL.
 */
import { useState } from 'react';
import Link from 'next/link';
import { CheckCheck, MailOpen } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/state/empty-state';
import { cn } from 'cn';
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
  markNotificationUnreadAction,
} from '@/app/(app)/notifications/actions';
import {
  EVENT_TYPE_META,
  formatRelativeTime,
  type NotificationWithLink,
} from './notifications-view';
import { EventTypeIcon } from './EventTypeIcon';

export function NotificationsCenter({
  initial,
  unreadTotal,
}: {
  initial: NotificationWithLink[];
  /** Unread count across all pages (for the toolbar). */
  unreadTotal: number;
}) {
  const [items, setItems] = useState(initial);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [markingAll, setMarkingAll] = useState(false);

  const setItemRead = (id: string, readAt: string | null) =>
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, readAt } : n)));

  const toggleRead = async (id: string, currentlyUnread: boolean) => {
    if (pending.has(id)) return;
    setPending((p) => new Set(p).add(id));
    // Optimistic flip.
    setItemRead(id, currentlyUnread ? new Date().toISOString() : null);
    try {
      if (currentlyUnread) {
        await markNotificationReadAction(id);
      } else {
        await markNotificationUnreadAction(id);
      }
    } catch {
      // Rollback: restore the previous read state.
      setItemRead(id, currentlyUnread ? null : new Date().toISOString());
      toast.error(currentlyUnread ? 'Could not mark as read' : 'Could not mark as unread', {
        description: 'Please try again.',
      });
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(id);
        return next;
      });
    }
  };

  const markAllRead = async () => {
    if (markingAll) return;
    setMarkingAll(true);
    const previous = items;
    setItems((prev) =>
      prev.map((n) => (n.readAt === null ? { ...n, readAt: new Date().toISOString() } : n)),
    );
    try {
      await markAllNotificationsReadAction();
      toast.success('All notifications marked as read');
    } catch {
      setItems(previous); // rollback
      toast.error('Could not mark all as read', { description: 'Please try again.' });
    } finally {
      setMarkingAll(false);
    }
  };

  const unreadOnPage = items.filter((n) => n.readAt === null).length;

  if (items.length === 0) {
    return (
      <EmptyState
        title="No notifications"
        description="You’re all caught up. New assignments, mentions, and updates will show up here."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-ink-muted" aria-live="polite">
          {unreadOnPage > 0
            ? `${unreadOnPage} unread on this page`
            : unreadTotal > 0
              ? 'All read on this page'
              : 'Nothing unread'}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={markAllRead}
          disabled={markingAll || unreadOnPage === 0}
        >
          <CheckCheck className="mr-2 h-4 w-4" aria-hidden />
          Mark all as read
        </Button>
      </div>

      <ul className="divide-y divide-rule overflow-hidden rounded-lg border border-line bg-surface">
        {items.map((n) => {
          const unread = n.readAt === null;
          const busy = pending.has(n.id);
          return (
            <li
              key={n.id}
              className={cn('flex items-start gap-3 px-4 py-3', unread && 'bg-brand-soft/40')}
            >
              <EventTypeIcon type={n.type} className="mt-1 text-ink-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <p className={cn('text-xs font-medium', unread ? 'text-ink' : 'text-ink-muted')}>
                    {EVENT_TYPE_META[n.type].label}
                  </p>
                  <time
                    className="shrink-0 text-xs text-ink-muted"
                    dateTime={n.createdAt}
                    title={new Date(n.createdAt).toLocaleString()}
                  >
                    {formatRelativeTime(n.createdAt)}
                  </time>
                </div>
                {/* Text-node rendering only — React escapes titles/bodies (XSS-safe). */}
                <p className={cn('mt-0.5 text-sm', !unread && 'text-ink-muted')}>{n.title}</p>
                {n.body && <p className="mt-0.5 line-clamp-2 text-sm text-ink-muted">{n.body}</p>}
                <div className="mt-1.5 flex items-center gap-3 text-xs">
                  {n.link ? (
                    <Link href={n.link} className="font-medium text-brand hover:underline">
                      View item
                    </Link>
                  ) : n.entityType ? (
                    <span className="italic text-ink-muted">Linked item unavailable</span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void toggleRead(n.id, unread)}
                    disabled={busy}
                    className="inline-flex items-center gap-1 text-ink-muted hover:text-ink disabled:opacity-50"
                  >
                    <MailOpen className="h-3.5 w-3.5" aria-hidden />
                    {unread ? 'Mark as read' : 'Mark as unread'}
                  </button>
                </div>
              </div>
              {unread && (
                <span
                  aria-label="Unread"
                  className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand"
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
