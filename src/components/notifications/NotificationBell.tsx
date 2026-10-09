'use client';

/**
 * Phase 8 — Notification bell (Workstream E).
 *
 * Header right cluster, before ThemeToggle (contract §16.9). Client-component
 * leaf: polls GET /api/notifications/unread-count every 30s (no SSE exists;
 * see §16.9) and opens a dropdown preview of the 5 newest unread
 * notifications (via getBellPreviewAction — links are accessibility-verified
 * server-side; see resolve-links.ts).
 *
 * Renders the app's <Toaster /> once: the bell is mounted in the app header
 * on every (app) page, so all notification UI (bell, center, preferences)
 * shares it — no other notification component renders its own Toaster.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bell, BellRing, CheckCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Toaster } from '@/components/ui/sonner';
import { cn } from 'cn';
import {
  getBellPreviewAction,
  markAllNotificationsReadAction,
} from '@/app/(app)/notifications/actions';
import {
  EVENT_TYPE_META,
  formatRelativeTime,
  type NotificationWithLink,
} from './notifications-view';
import { EventTypeIcon } from './EventTypeIcon';

/** §16.9: 30s unread polling. No SSE/websocket exists; document if this changes. */
const POLL_INTERVAL_MS = 30_000;
const PREVIEW_LIMIT = 5;

export function NotificationBell() {
  const [unreadCount, setUnreadCount] = useState(0);
  const [preview, setPreview] = useState<NotificationWithLink[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const mounted = useRef(true);

  const refreshCount = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications/unread-count', { cache: 'no-store' });
      if (!res.ok) return; // non-critical: keep the last known count
      const data = (await res.json()) as { unreadCount?: unknown };
      if (typeof data.unreadCount === 'number' && mounted.current) {
        setUnreadCount(data.unreadCount);
      }
    } catch {
      // Network blip: keep the last known count; the next poll retries.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refreshCount();
    const timer = setInterval(() => void refreshCount(), POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refreshCount]);

  const loadPreview = useCallback(async () => {
    setPreviewLoading(true);
    try {
      const { notifications, unreadTotal } = await getBellPreviewAction();
      if (!mounted.current) return;
      setPreview(notifications.slice(0, PREVIEW_LIMIT));
      setUnreadCount(unreadTotal);
    } catch {
      if (mounted.current)
        toast.error('Could not load notifications', {
          description: 'Please try again.',
        });
    } finally {
      if (mounted.current) setPreviewLoading(false);
    }
  }, []);

  const handleMarkAllRead = useCallback(async () => {
    if (markingAll) return;
    setMarkingAll(true);
    // Optimistic: the bell is a hint, so clearing immediately is safe;
    // the center page revalidates from the server on next visit.
    const previousCount = unreadCount;
    const previousPreview = preview;
    setUnreadCount(0);
    setPreview((p) => (p ? p.map((n) => ({ ...n, readAt: new Date().toISOString() })) : p));
    try {
      const { updated } = await markAllNotificationsReadAction();
      if (updated === 0) {
        // Nothing was unread — restore is unnecessary; counts already agree.
      }
    } catch {
      if (mounted.current) {
        setUnreadCount(previousCount);
        setPreview(previousPreview);
        toast.error('Could not mark all as read', { description: 'Please try again.' });
      }
    } finally {
      if (mounted.current) setMarkingAll(false);
    }
  }, [markingAll, preview, unreadCount]);

  const badgeLabel = unreadCount > 99 ? '99+' : String(unreadCount);

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) void loadPreview();
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label={
                unreadCount > 0
                  ? `Notifications, ${unreadCount} unread`
                  : 'Notifications, no unread'
              }
              className="relative"
            >
              {unreadCount > 0 ? (
                <BellRing className="h-4 w-4" aria-hidden />
              ) : (
                <Bell className="h-4 w-4" aria-hidden />
              )}
              {unreadCount > 0 && (
                <span
                  aria-hidden
                  className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
                >
                  {badgeLabel}
                </span>
              )}
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuLabel className="flex items-center justify-between">
            <span>Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                disabled={markingAll}
                className="inline-flex items-center gap-1 text-xs font-normal text-ink-muted hover:text-ink disabled:opacity-50"
              >
                <CheckCheck className="h-3.5 w-3.5" aria-hidden />
                Mark all read
              </button>
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <div className="max-h-80 overflow-y-auto">
            {previewLoading && preview === null ? (
              <p className="px-3 py-6 text-center text-sm text-ink-muted">Loading…</p>
            ) : preview !== null && preview.length > 0 ? (
              <ul>
                {preview.map((n) => (
                  <li key={n.id}>
                    <BellPreviewRow notification={n} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-6 text-center text-sm text-ink-muted">You’re all caught up.</p>
            )}
          </div>
          <DropdownMenuSeparator />
          <Link
            href="/notifications"
            className="block px-3 py-2 text-center text-sm font-medium text-ink hover:bg-brand-soft"
          >
            View all notifications
          </Link>
        </DropdownMenuContent>
      </DropdownMenu>
      <Toaster />
    </>
  );
}

function BellPreviewRow({ notification: n }: { notification: NotificationWithLink }) {
  const unread = n.readAt === null;
  const body = (
    <span className="flex items-start gap-2.5 px-3 py-2.5">
      <EventTypeIcon type={n.type} className="mt-0.5 text-ink-muted" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn('truncate text-xs font-medium', unread && 'text-ink')}>
            {EVENT_TYPE_META[n.type].label}
          </span>
          <span className="shrink-0 text-[11px] text-ink-muted">
            {formatRelativeTime(n.createdAt)}
          </span>
        </span>
        {/* Titles/bodies render as text nodes — React escapes them (XSS-safe). */}
        <span className={cn('mt-0.5 line-clamp-2 block text-sm', !unread && 'text-ink-muted')}>
          {n.title}
        </span>
        {n.entityType && !n.link && (
          <span className="mt-0.5 block text-xs italic text-ink-muted">
            Linked item unavailable
          </span>
        )}
      </span>
      {unread && (
        <span aria-label="Unread" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" />
      )}
    </span>
  );

  return n.link ? (
    <Link href={n.link} className="block hover:bg-brand-soft">
      {body}
    </Link>
  ) : (
    <div className="cursor-default">{body}</div>
  );
}
