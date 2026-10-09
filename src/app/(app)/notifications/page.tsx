import Link from 'next/link';
import { Settings } from 'lucide-react';
import { requirePagePermission } from '@/lib/authz/page';
import { cn } from 'cn';
import { getNotificationsPageData, type NotificationsTab } from './actions';
import { NotificationsCenter } from '@/components/notifications/NotificationsCenter';

/**
 * /notifications — the notification center. notifications.view.
 *
 * Async Server Component: tabs (All/Unread) and pagination are
 * searchParam-driven server links; the list itself is a client component for
 * optimistic mark read/unread with rollback.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; page?: string }>;
}) {
  await requirePagePermission('notifications.view');
  const params = await searchParams;
  const tab: NotificationsTab = params.tab === 'unread' ? 'unread' : 'all';
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const data = await getNotificationsPageData({ tab, page });

  // The requested page may be past the end (e.g. items were marked read on
  // the Unread tab); clamp the pager display but keep the empty list honest.
  const totalPages = data.totalPages;

  const tabHref = (t: NotificationsTab) =>
    t === 'all' ? '/notifications' : '/notifications?tab=unread';
  const pageHref = (p: number) => {
    const q = new URLSearchParams();
    if (tab === 'unread') q.set('tab', 'unread');
    if (p > 1) q.set('page', String(p));
    const qs = q.toString();
    return qs ? `/notifications?${qs}` : '/notifications';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Assignments, mentions, and updates addressed to you.
          </p>
        </div>
        <Link
          href="/settings/notifications"
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-ink-muted hover:bg-cream-dark"
        >
          <Settings className="h-4 w-4" aria-hidden />
          Notification settings
        </Link>
      </div>

      <nav aria-label="Notification filters">
        <ul className="inline-flex items-center gap-1 rounded-lg bg-muted p-1">
          {(['all', 'unread'] as const).map((t) => (
            <li key={t}>
              <Link
                href={tabHref(t)}
                aria-current={tab === t ? 'page' : undefined}
                className={cn(
                  'block rounded-md px-3 py-1.5 text-sm capitalize',
                  tab === t
                    ? 'bg-surface font-medium text-ink shadow-sm'
                    : 'text-ink-muted hover:text-ink',
                )}
              >
                {t}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {/* Reset optimistic state whenever the tab or page changes. */}
      <NotificationsCenter
        key={`${tab}-${page}`}
        initial={data.notifications}
        unreadTotal={
          tab === 'unread' ? data.total : data.notifications.filter((n) => n.readAt === null).length
        }
      />

      {totalPages > 1 && (
        <nav aria-label="Notification pages" className="flex items-center justify-center gap-2">
          <Link
            href={pageHref(Math.max(1, page - 1))}
            aria-disabled={page <= 1}
            className={cn(
              'rounded-md border border-line px-3 py-1.5 text-sm',
              page <= 1 ? 'pointer-events-none opacity-50' : 'hover:bg-cream-dark',
            )}
          >
            Previous
          </Link>
          <span className="text-sm text-ink-muted" aria-live="polite">
            Page {page} of {totalPages}
          </span>
          <Link
            href={pageHref(Math.min(totalPages, page + 1))}
            aria-disabled={page >= totalPages}
            className={cn(
              'rounded-md border border-line px-3 py-1.5 text-sm',
              page >= totalPages ? 'pointer-events-none opacity-50' : 'hover:bg-cream-dark',
            )}
          >
            Next
          </Link>
        </nav>
      )}
    </div>
  );
}
